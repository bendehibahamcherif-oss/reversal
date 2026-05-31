"""
Feature builder — 30-feature engineering module for the ML Signal Engine.

All features are computed strictly as-of time t: every rolling window,
lookback, and shift references only indices <= t.  No lookahead.

Input DataFrame must be sorted ascending by time and have a DatetimeIndex
for the SESSION family to be non-zero.

Required columns (lowercase):
    open, high, low, close, volume

Optional columns (graceful fallback to 0.0 when absent):
    poc, vah, val            — Volume Profile levels (VOLUME_PROFILE family)
    ask, bid                 — Best-quote columns    (ORDERFLOW family)
    ask_size, bid_size       — Quote sizes            (ORDERFLOW family)
    cvd                      — Cumulative Volume Delta (FOOTPRINT family)
    footprint_imbalance      — Per-bar footprint imbalance (+1/-1/0) (FOOTPRINT family)

Public API
----------
ALL_FEATURE_NAMES : List[str]
    Ordered list of every feature name produced by this module (30 total).

FEATURE_FAMILIES : Dict[str, List[str]]
    Maps family label → list of feature names belonging to that family.

build_features(df, feature_names=None) -> pd.DataFrame
    Compute features; returns a DataFrame with the same index as *df*.
    Optional columns fall back to 0.0 — never raises on absent optional cols.
"""

from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Feature catalogue
# ---------------------------------------------------------------------------

FEATURE_FAMILIES: Dict[str, List[str]] = {
    "PRICE_ACTION": [
        "ret_1",
        "ret_5",
        "ret_10",
        "log_return",
        "body_pct",
        "upper_wick_pct",
        "lower_wick_pct",
        "range_pct",
    ],
    "VOLATILITY": [
        "rolling_vol_5",
        "rolling_vol_20",
        "atr",
    ],
    "VOLUME": [
        "rvol",
        "volume_zscore",
        "volume_delta",
    ],
    "VOLUME_PROFILE": [
        "dist_poc",
        "dist_vah",
        "dist_val",
        "inside_value_area",
    ],
    "ORDERFLOW": [
        "spread",
        "mid_price",
        "queue_imbalance",
        "bid_ask_pressure",
    ],
    "FOOTPRINT": [
        "cvd",
        "cvd_slope",
        "footprint_imbalance_count",
        "stacked_imbalance",
    ],
    "SESSION": [
        "hour_sin",
        "hour_cos",
        "day_sin",
        "day_cos",
    ],
}

ALL_FEATURE_NAMES: List[str] = [
    feat
    for family_feats in FEATURE_FAMILIES.values()
    for feat in family_feats
]


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def build_features(
    df: pd.DataFrame,
    feature_names: Optional[List[str]] = None,
) -> pd.DataFrame:
    """
    Compute the ML Signal Engine feature set from an OHLCV(+) DataFrame.

    All 30 features span 7 families (PRICE_ACTION, VOLATILITY, VOLUME,
    VOLUME_PROFILE, ORDERFLOW, FOOTPRINT, SESSION).  Every computation is
    strictly as-of-t — no forward-looking operations.

    Parameters
    ----------
    df : pd.DataFrame
        Input data sorted ascending by time.  Must contain at minimum the
        columns ``open``, ``high``, ``low``, ``close``, ``volume`` (all
        lowercase).  A DatetimeIndex is strongly recommended so that the
        SESSION family features are meaningful; a plain RangeIndex will
        cause all SESSION features to fall back to 0.0 without error.
    feature_names : list of str, optional
        Subset of ``ALL_FEATURE_NAMES`` to compute.  When *None* (default)
        all 30 features are computed.

    Returns
    -------
    pd.DataFrame
        Same index as *df*, one column per requested feature.  Rows with
        NaN are *not* dropped here — the caller should handle that after
        aligning with labels.

    Raises
    ------
    KeyError
        If any of the required base columns (open / high / low / close /
        volume) are missing from *df*.
    ValueError
        If *feature_names* contains names not in ``ALL_FEATURE_NAMES``.

    Notes
    -----
    * All optional-column fallbacks emit no warnings — missing columns are
      silently replaced with zeros.
    * EWM ATR uses ``adjust=False`` and ``min_periods=1`` so the first row
      is never NaN.
    * ``mid_price`` falls back to ``close`` (not 0.0) when ask/bid are absent.
    """
    requested: set[str] = set(
        feature_names if feature_names is not None else ALL_FEATURE_NAMES
    )

    unknown = requested - set(ALL_FEATURE_NAMES)
    if unknown:
        raise ValueError(f"Unknown feature name(s): {sorted(unknown)}")

    _require_columns(df, ["open", "high", "low", "close", "volume"])

    out = pd.DataFrame(index=df.index)

    # Cast required columns once to float Series
    o = df["open"].astype(float)
    h = df["high"].astype(float)
    l = df["low"].astype(float)
    c = df["close"].astype(float)
    v = df["volume"].astype(float)

    _build_price_action(out, o, h, l, c, requested)
    _build_volatility(out, h, l, c, requested)
    _build_volume(out, v, requested)
    _build_volume_profile(out, c, df, requested)
    _build_orderflow(out, c, df, requested)
    _build_footprint(out, v, df, requested)
    _build_session(out, df.index, requested)

    # Return only the requested columns in the canonical catalogue order
    ordered_cols = [f for f in ALL_FEATURE_NAMES if f in requested]
    return out[ordered_cols]


