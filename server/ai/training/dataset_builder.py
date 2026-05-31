"""
Dataset builder — constructs labelled training datasets from OHLCV(+) data.

Labels use a three-way classification scheme:
    LONG    (2): forward net return >= tau_up
    SHORT   (0): forward net return <= tau_down
    NEUTRAL (1): return between the thresholds

Entry price is the *open* of bar t+1 (realistic fill assumption); exit
price is the *close* of bar t+horizon.  The last ``horizon`` rows are
always dropped because their exit price lies beyond the available data.

Parquet format (written and read by this module)
------------------------------------------------
Index   : ``timestamp`` (original DatetimeIndex, or RangeIndex name)
Columns : <feature_col_0> … <feature_col_N-1>  +  ``label`` (int)

Public API
----------
build_dataset(df, ...) -> Dict
    Build features + labels and optionally persist to Parquet.

load_dataset(parquet_path) -> Dict
    Reload X, y from a Parquet file saved by build_dataset.
"""

from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime, timezone
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from .feature_builder import ALL_FEATURE_NAMES, build_features

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Label constants
# ---------------------------------------------------------------------------
LABEL_SHORT = 0
LABEL_NEUTRAL = 1
LABEL_LONG = 2


# ---------------------------------------------------------------------------
# Main builder
# ---------------------------------------------------------------------------

def build_dataset(
    df: pd.DataFrame,
    horizon: int = 5,
    tau_up: float = 0.003,
    tau_down: float = -0.003,
    feature_names: Optional[List[str]] = None,
    symbol: str = "UNKNOWN",
    timeframe: str = "1m",
    output_dir: Optional[str] = None,
) -> Dict:
    """
    Build a labelled ML dataset from raw OHLCV(+) market data.

    Steps
    -----
    1. Hash the raw input DataFrame (SHA-256 of its Parquet bytes) for
       lineage tracking.
    2. Compute features via :func:`build_features`.
    3. Compute three-class labels: entry=open[t+1], exit=close[t+horizon].
       LONG(2) if net_return >= tau_up, SHORT(0) if <= tau_down, else NEUTRAL(1).
       Last *horizon* rows are dropped (no valid future exit).
    4. Align X and y on their common non-NaN index.
    5. Compute feature_schema_hash = MD5 of sorted feature names.
    6. Save to Parquet if output_dir is provided:
       ``<output_dir>/<symbol>_<timeframe>_<UTC-timestamp>.parquet``.
    7. Return a metadata-rich dict.

    Parameters
    ----------
    df : pd.DataFrame
        OHLCV(+) DataFrame sorted ascending by time with lowercase column
        names.  Minimum required columns: ``open``, ``high``, ``low``,
        ``close``, ``volume``.  A DatetimeIndex is recommended but not
        mandatory.
    horizon : int, default 5
        Number of bars ahead used to measure the trade outcome.
        Entry: open[t+1]; Exit: close[t+horizon].
    tau_up : float, default 0.003
        Net return threshold for a LONG label (>= tau_up).
    tau_down : float, default -0.003
        Net return threshold for a SHORT label (<= tau_down).
    feature_names : list of str, optional
        Subset of ALL_FEATURE_NAMES to compute.  Defaults to all 30.
    symbol : str, default "UNKNOWN"
        Instrument ticker stored in the returned metadata.
    timeframe : str, default "1m"
        Bar resolution stored in the returned metadata.
    output_dir : str, optional
        If provided, the dataset is saved to a Parquet file under this
        directory (created automatically if absent).

    Returns
    -------
    dict with keys:
        X                   : pd.DataFrame  — feature matrix (NaN rows dropped)
        y                   : pd.Series     — integer labels {0, 1, 2}, same idx
        feature_names       : list[str]     — ordered feature column names
        feature_schema_hash : str           — MD5 of sorted feature names
        dataset_hash        : str           — SHA-256 of raw df parquet bytes
        n_samples           : int           — usable rows after cleanup
        label_distribution  : dict          — counts keyed by label description
        symbol              : str
        timeframe           : str

    Raises
    ------
    ValueError
        If horizon < 1, tau_up <= 0, or tau_down >= 0.
    KeyError
        If required OHLCV columns are absent from *df*.
    """
    if horizon < 1:
        raise ValueError(f"horizon must be >= 1, got {horizon}")
    if tau_up <= 0:
        raise ValueError(f"tau_up must be > 0, got {tau_up}")
    if tau_down >= 0:
        raise ValueError(f"tau_down must be < 0, got {tau_down}")

    # Step 1 — Hash raw input before any mutation
    dataset_hash = _sha256_parquet(df)

    # Step 2 — Compute features
    logger.info(
        "[dataset_builder] Computing features for %s %s (%d rows)…",
        symbol,
        timeframe,
        len(df),
    )
    X_df = build_features(df, feature_names=feature_names)
    feat_cols: List[str] = list(X_df.columns)

    # Step 3 — Compute labels (last *horizon* rows get NaN)
    y_raw = _compute_labels(df, horizon=horizon, tau_up=tau_up, tau_down=tau_down)

    # Step 4 — Align X and y; drop any row where either has NaN
    valid_label_idx = y_raw.dropna().index
    X_aligned = X_df.loc[X_df.index.isin(valid_label_idx)]
    y_aligned = y_raw.loc[y_raw.index.isin(valid_label_idx)]

    common_idx = X_aligned.dropna().index.intersection(y_aligned.dropna().index)
    X_final = X_aligned.loc[common_idx]
    y_final = y_aligned.loc[common_idx].astype(int)

    n_samples = len(X_final)
    logger.info("[dataset_builder] %d usable samples after alignment.", n_samples)

    # Step 5 — Compute metadata hashes
    feature_schema_hash = _md5_feature_names(feat_cols)

    label_dist: Dict[str, int] = {
        "SHORT (0)": int((y_final == LABEL_SHORT).sum()),
        "NEUTRAL (1)": int((y_final == LABEL_NEUTRAL).sum()),
        "LONG (2)": int((y_final == LABEL_LONG).sum()),
    }

    # Step 6 — Persist if requested
    if output_dir is not None:
        _save_parquet(X_final, y_final, output_dir, symbol, timeframe)

    # Step 7 — Return
    return {
        "X": X_final,
        "y": y_final,
        "feature_names": feat_cols,
        "feature_schema_hash": feature_schema_hash,
        "dataset_hash": dataset_hash,
        "n_samples": n_samples,
        "label_distribution": label_dist,
        "symbol": symbol,
        "timeframe": timeframe,
    }


