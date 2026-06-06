#!/usr/bin/env python3
"""Minimal real ML training pipeline for the Intraday Reversal Engine.

The script intentionally prints a single JSON object on its last stdout line so
Node can parse the result reliably. It supports CSV and Parquet snapshots with
at least timestamp, symbol, open, high, low, close, volume.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import traceback
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

REQUIRED_COLUMNS = ["timestamp", "symbol", "open", "high", "low", "close", "volume"]
OPTIONAL_FEATURES = [
    "ret_1", "ret_5", "range_1", "body_pct", "rsi14", "ema9_spread", "ema20_spread",
    "vwap_spread", "dist_poc", "dist_vah", "dist_val", "cvd_slope", "l1_queue_imbalance",
    "footprint_imbalance_count",
]
P1_FEATURES = [
    "ret_1", "ret_5", "ret_20", "range_pct", "body_pct", "upper_wick_pct", "lower_wick_pct",
    "volume_zscore_20", "realized_vol_20", "ema9_spread", "ema20_spread", "vwap_spread",
]
LABEL_MAP = {0: "SHORT", 1: "NEUTRAL", 2: "LONG"}
CURRENT_STAGE = "startup"


class JsonArgparseError(ValueError):
    """Raised instead of argparse exiting with plain stderr and empty stdout."""


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise JsonArgparseError(message)


def set_stage(stage: str) -> None:
    global CURRENT_STAGE
    CURRENT_STAGE = stage


def sanitize_for_json(obj: Any) -> Any:
    if obj is None or isinstance(obj, (str, bool, int)):
        return obj
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, dict):
        return {str(sanitize_for_json(k)): sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [sanitize_for_json(v) for v in obj]
    if hasattr(obj, "isoformat"):
        try:
            return obj.isoformat()
        except Exception:
            pass
    if hasattr(obj, "item"):
        try:
            return sanitize_for_json(obj.item())
        except Exception:
            pass
    if hasattr(obj, "tolist"):
        try:
            return sanitize_for_json(obj.tolist())
        except Exception:
            pass
    return str(obj)


def safe_json_default(value: Any) -> Any:
    return sanitize_for_json(value)


def emit(obj: dict[str, Any], exit_code: int = 0) -> None:
    sanitized = sanitize_for_json(obj)
    print(json.dumps(sanitized, default=safe_json_default, sort_keys=True, allow_nan=False))
    raise SystemExit(exit_code)


# Backward-compatible name used by artifact writers in this module.
json_default = safe_json_default


def quick_row_count(path: Path) -> int | None:
    if path.suffix.lower() != ".csv":
        return None
    with path.open("r", encoding="utf-8", newline="") as fh:
        return max(sum(1 for _ in fh) - 1, 0)


def dependency_imports():
    import importlib.util
    missing = []
    for name in ["pandas", "numpy", "sklearn", "joblib"]:
        if importlib.util.find_spec(name) is None:
            missing.append({"module": name, "error": "module not installed"})
    if missing:
        return None, missing
    return True, []


def dataframe_hash(df) -> str:
    payload = f"{len(df)}|{list(df.columns)}|{df['timestamp'].iloc[0] if len(df) else ''}|{df['timestamp'].iloc[-1] if len(df) else ''}"
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def schema_hash(features: list[str]) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(features, sort_keys=True).encode("utf-8")).hexdigest()


def load_snapshot(path: Path):
    import pandas as pd
    suffix = path.suffix.lower()
    if suffix == ".csv":
        df = pd.read_csv(path)
    elif suffix in {".parquet", ".pq"}:
        df = pd.read_parquet(path)
    else:
        raise ValueError("datasetPath must end with .csv or .parquet")
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"Dataset missing required columns: {', '.join(missing)}")
    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=["timestamp"])
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["open", "high", "low", "close", "volume"])
    df["symbol"] = df["symbol"].astype(str).str.upper()
    return df.sort_values(["symbol", "timestamp"]).reset_index(drop=True)


def build_p1_features(df):
    """Build P1 OHLCV features using only current/past rows."""
    import numpy as np
    out = df.copy()
    close = out["close"].astype(float)
    open_ = out["open"].astype(float)
    high = out["high"].astype(float)
    low = out["low"].astype(float)
    volume = out["volume"].astype(float)

    out["ret_1"] = close.pct_change(1)
    out["ret_5"] = close.pct_change(5)
    out["ret_20"] = close.pct_change(20)
    out["range_pct"] = (high - low) / close.replace(0, np.nan)
    out["body_pct"] = (close - open_).abs() / (high - low).replace(0, np.nan)
    out["upper_wick_pct"] = (high - np.maximum(open_, close)) / (high - low).replace(0, np.nan)
    out["lower_wick_pct"] = (np.minimum(open_, close) - low) / (high - low).replace(0, np.nan)
    vol_mean = volume.rolling(20, min_periods=20).mean()
    vol_std = volume.rolling(20, min_periods=20).std()
    out["volume_zscore_20"] = (volume - vol_mean) / vol_std.replace(0, np.nan)
    out["realized_vol_20"] = out["ret_1"].rolling(20, min_periods=20).std()
    out["ema9_spread"] = close / close.ewm(span=9, adjust=False).mean() - 1
    out["ema20_spread"] = close / close.ewm(span=20, adjust=False).mean() - 1
    typical = (high + low + close) / 3
    vwap = (typical * volume).cumsum() / volume.cumsum().replace(0, np.nan)
    out["vwap_spread"] = close / vwap - 1
    return out


def ensure_features(df) -> tuple[Any, list[str]]:
    engineered = build_p1_features(df)
    features = []
    for col in OPTIONAL_FEATURES + P1_FEATURES:
      if col in engineered.columns and col not in features:
        features.append(col)
    return engineered, features


def make_labels(df, horizon: int, tau_up: float, tau_dn: float, cost_bps: float):
    """Create labels with entry open[t+1], exit close[t+horizon]; tail rows are NaN."""
    import numpy as np
    entry = df["open"].shift(-1)
    exit_ = df["close"].shift(-horizon)
    net_return = (exit_ - entry) / entry - (cost_bps / 10000.0)
    y = np.where(net_return > tau_up, 2, np.where(net_return < -tau_dn, 0, 1)).astype(float)
    y[df.index >= len(df) - horizon] = np.nan
    y[entry.isna() | exit_.isna()] = np.nan
    return y, net_return


def chronological_split_indices(n: int, horizon: int, train_ratio: float = 0.70, val_ratio: float = 0.15):
    usable = max(n - (2 * horizon), 0)
    train_len = int(usable * train_ratio)
    val_len = int(usable * val_ratio)
    test_len = usable - train_len - val_len
    train_end = train_len
    val_start = train_end + horizon
    val_end = val_start + val_len
    test_start = val_end + horizon
    # If ratios produce an empty tail, keep indices chronological; callers are
    # responsible for rejecting too-small splits before model fitting.
    test_end = min(test_start + test_len, n)
    return {
        "train": (0, train_end),
        "val": (val_start, val_end),
        "test": (test_start, test_end),
        "gap": horizon,
        "shuffle": False,
    }


def class_distribution(y) -> dict[str, int]:
    return {LABEL_MAP.get(int(k), str(k)): int(v) for k, v in zip(*__import__("numpy").unique(y, return_counts=True))}


def make_logistic_regression():
    from sklearn.linear_model import LogisticRegression

    return LogisticRegression(
        max_iter=1000,
        solver="lbfgs",
        class_weight="balanced",
    )


def model_fit_error(model_type: str, exc: Exception) -> dict[str, str]:
    return {"modelType": model_type, "errorType": type(exc).__name__, "message": str(exc)}


def normalize_model_type(model_type: str | None) -> str:
    normalized = (model_type or "xgboost").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "xgb": "xgboost",
        "xgboostclassifier": "xgboost",
        "xgboost_classifier": "xgboost",
        "logisticregression": "logistic_regression",
        "logistic_regression": "logistic_regression",
        "lr": "logistic_regression",
        "histgradientboosting": "hist_gradient_boosting",
        "hist_gradient_boosting": "hist_gradient_boosting",
        "histgradientboostingclassifier": "hist_gradient_boosting",
        "lightgbm": "lightgbm",
        "lgbm": "lightgbm",
        "lgbmclassifier": "lightgbm",
    }
    return aliases.get(normalized, "xgboost")


def evaluate(model, x, y, labels: list[int]) -> dict[str, Any]:
    import numpy as np
    from sklearn.metrics import accuracy_score, brier_score_loss, confusion_matrix, f1_score, log_loss, roc_auc_score
    pred = model.predict(x)
    metrics: dict[str, Any] = {
        "accuracy": float(accuracy_score(y, pred)),
        "f1_macro": float(f1_score(y, pred, average="macro", zero_division=0)),
        "confusion_matrix": confusion_matrix(y, pred, labels=labels).tolist(),
    }
    if hasattr(model, "predict_proba"):
        proba = model.predict_proba(x)
        try:
            metrics["log_loss"] = float(log_loss(y, proba, labels=labels))
        except Exception:
            metrics["log_loss"] = None
        try:
            metrics["roc_auc_ovr"] = float(roc_auc_score(y, proba, multi_class="ovr", labels=labels))
        except Exception:
            metrics["roc_auc_ovr"] = None
        try:
            classes = list(model.classes_)
            long_idx = classes.index(2)
            metrics["brier_long"] = float(brier_score_loss((np.asarray(y) == 2).astype(int), proba[:, long_idx]))
        except Exception:
            metrics["brier_long"] = None
    return metrics


def not_enough_data(message: str, stage: str, row_count: int | None = None, usable_rows: int | None = None, class_dist: dict[str, int] | None = None, **details: Any) -> dict[str, Any]:
    payload_details = {
        "rowCount": row_count,
        "usableRows": usable_rows,
        "classDistribution": class_dist or {},
        **details,
    }
    return {"ok": False, "status": "not_enough_data", "stage": stage, "message": message, "details": payload_details}


def train(args) -> dict[str, Any]:
    set_stage("dataset_validation")
    dataset = Path(args.dataset).resolve()
    if not dataset.exists() or dataset.stat().st_size == 0:
        return {"ok": False, "status": "dataset_missing", "stage": "dataset_validation", "message": "Dataset snapshot does not exist or is empty.", "details": {"datasetPath": str(dataset)}}

    # Useful in dependency-light CI: tiny CSVs can return not_enough_data before importing pandas.
    row_count = quick_row_count(dataset)
    min_rows = max(80, args.horizon * 5)
    if row_count is not None and row_count < min_rows:
        return not_enough_data(f"Need at least {min_rows} rows for horizon={args.horizon}; found {row_count}.", "dataset_validation", row_count=row_count, usable_rows=0, minRows=min_rows)

    set_stage("dependency_imports")
    modules, missing = dependency_imports()
    if missing:
        return {
            "ok": False,
            "status": "python_dependency_missing",
            "message": "Python ML dependencies are missing. Install requirements-ml.txt before training.",
            "missing": [m["module"] for m in missing],
            "installCommand": "pip install -r requirements-ml.txt",
            "details": {"missingDependencies": missing},
        }

    import numpy as np
    import joblib
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.impute import SimpleImputer

    set_stage("load_dataset")
    df = load_snapshot(dataset)
    source_row_count = len(df)
    if args.symbol:
        df = df[df["symbol"] == args.symbol.upper()].reset_index(drop=True)
    if len(df) < min_rows:
        return not_enough_data(f"Need at least {min_rows} usable rows for horizon={args.horizon}; found {len(df)}.", "dataset_validation", row_count=source_row_count, usable_rows=len(df), minRows=min_rows)

    set_stage("feature_engineering")
    df, features = ensure_features(df)
    set_stage("label_or_split")
    y, _returns = make_labels(df, args.horizon, args.tau_up, args.tau_dn, args.cost_bps)
    df["y"] = y
    needed = features + ["y"]
    clean = df.replace([np.inf, -np.inf], np.nan).dropna(subset=needed).reset_index(drop=True)
    if len(clean) < min_rows:
        return not_enough_data("Not enough rows or classes after labeling.", "label_or_split", row_count=source_row_count, usable_rows=len(clean), minRows=min_rows)

    y_arr = clean["y"].astype(int).to_numpy()
    class_dist = class_distribution(y_arr)
    if len(set(y_arr.tolist())) < 2:
        return not_enough_data("Not enough rows or classes after labeling.", "label_or_split", row_count=source_row_count, usable_rows=len(clean), class_dist=class_dist)

    split = chronological_split_indices(len(clean), args.horizon)
    train_slice = slice(*split["train"])
    val_slice = slice(*split["val"])
    test_slice = slice(*split["test"])
    if min(len(clean.iloc[train_slice]), len(clean.iloc[val_slice]), len(clean.iloc[test_slice])) < 5:
        return not_enough_data("Not enough rows or classes after labeling.", "label_or_split", row_count=source_row_count, usable_rows=len(clean), class_dist=class_dist, split=split)

    x = clean[features].astype(float).to_numpy()
    x_train, y_train = x[train_slice], y_arr[train_slice]
    x_val, y_val = x[val_slice], y_arr[val_slice]
    x_test, y_test = x[test_slice], y_arr[test_slice]
    labels = [0, 1, 2]
    requested_model_type = normalize_model_type(getattr(args, "model_type", None))
    fit_errors: list[dict[str, str]] = []
    warnings: list[str] = []
    candidates: list[tuple[str, Any, dict[str, Any]]] = []

    baseline_report: dict[str, Any] = {"status": "failed", "modelType": "logistic_regression", "error": None}
    baseline = Pipeline([("imputer", SimpleImputer()), ("scaler", StandardScaler()), ("model", make_logistic_regression())])
    try:
        baseline.fit(x_train, y_train)
        baseline_metrics = evaluate(baseline, x_val, y_val, labels)
        candidates.append(("logistic_regression", baseline, baseline_metrics))
        baseline_report = {"status": "trained", "modelType": "logistic_regression", "error": None}
    except Exception as exc:
        error = model_fit_error("logistic_regression", exc)
        fit_errors.append(error)
        warnings.append("baseline_failed")
        baseline_report = {"status": "failed", "modelType": "logistic_regression", "error": error["message"]}

    candidate_report: dict[str, Any] = {"status": "failed", "modelType": requested_model_type, "error": None}

    def fit_candidate(model_type: str, model: Any) -> None:
        nonlocal candidate_report
        model.fit(x_train, y_train)
        metrics = evaluate(model, x_val, y_val, labels)
        candidates.append((model_type, model, metrics))
        candidate_report = {"status": "trained", "modelType": model_type, "error": None}

    import importlib.util
    if requested_model_type == "logistic_regression":
        candidate_report = dict(baseline_report)
    elif requested_model_type == "xgboost":
        try:
            if importlib.util.find_spec("xgboost") is None:
                raise ImportError("xgboost is not installed; falling back to hist_gradient_boosting")
            from xgboost import XGBClassifier  # type: ignore
            xgb = XGBClassifier(objective="multi:softprob", num_class=3, n_estimators=80, max_depth=3, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9, eval_metric="mlogloss", random_state=42)
            fit_candidate("xgboost", xgb)
        except ImportError:
            try:
                hgb = Pipeline([("imputer", SimpleImputer()), ("model", HistGradientBoostingClassifier(max_iter=120, learning_rate=0.05, random_state=42))])
                fit_candidate("hist_gradient_boosting", hgb)
            except Exception as exc:
                error = model_fit_error("hist_gradient_boosting", exc)
                fit_errors.append(error)
                warnings.append("candidate_failed")
                candidate_report = {"status": "failed", "modelType": "hist_gradient_boosting", "error": error["message"]}
        except Exception as exc:
            error = model_fit_error("xgboost", exc)
            fit_errors.append(error)
            warnings.append("candidate_failed")
            candidate_report = {"status": "failed", "modelType": "xgboost", "error": error["message"]}
    elif requested_model_type == "lightgbm":
        try:
            if importlib.util.find_spec("lightgbm") is None:
                raise ImportError("lightgbm is not installed; falling back to hist_gradient_boosting")
            from lightgbm import LGBMClassifier  # type: ignore
            lgbm = LGBMClassifier(objective="multiclass", num_class=3, n_estimators=120, learning_rate=0.05, random_state=42, class_weight="balanced", verbose=-1)
            fit_candidate("lightgbm", lgbm)
        except ImportError:
            try:
                hgb = Pipeline([("imputer", SimpleImputer()), ("model", HistGradientBoostingClassifier(max_iter=120, learning_rate=0.05, random_state=42))])
                fit_candidate("hist_gradient_boosting", hgb)
            except Exception as exc:
                error = model_fit_error("hist_gradient_boosting", exc)
                fit_errors.append(error)
                warnings.append("candidate_failed")
                candidate_report = {"status": "failed", "modelType": "hist_gradient_boosting", "error": error["message"]}
        except Exception as exc:
            error = model_fit_error("lightgbm", exc)
            fit_errors.append(error)
            warnings.append("candidate_failed")
            candidate_report = {"status": "failed", "modelType": "lightgbm", "error": error["message"]}
    else:
        try:
            hgb = Pipeline([("imputer", SimpleImputer()), ("model", HistGradientBoostingClassifier(max_iter=120, learning_rate=0.05, random_state=42))])
            fit_candidate("hist_gradient_boosting", hgb)
        except Exception as exc:
            error = model_fit_error("hist_gradient_boosting", exc)
            fit_errors.append(error)
            warnings.append("candidate_failed")
            candidate_report = {"status": "failed", "modelType": "hist_gradient_boosting", "error": error["message"]}

    if not candidates:
        return {
            "ok": False,
            "status": "training_failed",
            "message": "All candidate models failed to train.",
            "stage": "model_fit",
            "errors": fit_errors,
            "baseline": baseline_report,
            "candidate": candidate_report,
        }

    best_name, best_model, val_metrics = max(candidates, key=lambda item: (item[2].get("f1_macro") or 0, item[2].get("accuracy") or 0))
    test_metrics = evaluate(best_model, x_test, y_test, labels)
    test_metrics["class_distribution"] = class_dist
    test_metrics["validation"] = val_metrics

    created_at = datetime.now(timezone.utc).isoformat()
    model_id = f"ml_{args.symbol.upper()}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{hashlib.sha1(os.urandom(8)).hexdigest()[:8]}"
    artifact_dir = Path(args.output_dir).resolve() / model_id
    artifact_dir.mkdir(parents=True, exist_ok=True)

    if best_name == "xgboost" and hasattr(best_model, "save_model"):
        artifact_path = artifact_dir / "model.json"
        best_model.save_model(str(artifact_path))
        artifact_type = "xgboost_json"
    else:
        artifact_path = artifact_dir / "model.joblib"
        joblib.dump(best_model, artifact_path)
        artifact_type = "sklearn_joblib_trusted_local"

    feature_schema = {"features": features, "requiredInputColumns": REQUIRED_COLUMNS, "labelMap": LABEL_MAP}
    manifest = {
        "modelId": model_id,
        "createdAt": created_at,
        "symbol": args.symbol.upper(),
        "timeframe": args.timeframe,
        "horizon": args.horizon,
        "modelType": best_name,
        "artifactType": artifact_type,
        "artifactFile": artifact_path.name,
        "features": features,
        "labelMap": LABEL_MAP,
        "datasetPath": str(dataset),
        "datasetHash": dataframe_hash(clean),
        "featureSchemaHash": schema_hash(features),
    }
    (artifact_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, default=json_default), encoding="utf-8")
    (artifact_dir / "metrics.json").write_text(json.dumps(test_metrics, indent=2, default=json_default), encoding="utf-8")
    (artifact_dir / "feature_schema.json").write_text(json.dumps(feature_schema, indent=2), encoding="utf-8")
    report = {"split": split, "trainRows": len(x_train), "valRows": len(x_val), "testRows": len(x_test), "baseline": baseline_report, "candidate": candidate_report, "candidateValidationMetrics": {n: m for n, _, m in candidates}, "errors": fit_errors}
    (artifact_dir / "train_report.json").write_text(json.dumps(report, indent=2, default=json_default), encoding="utf-8")
    (artifact_dir / "model_card.md").write_text(f"# Model Card — {model_id}\n\nModel type: {best_name}\nHorizon: {args.horizon}\nFeatures: {len(features)}\n", encoding="utf-8")

    result = {"ok": True, "status": "trained", "modelId": model_id, "createdAt": created_at, "artifactPath": str(artifact_dir), "artifactType": artifact_type, "modelType": best_name, "metrics": test_metrics, "datasetHash": manifest["datasetHash"], "featureSchemaHash": manifest["featureSchemaHash"], "featureSchema": feature_schema}
    if warnings:
        result["warnings"] = sorted(set(warnings))
    return result


def parse_args(argv: list[str] | None = None):
    set_stage("argparse")
    parser = JsonArgumentParser()
    parser.add_argument("--dataset", "--data", dest="dataset", required=True)
    parser.add_argument("--symbol", default="")
    parser.add_argument("--timeframe", default="1m")
    parser.add_argument("--horizon", type=int, required=True)
    parser.add_argument("--cost-bps", type=float, default=0.0)
    parser.add_argument("--tau-up", "--up-threshold", dest="tau_up", type=float, default=0.001)
    parser.add_argument("--tau-dn", "--down-threshold", dest="tau_dn", type=float, default=0.001)
    parser.add_argument("--output-dir", "--output", dest="output_dir", default=os.environ.get("ML_ARTIFACTS_DIR", "server/ai/artifacts"))
    parser.add_argument("--model-type", "--model", dest="model_type", default="xgboost")
    parser.add_argument("--promote", action="store_true", help="Accepted for Node compatibility; promotion is handled by Node.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> dict[str, Any]:
    args = parse_args(argv)
    return train(args)


def json_failure(exc: Exception) -> dict[str, Any]:
    status = "invalid_request" if isinstance(exc, JsonArgparseError) else "training_failed"
    return {
        "ok": False,
        "status": status,
        "stage": CURRENT_STAGE,
        "message": str(exc),
        "errorType": exc.__class__.__name__,
        "traceback": traceback.format_exc()[-4000:],
    }


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
        emit(result, 0 if result.get("ok") is True else 1)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"training pipeline failed at stage={CURRENT_STAGE}: {exc}", file=sys.stderr)
        emit(json_failure(exc), 2 if isinstance(exc, JsonArgparseError) else 1)
