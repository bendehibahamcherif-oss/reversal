"""
Label builder — no-lookahead multiclass labels for intraday signals.

Labels are computed strictly as-of time t: only candle data up to and
including index t is used; future price at t+horizon defines the outcome.
The last `horizon` rows are always set to NaN (no future data available).
"""

import numpy as np
import pandas as pd
from typing import Optional


# Class constants (kept in sync with train_pipeline LABEL_CLASSES)
LABEL_UP      = "UP"
LABEL_DOWN    = "DOWN"
LABEL_NEUTRAL = "NEUTRAL"
LABEL_UNKNOWN = np.nan


def create_labels(
    df: pd.DataFrame,
    horizon: int,
    up_threshold: float,
    down_threshold: float,
    price_col: str = "close",
) -> pd.Series:
    """
    Build UP / NEUTRAL / DOWN labels for every row in *df*.

    Parameters
    ----------
    df            : DataFrame sorted by time ascending, containing *price_col*.
    horizon       : Number of rows ahead to measure the return.
    up_threshold  : Minimum return (e.g. 0.005) to assign UP.
    down_threshold: Maximum return (e.g. -0.005) to assign DOWN.
    price_col     : Column name for the price series.

    Returns
    -------
    pd.Series aligned to df.index.  Last *horizon* entries are NaN.
    """
    if horizon < 1:
        raise ValueError(f"horizon must be >= 1, got {horizon}")
    if up_threshold <= 0 or down_threshold >= 0:
        raise ValueError("up_threshold must be > 0 and down_threshold must be < 0")
    if price_col not in df.columns:
        raise KeyError(f"price_col '{price_col}' not found in DataFrame")

    prices  = df[price_col].to_numpy(dtype=float)
    n       = len(prices)
    labels  = np.empty(n, dtype=object)
    labels[:] = LABEL_UNKNOWN

    for t in range(n - horizon):
        p0 = prices[t]
        pH = prices[t + horizon]
        if p0 == 0 or not (np.isfinite(p0) and np.isfinite(pH)):
            continue
        ret = (pH - p0) / p0
        if ret >= up_threshold:
            labels[t] = LABEL_UP
        elif ret <= down_threshold:
            labels[t] = LABEL_DOWN
        else:
            labels[t] = LABEL_NEUTRAL

    # Explicitly mark the unpredictable tail as NaN
    labels[n - horizon:] = np.nan

    series = pd.Series(labels, index=df.index, dtype=object)
    return series


def create_triple_barrier_labels(
    df: pd.DataFrame,
    horizon: int,
    profit_target: float,
    stop_loss: float,
    price_col: str = "close",
    high_col: Optional[str] = "high",
    low_col: Optional[str] = "low",
) -> pd.Series:
    """
    Triple-barrier labels: first barrier hit among profit_target, stop_loss,
    or end-of-horizon defines the label.  Uses high/low intra-bar if available.

    Returns UP / DOWN / NEUTRAL aligned to df.index (last *horizon* → NaN).
    """
    if horizon < 1:
        raise ValueError(f"horizon must be >= 1, got {horizon}")

    prices = df[price_col].to_numpy(dtype=float)
    highs  = df[high_col].to_numpy(dtype=float)  if (high_col and high_col in df.columns) else None
    lows   = df[low_col].to_numpy(dtype=float)   if (low_col  and low_col  in df.columns) else None
    n      = len(prices)
    labels = np.empty(n, dtype=object)
    labels[:] = np.nan

    for t in range(n - horizon):
        entry = prices[t]
        if entry == 0 or not np.isfinite(entry):
            continue
        outcome = LABEL_NEUTRAL
        for k in range(1, horizon + 1):
            hi = highs[t + k] if highs is not None else prices[t + k]
            lo = lows[t + k]  if lows  is not None else prices[t + k]
            if not (np.isfinite(hi) and np.isfinite(lo)):
                continue
            up_hit   = (hi - entry) / entry >= profit_target
            down_hit = (lo - entry) / entry <= -stop_loss
            if up_hit and down_hit:
                outcome = LABEL_NEUTRAL
                break
            if up_hit:
                outcome = LABEL_UP
                break
            if down_hit:
                outcome = LABEL_DOWN
                break
        labels[t] = outcome

    return pd.Series(labels, index=df.index, dtype=object)