def load_dataset(parquet_path: str) -> Dict:
    """
    Load a labelled dataset from a Parquet file created by :func:`build_dataset`.

    The Parquet format is:
        * Index   : ``timestamp`` (the original DatetimeIndex or its name)
        * Columns : all feature columns + ``label`` (int)

    Parameters
    ----------
    parquet_path : str
        Absolute or relative path to the ``.parquet`` file.

    Returns
    -------
    dict with keys:
        X             : pd.DataFrame  — feature columns only
        y             : pd.Series     — integer labels {0, 1, 2}
        feature_names : list[str]     — feature column names in file order
        n_samples     : int

    Raises
    ------
    FileNotFoundError
        If *parquet_path* does not exist.
    KeyError
        If the ``label`` column is missing from the file.
    """
    if not os.path.exists(parquet_path):
        raise FileNotFoundError(f"Dataset file not found: {parquet_path!r}")

    combined = pd.read_parquet(parquet_path)

    if "label" not in combined.columns:
        raise KeyError(
            f"'label' column not found in {parquet_path!r}. "
            "The file may not have been created by build_dataset()."
        )

    y = combined["label"].astype(int)
    X = combined.drop(columns=["label"])
    feat_cols = list(X.columns)

    return {
        "X": X,
        "y": y,
        "feature_names": feat_cols,
        "n_samples": len(X),
    }


# ---------------------------------------------------------------------------
# Label computation (private)
# ---------------------------------------------------------------------------

def _compute_labels(
    df: pd.DataFrame,
    horizon: int,
    tau_up: float,
    tau_down: float,
) -> pd.Series:
    """
    Compute three-class labels for every row in *df*.

    For each bar t:
        entry_price = open[t + 1]
        exit_price  = close[t + horizon]
        net_return  = (exit_price - entry_price) / entry_price

        label = LONG(2)    if net_return >= tau_up
              = SHORT(0)   if net_return <= tau_down
              = NEUTRAL(1) otherwise
        label = NaN        for the last *horizon* bars (no valid exit)

    Parameters
    ----------
    df       : DataFrame with ``open`` and ``close`` columns.
    horizon  : Look-ahead bars (>= 1).
    tau_up   : Return threshold for LONG.
    tau_down : Return threshold for SHORT.

    Returns
    -------
    pd.Series of float (NaN-compatible), same index as *df*.
    """
    opens = df["open"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)
    n = len(df)

    labels = np.full(n, np.nan, dtype=float)

    # Valid range: t in [0, n - horizon - 1]
    # We need t+1 for entry (valid when t <= n-2) and t+horizon for exit.
    # Combined: t <= n - horizon - 1  (equivalently t < n - horizon)
    for t in range(n - horizon):
        entry = opens[t + 1]
        exit_ = closes[t + horizon]

        if not (np.isfinite(entry) and np.isfinite(exit_)) or entry == 0.0:
            continue

        net_ret = (exit_ - entry) / entry

        if net_ret >= tau_up:
            labels[t] = LABEL_LONG
        elif net_ret <= tau_down:
            labels[t] = LABEL_SHORT
        else:
            labels[t] = LABEL_NEUTRAL

    return pd.Series(labels, index=df.index, dtype=float)


# ---------------------------------------------------------------------------
# Persistence helpers (private)
# ---------------------------------------------------------------------------

def _save_parquet(
    X: pd.DataFrame,
    y: pd.Series,
    output_dir: str,
    symbol: str,
    timeframe: str,
) -> str:
    """
    Save the aligned feature matrix + labels to a single Parquet file.

    File is named ``<symbol>_<timeframe>_<UTC-timestamp>.parquet`` and placed
    under *output_dir* (created automatically if absent).

    Returns the full file path.
    """
    os.makedirs(output_dir, exist_ok=True)

    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"{symbol}_{timeframe}_{ts}.parquet"
    path = os.path.join(output_dir, filename)

    combined = X.copy()
    combined["label"] = y.values
    combined.index.name = "timestamp"
    combined.to_parquet(path, index=True, compression="snappy")

    logger.info("[dataset_builder] Saved dataset → %s", path)
    return path


# ---------------------------------------------------------------------------
# Hashing helpers (private)
# ---------------------------------------------------------------------------

def _sha256_parquet(df: pd.DataFrame) -> str:
    """Return SHA-256 hex digest of *df* serialised as Parquet bytes."""
    buf = df.to_parquet(index=True, compression=None)
    return hashlib.sha256(buf).hexdigest()


def _md5_feature_names(feature_names: List[str]) -> str:
    """Return MD5 hex digest of the *sorted* feature name list."""
    schema_str = ",".join(sorted(feature_names))
    return hashlib.md5(schema_str.encode()).hexdigest()