# ---------------------------------------------------------------------------
# Family builders (private)
# ---------------------------------------------------------------------------

def _build_price_action(
    out: pd.DataFrame,
    o: pd.Series,
    h: pd.Series,
    l: pd.Series,
    c: pd.Series,
    requested: set,
) -> None:
    """
    Populate PRICE_ACTION features into *out* in-place.

    Features
    --------
    ret_1         : 1-bar close-to-close return.
    ret_5         : 5-bar close-to-close return.
    ret_10        : 10-bar close-to-close return.
    log_return    : Natural log of close[t] / close[t-1].
    body_pct      : (close - open) / close  — signed (+ bullish, - bearish).
    upper_wick_pct: (high - candle_top) / close.
    lower_wick_pct: (candle_bottom - low) / close.
    range_pct     : (high - low) / close.
    """
    safe_c = c.replace(0, np.nan)
    candle_range = (h - l).replace(0, np.nan)

    if "ret_1" in requested:
        out["ret_1"] = c.pct_change(1)

    if "ret_5" in requested:
        out["ret_5"] = c.pct_change(5)

    if "ret_10" in requested:
        out["ret_10"] = c.pct_change(10)

    if "log_return" in requested:
        out["log_return"] = np.log(c / c.shift(1))

    if "body_pct" in requested:
        out["body_pct"] = (c - o) / safe_c

    if "upper_wick_pct" in requested:
        candle_top = c.combine(o, max)
        out["upper_wick_pct"] = (h - candle_top) / safe_c

    if "lower_wick_pct" in requested:
        candle_bottom = c.combine(o, min)
        out["lower_wick_pct"] = (candle_bottom - l) / safe_c

    if "range_pct" in requested:
        out["range_pct"] = candle_range / safe_c


def _build_volatility(
    out: pd.DataFrame,
    h: pd.Series,
    l: pd.Series,
    c: pd.Series,
    requested: set,
) -> None:
    """
    Populate VOLATILITY features into *out* in-place.

    Features
    --------
    rolling_vol_5  : 5-bar rolling std of log returns (min_periods=2).
    rolling_vol_20 : 20-bar rolling std of log returns (min_periods=2).
    atr            : EWM ATR with span=14 (adjust=False, min_periods=1).
                     True Range = max(H-L, |H-prev_C|, |L-prev_C|).
    """
    log_ret = np.log(c / c.shift(1))

    if "rolling_vol_5" in requested:
        out["rolling_vol_5"] = log_ret.rolling(5, min_periods=2).std()

    if "rolling_vol_20" in requested:
        out["rolling_vol_20"] = log_ret.rolling(20, min_periods=2).std()

    if "atr" in requested:
        prev_c = c.shift(1)
        tr = pd.concat(
            [
                (h - l),
                (h - prev_c).abs(),
                (l - prev_c).abs(),
            ],
            axis=1,
        ).max(axis=1)
        out["atr"] = tr.ewm(span=14, adjust=False, min_periods=1).mean()


def _build_volume(
    out: pd.DataFrame,
    v: pd.Series,
    requested: set,
) -> None:
    """
    Populate VOLUME features into *out* in-place.

    Features
    --------
    rvol          : volume / 20-bar rolling mean (relative volume).
    volume_zscore : (volume - mean_20) / std_20.
    volume_delta  : bar-over-bar raw volume change (signed).
    """
    vol_mean20 = v.rolling(20, min_periods=1).mean().replace(0, np.nan)
    vol_std20 = v.rolling(20, min_periods=2).std().replace(0, np.nan)

    if "rvol" in requested:
        out["rvol"] = v / vol_mean20

    if "volume_zscore" in requested:
        out["volume_zscore"] = (v - vol_mean20) / vol_std20

    if "volume_delta" in requested:
        out["volume_delta"] = v.diff(1)


