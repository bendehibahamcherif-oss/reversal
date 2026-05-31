"""
Label builder — no-lookahead multiclass labels for intraday signals.

Labels are computed strictly as-of time t: only candle data up to and
including index t is used; future price at t+horizon defines the outcome.
The last `horizon` rows are always set to NaN (no future data available).
"""

import numpy as np
import pandas as pd
from typing import Optional


# ── Numerical signal labels (+1 / -1 / 0 / NaN) ───────────────────────────────

def make_labels(df: pd.DataFrame, horizon: int, price_col: str = "close") -> pd.Series:
    """
    Binary signal labels aligned to df.index.

    For each row t the label is:
        +1  if close[t + horizon] > close[t]
        -1  if close[t + horizon] < close[t]
         0  if equal
        NaN for the last *horizon* rows (no future data)

    Parameters
    ----------
    df        : DataFrame with a numeric *price_col* column, sorted ascending.
    horizon   : Look-ahead bars (>= 1).
    price_col : Column to use for the price comparison.

    Returns
    -------
    pd.Series of dtype float (NaN-compatible), same index as *df*.
    """
    if horizon < 1:
        raise ValueError(f"horizon must be >= 1, got {horizon}")
    if price_col not in df.columns:
        raise KeyError(f"price_col '{price_col}' not found in DataFrame")

    prices  = df[price_col].to_numpy(dtype=float)
    n       = len(prices)
    labels  = np.full(n, np.nan)

    for t in range(n - horizon):
        p0 = prices[t]
        pH = prices[t + horizon]
        if not (np.isfinite(p0) and np.isfinite(pH)) or p0 == 0:
            continue
        if pH > p0:
            labels[t] = 1.0
        elif pH < p0:
            labels[t] = -1.0
        else:
            labels[t] = 0.0

    return pd.Series(labels, index=df.index, dtype=float)


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


# ── P1 multiclass labels: SHORT(0) / NEUTRAL(1) / LONG(2) ─────────────────────

SHORT      = 0
NEUTRAL_P1 = 1
LONG       = 2


def build_p1_labels(
    df: pd.DataFrame,
    horizon: int,
    tau_up: float   = 0.003,
    tau_down: float = -0.003,
    open_col: str   = "open",
    close_col: str  = "close",
) -> pd.Series:
    """
    Build LONG(2) / NEUTRAL(1) / SHORT(0) labels for the P1 ML Signal Engine spec.

    Entry/exit (no lookahead):
        entry_price = open[t + 1]         (next bar's open — the realistic fill)
        exit_price  = close[t + horizon]

    net_return = (exit_price - entry_price) / entry_price

    Classes:
        LONG    = 2.0   if net_return >= tau_up
        SHORT   = 0.0   if net_return <= tau_down
        NEUTRAL = 1.0   otherwise
        NaN           for last *horizon* rows (no complete future window)

    Parameters
    ----------
    df        : DataFrame sorted ascending, with *open_col* and *close_col*.
    horizon   : Bars ahead for exit price (>= 1).
    tau_up    : Minimum return for LONG (e.g. 0.003 → +0.3 %).
    tau_down  : Maximum return for SHORT (e.g. -0.003 → -0.3 %).
    open_col  : Column name for open price.
    close_col : Column name for close price.

    Returns
    -------
    pd.Series of dtype float, same index as *df*.
    """
    if horizon < 1:
        raise ValueError(f"horizon must be >= 1, got {horizon}")
    if tau_up <= 0:
        raise ValueError(f"tau_up must be > 0, got {tau_up}")
    if tau_down >= 0:
        raise ValueError(f"tau_down must be < 0, got {tau_down}")
    if open_col not in df.columns:
        raise KeyError(f"open_col '{open_col}' not found in DataFrame")
    if close_col not in df.columns:
        raise KeyError(f"close_col '{close_col}' not found in DataFrame")

    opens  = df[open_col].to_numpy(dtype=float)
    closes = df[close_col].to_numpy(dtype=float)
    n      = len(df)
    labels = np.full(n, np.nan)

    for t in range(n - horizon):
        entry = opens[t + 1] if (t + 1) < n else np.nan
        exit_ = closes[t + horizon]

        if not (np.isfinite(entry) and np.isfinite(exit_)) or entry == 0:
            labels[t] = float(NEUTRAL_P1)
            continue

        net_ret = (exit_ - entry) / entry

        if net_ret >= tau_up:
            labels[t] = float(LONG)
        elif net_ret <= tau_down:
            labels[t] = float(SHORT)
        else:
            labels[t] = float(NEUTRAL_P1)

    labels[n - horizon:] = np.nan
    return pd.Series(labels, index=df.index, dtype=float)


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
