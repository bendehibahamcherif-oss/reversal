"""
Training pipeline — ML Signal Engine (intraday, P1 feature set).

Usage:
    python server/ai/training/train_pipeline.py \\
        --data  server/ai/datasets/snapshot.parquet \\
        --output server/ai/models \\
        --horizon 20 \\
        --up-threshold 0.005 \\
        --down-threshold -0.005

Output (in --output dir):
    logistic_baseline.pkl
    xgb_champion.json
    lgb_challenger.txt
    model_metadata.json
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import TimeSeriesSplit
from xgboost import XGBClassifier

# ── Local imports (resolve relative to this file so it can be run from root) ──
_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))

from dataset_utils import (
    compute_dataframe_hash,
    compute_schema_hash,
    save_models,
    temporal_train_val_test_split,
    time_series_cv,
)
from feature_builder import ALL_FEATURE_NAMES, build_features
from label_builder import build_p1_labels
from metrics import evaluate_classification_metrics, format_metrics_summary


# ── Constants ──────────────────────────────────────────────────────────────────

# P1 label scheme: SHORT=0, NEUTRAL=1, LONG=2
LABEL_CLASSES   = ["SHORT", "NEUTRAL", "LONG"]
LABEL_CLASS_MAP = {cls: idx for idx, cls in enumerate(LABEL_CLASSES)}
INV_LABEL_MAP   = {str(idx): cls for idx, cls in enumerate(LABEL_CLASSES)}

FEATURE_VERSION      = "p1_v1"
LABEL_SPEC_VERSION   = "ls_v1"


# ── Main pipeline ──────────────────────────────────────────────────────────────

def train_pipeline(
    data_path: str,
    output_dir: str,
    horizon: int      = 20,
    up_threshold: float   = 0.005,
    down_threshold: float = -0.005,
    train_ratio: float    = 0.70,
    val_ratio: float      = 0.15,
    cv_splits: int        = 5,
    seed: int             = 42,
) -> dict:
    """
    Run the full training pipeline and persist artefacts.

    Returns the metadata dict (also written to model_metadata.json).
    """
    print(f"[train] Loading data from {data_path!r}")
    df = pd.read_parquet(data_path)
    df = df.sort_index()
    dataset_hash = compute_dataframe_hash(df)
    print(f"[train] Loaded {len(df)} rows | dataset_hash={dataset_hash[:12]}")

    # ── Labels (P1 scheme: SHORT=0, NEUTRAL=1, LONG=2) ───────────────────────
    print(f"[train] Building P1 labels (horizon={horizon}, tau_up={up_threshold}, tau_down={down_threshold})")
    y_raw = build_p1_labels(
        df,
        horizon=horizon,
        tau_up=up_threshold,
        tau_down=down_threshold,
    )
    valid_label_mask = y_raw.notna()
    df     = df.loc[valid_label_mask]
    y_raw  = y_raw.loc[valid_label_mask]
    y_int  = y_raw.astype(int).to_numpy()
    y      = np.array([LABEL_CLASSES[i] for i in y_int])
    label_dist = {LABEL_CLASSES[int(k)]: int(v) for k, v in
                  zip(*np.unique(y_int, return_counts=True))}
    print(f"[train] Label distribution: {label_dist}")

    # ── Features (30-feature P1 set) ──────────────────────────────────────────
    print("[train] Computing P1 features (30 features)")
    X_df = build_features(df)
    valid_mask = X_df.notna().all(axis=1)
    X_df = X_df[valid_mask]
    df   = df.loc[X_df.index]
    y_int = y_int[valid_mask.to_numpy()]
    y     = y[valid_mask.to_numpy()]

    feature_names       = list(X_df.columns)
    feature_schema_hash = compute_schema_hash(feature_names)
    print(f"[train] Features: {len(feature_names)} | schema_hash={feature_schema_hash[:12]}")

    X = X_df.to_numpy(dtype=float)

    # ── Temporal split ────────────────────────────────────────────────────────
    n = len(df)
    train_end = int(n * train_ratio)
    val_end   = int(n * (train_ratio + val_ratio))

    X_train, y_train, y_int_train = X[:train_end],  y[:train_end],  y_int[:train_end]
    X_val,   y_val,   y_int_val   = X[train_end:val_end], y[train_end:val_end], y_int[train_end:val_end]
    X_test,  y_test,  y_int_test  = X[val_end:],    y[val_end:],    y_int[val_end:]

    print(f"[train] Split: train={len(X_train)}, val={len(X_val)}, test={len(X_test)}")

    # ── Anti-leakage: assert strict chronological order ───────────────────────
    timestamps = df.index
    if len(timestamps) > 1:
        assert timestamps[train_end - 1] < timestamps[train_end], "Train/val boundary overlap"
        assert timestamps[val_end   - 1] < timestamps[val_end],   "Val/test boundary overlap"
        assert val_end - train_end >= horizon, \
            f"Val boundary must be at least horizon={horizon} rows after train end"

    # ── Model training ────────────────────────────────────────────────────────
    n_classes = len(LABEL_CLASSES)

    lr = LogisticRegression(
        max_iter=2000,
        solver="lbfgs",
        multi_class="multinomial",
        C=1.0,
        random_state=seed,
    )
    lr.fit(X_train, y_int_train)

    xgb = XGBClassifier(
        objective="multi:softprob",
        num_class=n_classes,
        n_estimators=400,
        learning_rate=0.05,
        max_depth=4,
        min_child_weight=5,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_lambda=1.0,
        eval_metric="mlogloss",
        early_stopping_rounds=40,
        random_state=seed,
        verbosity=0,
    )
    xgb.fit(
        X_train, y_int_train,
        eval_set=[(X_val, y_int_val)],
        verbose=False,
    )

    lgb = LGBMClassifier(
        objective="multiclass",
        num_class=n_classes,
        n_estimators=400,
        learning_rate=0.05,
        max_depth=4,
        min_child_samples=20,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_lambda=1.0,
        random_state=seed,
        verbose=-1,
    )
    lgb.fit(
        X_train, y_int_train,
        eval_set=[(X_val, y_int_val)],
        callbacks=[],
    )

    models = {"logistic": lr, "xgb": xgb, "lgb": lgb}

    # ── Validation evaluation ─────────────────────────────────────────────────
    def _predict(model, name, X):
        """Return (y_proba, y_pred_str) for any model type."""
        if name == "xgb":
            import xgboost as _xgb
            dm = _xgb.DMatrix(X)
            proba_flat = model.get_booster().predict(dm)
            y_proba = proba_flat.reshape(-1, n_classes)
        else:
            y_proba = model.predict_proba(X)
        y_pred = np.array([LABEL_CLASSES[i] for i in y_proba.argmax(axis=1)])
        return y_proba, y_pred

    val_metrics = {}
    for name, model in models.items():
        y_proba, y_pred = _predict(model, name, X_val)
        y_val_str = np.array([LABEL_CLASSES[i] for i in y_int_val])
        m = evaluate_classification_metrics(
            y_val_str, y_pred, y_proba,
            model_name=name,
            class_labels=LABEL_CLASSES,
        )
        val_metrics[name] = m
        print(f"  val  {format_metrics_summary(m)}")

    # ── Select champion ───────────────────────────────────────────────────────
    best_model_name = max(
        val_metrics,
        key=lambda k: val_metrics[k]["roc_auc"] or 0.0,
    )
    champion = models[best_model_name]
    print(f"[train] Champion: {best_model_name}")

    # ── Test set evaluation ───────────────────────────────────────────────────
    y_proba_test, y_pred_test = _predict(champion, best_model_name, X_test)
    y_test_str = np.array([LABEL_CLASSES[i] for i in y_int_test])

    test_metrics = evaluate_classification_metrics(
        y_test_str, y_pred_test, y_proba_test,
        model_name=best_model_name,
        class_labels=LABEL_CLASSES,
    )
    print(f"  test {format_metrics_summary(test_metrics)}")

    # ── Feature importance (XGBoost gain) ─────────────────────────────────────
    feature_importance = {}
    try:
        scores = xgb.get_booster().get_score(importance_type="gain")
        feature_importance = {feature_names[int(k[1:])]: round(v, 4)
                              for k, v in scores.items()}
    except Exception:
        pass

    # ── Git SHA ───────────────────────────────────────────────────────────────
    git_sha = _get_git_sha()

    # ── Build metadata ────────────────────────────────────────────────────────
    metadata = {
        "feature_version":      FEATURE_VERSION,
        "label_spec_version":   LABEL_SPEC_VERSION,
        "dataset_hash":         dataset_hash,
        "feature_schema_hash":  feature_schema_hash,
        "git_sha":              git_sha,
        "feature_names":        feature_names,
        "label_definition": {
            "horizon":        horizon,
            "up_threshold":   up_threshold,
            "down_threshold": down_threshold,
            "classes":        LABEL_CLASSES,
            "class_map":      LABEL_CLASS_MAP,
        },
        "label_distribution": {k: int(v) for k, v in label_dist.items()},
        "split": {
            "train_ratio": train_ratio,
            "val_ratio":   val_ratio,
            "test_ratio":  round(1 - train_ratio - val_ratio, 4),
            "train_n":     len(X_train),
            "val_n":       len(X_val),
            "test_n":      len(X_test),
        },
        "best_model":          best_model_name,
        "inv_label_map":       INV_LABEL_MAP,
        "validation_metrics":  {k: _strip_arrays(v) for k, v in val_metrics.items()},
        "test_metrics":        _strip_arrays(test_metrics),
        "feature_importance":  feature_importance,
    }

    # ── Save ──────────────────────────────────────────────────────────────────
    save_models(models, metadata, output_dir)
    print(f"[train] Done → {output_dir}")

    return metadata


# ── CLI entry point ────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="ML Signal Engine — training pipeline")
    p.add_argument("--data",           required=True,         help="Path to OHLCV Parquet snapshot")
    p.add_argument("--output",         default="server/ai/models", help="Output directory for models")
    p.add_argument("--symbol",         default="*",           help="Instrument symbol (stored in metadata)")
    p.add_argument("--horizon",        type=int,   default=20)
    p.add_argument("--up-threshold",   type=float, default=0.005)
    p.add_argument("--down-threshold", type=float, default=-0.005)
    p.add_argument("--train-ratio",    type=float, default=0.70)
    p.add_argument("--val-ratio",      type=float, default=0.15)
    p.add_argument("--cv-splits",      type=int,   default=5)
    p.add_argument("--seed",           type=int,   default=42)
    return p


def _get_git_sha() -> str:
    try:
        import subprocess
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return result.stdout.strip() if result.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


def _strip_arrays(d: dict) -> dict:
    """Remove non-serialisable ndarray values from metrics dict for JSON output."""
    import numpy as np
    out = {}
    for k, v in d.items():
        if isinstance(v, np.ndarray):
            out[k] = v.tolist()
        elif isinstance(v, dict):
            out[k] = _strip_arrays(v)
        elif isinstance(v, (np.integer,)):
            out[k] = int(v)
        elif isinstance(v, (np.floating,)):
            out[k] = float(v)
        else:
            out[k] = v
    return out


if __name__ == "__main__":
    args = _build_parser().parse_args()
    train_pipeline(
        data_path      = args.data,
        output_dir     = args.output,
        horizon        = args.horizon,
        up_threshold   = args.up_threshold,
        down_threshold = args.down_threshold,
        train_ratio    = args.train_ratio,
        val_ratio      = args.val_ratio,
        cv_splits      = args.cv_splits,
        seed           = args.seed,
    )