def _build_volume_profile(
    out: pd.DataFrame,
    c: pd.Series,
    df: pd.DataFrame,
    requested: set,
) -> None:
    """
    Populate VOLUME_PROFILE features into *out* in-place.

    All four features fall back to 0.0 if the corresponding level columns
    (poc, vah, val) are absent from *df*.

    Features
    --------
    dist_poc          : (close - poc) / close.  Fallback: 0.0.
    dist_vah          : (close - vah) / close.  Fallback: 0.0.
    dist_val          : (close - val) / close.  Fallback: 0.0.
    inside_value_area : 1.0 if val <= close <= vah, else 0.0.  Fallback: 0.0.
    """
    has_poc = "poc" in df.columns
    has_vah = "vah" in df.columns
    has_val = "val" in df.columns

    safe_c = c.replace(0, np.nan)

    if "dist_poc" in requested:
        if has_poc:
            poc = df["poc"].astype(float)
            out["dist_poc"] = (c - poc) / safe_c
        else:
            out["dist_poc"] = 0.0

    if "dist_vah" in requested:
        if has_vah:
            vah = df["vah"].astype(float)
            out["dist_vah"] = (c - vah) / safe_c
        else:
            out["dist_vah"] = 0.0

    if "dist_val" in requested:
        if has_val:
            val_ = df["val"].astype(float)
            out["dist_val"] = (c - val_) / safe_c
        else:
            out["dist_val"] = 0.0

    if "inside_value_area" in requested:
        if has_vah and has_val:
            vah = df["vah"].astype(float)
            val_ = df["val"].astype(float)
            out["inside_value_area"] = ((c >= val_) & (c <= vah)).astype(float)
        else:
            out["inside_value_area"] = 0.0


def _build_orderflow(
    out: pd.DataFrame,
    c: pd.Series,
    df: pd.DataFrame,
    requested: set,
) -> None:
    """
    Populate ORDERFLOW features into *out* in-place.

    Fallback behaviour when optional columns are absent:
        spread           → 0.0
        mid_price        → close  (not 0 — close is a better neutral proxy)
        queue_imbalance  → 0.0
        bid_ask_pressure → 0.0

    Features
    --------
    spread           : ask - bid.
    mid_price        : (ask + bid) / 2.
    queue_imbalance  : (bid_size - ask_size) / (bid_size + ask_size).
    bid_ask_pressure : 5-bar rolling (sum bid-ask net) / (sum total size).
    """
    has_ask = "ask" in df.columns
    has_bid = "bid" in df.columns
    has_ask_size = "ask_size" in df.columns
    has_bid_size = "bid_size" in df.columns

    if "spread" in requested:
        if has_ask and has_bid:
            ask = df["ask"].astype(float)
            bid = df["bid"].astype(float)
            out["spread"] = ask - bid
        else:
            out["spread"] = 0.0

    if "mid_price" in requested:
        if has_ask and has_bid:
            ask = df["ask"].astype(float)
            bid = df["bid"].astype(float)
            out["mid_price"] = (ask + bid) / 2.0
        else:
            out["mid_price"] = c

    if "queue_imbalance" in requested:
        if has_ask_size and has_bid_size:
            ask_sz = df["ask_size"].astype(float)
            bid_sz = df["bid_size"].astype(float)
            total = (ask_sz + bid_sz).replace(0, np.nan)
            out["queue_imbalance"] = (bid_sz - ask_sz) / total
        else:
            out["queue_imbalance"] = 0.0

    if "bid_ask_pressure" in requested:
        if has_ask_size and has_bid_size:
            ask_sz = df["ask_size"].astype(float)
            bid_sz = df["bid_size"].astype(float)
            net = bid_sz - ask_sz
            total_roll = (
                (bid_sz + ask_sz).rolling(5, min_periods=1).sum().replace(0, np.nan)
            )
            out["bid_ask_pressure"] = net.rolling(5, min_periods=1).sum() / total_roll
        else:
            out["bid_ask_pressure"] = 0.0


