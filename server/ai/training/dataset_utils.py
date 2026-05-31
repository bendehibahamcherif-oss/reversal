"""
Dataset utilities — loading, hashing, temporal splitting, and model persistence.
"""

import hashlib
import io
import json
import os
from typing import Dict, Tuple

import joblib
import numpy as np
import pandas as pd
from sklearn.model_selection import TimeSeriesSplit


# ── Loading ────────────────────────────────────────────────────────────────────

def load_parquet(path: str) -> pd.DataFrame:
    """Load an OHLCV Parquet snapshot sorted ascending by index (time)."""
    df = pd.read_parquet(path)
    df = df.sort_index()
    return df


def load_csv(path: str, index_col: str = "timestamp") -> pd.DataFrame:
    """Load CSV with a datetime index, sorted ascending."""
    df = pd.read_csv(path, parse_dates=[index_col], index_col=index_col)
    df = df.sort_index()
    return df


# ── Hashing ────────────────────────────────────────────────────────────────────

def compute_hash(data: bytes, algorithm: str = "md5") -> str:
    """Return hex digest of *data* using *algorithm* (md5 or sha256)."""
    h = hashlib.new(algorithm)
    h.update(data)
    return h.hexdigest()


def compute_dataframe_hash(df: pd.DataFrame) -> str:
    """Stable hash of a DataFrame's contents (rows and column names)."""
    buf = df.to_parquet(index=True, compression=None)
    return compute_hash(buf, "sha256")


def compute_schema_hash(feature_names) -> str:
    """Hash of the feature column order — detects schema drift."""
    schema_str = ",".join(sorted(str(n) for n in feature_names))
    return compute_hash(schema_str.encode(), "md5")


# ── Temporal split ─────────────────────────────────────────────────────────────

def temporal_train_val_test_split(
    df: pd.DataFrame,
    train_ratio: float = 0.70,
    val_ratio: float   = 0.15,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """
    Chronological train / val / test split — NO shuffle.

    Parameters
    ----------
    df          : DataFrame sorted by time ascending.
    train_ratio : Fraction for training (default 0.70).
    val_ratio   : Fraction for validation (default 0.15).
                  test_ratio = 1 − train_ratio − val_ratio.

    Returns
    -------
    (df_train, df_val, df_test)
    """
    test_ratio = 1.0 - train_ratio - val_ratio
    if test_ratio < 0:
        raise ValueError("train_ratio + val_ratio must be <= 1.0")

    n         = len(df)
    train_end = int(n * train_ratio)
    val_end   = int(n * (train_ratio + val_ratio))

    df_train = df.iloc[:train_end].copy()
    df_val   = df.iloc[train_end:val_end].copy()
    df_test  = df.iloc[val_end:].copy()

    return df_train, df_val, df_test


def time_series_cv(n_samples: int, n_splits: int, horizon: int) -> TimeSeriesSplit:
    """
    Return a TimeSeriesSplit with gap=horizon so no training sample falls
    within `horizon` rows of the corresponding test window (no lookahead).
    """
    return TimeSeriesSplit(n_splits=n_splits, gap=horizon)


# ── Model / metadata persistence ───────────────────────────────────────────────

def save_models(model_dict: Dict, metadata: Dict, output_dir: str) -> None:
    """
    Persist trained models and a JSON metadata manifest to *output_dir*.

    Supported keys in model_dict:
        'logistic' → logistic_baseline.pkl   (joblib)
        'xgb'      → xgb_champion.json       (XGBoost native JSON)
        'lgb'      → lgb_challenger.txt       (LightGBM text)
        any other  → <key>.pkl               (joblib fallback)
    """
    os.makedirs(output_dir, exist_ok=True)

    _FORMAT_MAP = {
        "logistic": ("logistic_baseline.pkl",  "joblib"),
        "xgb":      ("xgb_champion.json",       "xgb"),
        "lgb":      ("lgb_challenger.txt",       "lgb"),
    }

    for name, model in model_dict.items():
        filename, fmt = _FORMAT_MAP.get(name, (f"{name}.pkl", "joblib"))
        out_path = os.path.join(output_dir, filename)

        if fmt == "xgb":
            model.save_model(out_path)
        elif fmt == "lgb":
            model.booster_.save_model(out_path)
        else:
            joblib.dump(model, out_path)

    with open(os.path.join(output_dir, "model_metadata.json"), "w") as fh:
        json.dump(metadata, fh, indent=2, default=_json_default)

    print(f"[save_models] Saved {len(model_dict)} model(s) and metadata → {output_dir}")


def load_model_artifact(artifact_path: str):
    """
    Load a model artifact by extension:
        .json → XGBoost Booster
        .txt  → LightGBM Booster
        .pkl  → joblib object
    """
    ext = os.path.splitext(artifact_path)[1].lower()
    if ext == ".json":
        import xgboost as xgb
        booster = xgb.Booster()
        booster.load_model(artifact_path)
        return booster
    if ext == ".txt":
        import lightgbm as lgb
        return lgb.Booster(model_file=artifact_path)
    return joblib.load(artifact_path)


# ── Internal helpers ───────────────────────────────────────────────────────────

def _json_default(obj):
    """JSON serialiser for numpy scalars and ndarrays."""
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"Object of type {type(obj)} is not JSON serialisable")