def _build_footprint(
    out: pd.DataFrame,
    v: pd.Series,
    df: pd.DataFrame,
    requested: set,
) -> None:
    """
    Populate FOOTPRINT features into *out* in-place.

    All features fall back to 0.0 if ``cvd`` or ``footprint_imbalance``
    columns are absent.

    Features
    --------
    cvd                      : Raw cumulative volume delta series.
    cvd_slope                : cvd.diff(5) / 5-bar mean volume.
    footprint_imbalance_count: Rolling 5-bar sum of footprint_imbalance (+1/-1/0).
    stacked_imbalance        : +1 if last 3 bars all bullish imbalance,
                               -1 if last 3 bars all bearish imbalance,
                               0 otherwise.
    """
    has_cvd = "cvd" in df.columns
    has_fi = "footprint_imbalance" in df.columns

    vol_mean5 = v.rolling(5, min_periods=1).mean().replace(0, np.nan)

    if "cvd" in requested:
        if has_cvd:
            out["cvd"] = df["cvd"].astype(float)
        else:
            out["cvd"] = 0.0

    if "cvd_slope" in requested:
        if has_cvd:
            cvd_series = df["cvd"].astype(float)
            out["cvd_slope"] = cvd_series.diff(5) / vol_mean5
        else:
            out["cvd_slope"] = 0.0

    if "footprint_imbalance_count" in requested:
        if has_fi:
            fi = df["footprint_imbalance"].astype(float)
            out["footprint_imbalance_count"] = fi.rolling(5, min_periods=1).sum()
        else:
            out["footprint_imbalance_count"] = 0.0

    if "stacked_imbalance" in requested:
        if has_fi:
            fi = df["footprint_imbalance"].astype(float)
            out["stacked_imbalance"] = _stacked_imbalance(fi, streak_len=3)
        else:
            out["stacked_imbalance"] = 0.0


def _build_session(
    out: pd.DataFrame,
    index: pd.Index,
    requested: set,
) -> None:
    """
    Populate SESSION features (cyclical time encodings) into *out* in-place.

    Requires a DatetimeIndex.  Falls back to 0.0 silently if the index is
    not datetime-like.

    Features
    --------
    hour_sin : sin(2π * fractional_hour / 24)
    hour_cos : cos(2π * fractional_hour / 24)
    day_sin  : sin(2π * day_of_week / 7)   (0=Mon … 6=Sun)
    day_cos  : cos(2π * day_of_week / 7)
    """
    is_datetime = isinstance(index, pd.DatetimeIndex)

    if not is_datetime:
        for feat in ("hour_sin", "hour_cos", "day_sin", "day_cos"):
            if feat in requested:
                out[feat] = 0.0
        return

    hour = index.hour + index.minute / 60.0   # fractional hour [0, 24)
    dow = index.dayofweek.astype(float)        # 0=Monday … 6=Sunday

    if "hour_sin" in requested:
        out["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)

    if "hour_cos" in requested:
        out["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)

    if "day_sin" in requested:
        out["day_sin"] = np.sin(2 * np.pi * dow / 7.0)

    if "day_cos" in requested:
        out["day_cos"] = np.cos(2 * np.pi * dow / 7.0)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _require_columns(df: pd.DataFrame, cols: List[str]) -> None:
    """Raise KeyError listing all *cols* absent from *df*."""
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise KeyError(f"Required column(s) missing from DataFrame: {missing}")


def _stacked_imbalance(fi: pd.Series, streak_len: int = 3) -> pd.Series:
    """
    Return +1 where the last *streak_len* footprint_imbalance values are all
    bullish (> 0), -1 where all are bearish (< 0), and 0 otherwise.

    Implemented with rolling min/max to stay vectorised; no Python loop.

    Parameters
    ----------
    fi         : Series of footprint imbalance values (+1, -1, 0).
    streak_len : Minimum consecutive same-sign bars to trigger (default 3).

    Returns
    -------
    pd.Series of float {-1.0, 0.0, +1.0}, same index as *fi*.
    """
    bull = (fi > 0).astype(float)
    bear = (fi < 0).astype(float)

    # rolling min equals 1 only when every window bar was 1
    bull_streak = bull.rolling(streak_len, min_periods=streak_len).min()
    bear_streak = bear.rolling(streak_len, min_periods=streak_len).min()

    result = pd.Series(0.0, index=fi.index)
    result = result.where(bull_streak != 1.0, 1.0)
    result = result.where(bear_streak != 1.0, -1.0)
    return result
