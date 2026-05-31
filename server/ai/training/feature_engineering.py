"""
Feature engineering — P1 feature set for the intraday ML Signal Engine.

All features are computed strictly as-of time t: rolling windows and lookbacks
only reference data at indices ≤ t.  No forward-fill is applied after the
feature horizon; callers are responsible for dropping rows with NaN features.

Expected input columns (lowercase):
    open, high, low, close, volume   (required)
    vwap                             (optional — distance feature falls back to 0)
    rsi_14                           (optional — computed if absent)
    ema_9, ema_20                    (optional — computed if absent)
    cvd                              (optional — CVD feature falls back to 0)
    ask_vol, bid_vol                 (optional — orderflow imbalance falls back to 0)
    poc                              (optional — distance to POC falls back to 0)
"""

import warnings

import numpy as np
import pandas as pd

# ── Public API ─────────────────────────────────────────────────────────────────

FEATURE_NAMES_P1 = [
    "rsi_14",
    "ema_delta",
    "volume_ratio",
    "momentum_1",
    "momentum_5",
    "volatility_20",
    "vwap_distance",
    "dist_to_poc",
    "cvd_normalized",
    "orderflow_imbalance",
    "footprint_imbalance_recent",
]


def compute_features(df: pd.DataFrame, feature_names=None) -> pd.DataFrame:
    """
    Compute the P1 feature set from an OHLCV(-plus) DataFrame.

    Parameters
    ----------
    df            : DataFrame sorted ascending by time with lowercase column names.
    feature_names : Subset of FEATURE_NAMES_P1 to compute (all if None).

    Returns
    -------
    pd.DataFrame of the same length as *df*, indexed identically, containing
    only the requested feature columns.  Rows with any NaN are retained here;
    the caller should call .dropna() after label alignment.
    """
    requested = set(feature_names or FEATURE_NAMES_P1)
    out = pd.DataFrame(index=df.index)

    close  = df["close"].astype(float)
    volume = df["volume"].astype(float)

    # ── RSI(14) ────────────────────────────────────────────────────────────────
    if "rsi_14" in requested:
        if "rsi_14" in df.columns:
            out["rsi_14"] = df["rsi_14"].astype(float) / 100.0  # normalise 0→1
        else:
            out["rsi_14"] = _rsi(close, period=14) / 100.0

    # ── EMA delta = (EMA9 − EMA20) / close ────────────────────────────────────
    if "ema_delta" in requested:
        ema9  = df["ema_9"].astype(float)  if "ema_9"  in df.columns else _ema(close, 9)
        ema20 = df["ema_20"].astype(float) if "ema_20" in df.columns else _ema(close, 20)
        out["ema_delta"] = (ema9 - ema20) / close.replace(0, np.nan)

    # ── Volume ratio = volume / SMA(volume, 20) ───────────────────────────────
    if "volume_ratio" in requested:
        vol_ma = volume.rolling(20, min_periods=1).mean().replace(0, np.nan)
        out["volume_ratio"] = volume / vol_ma

    # ── Short-term momentum = (close_t − close_{t-1}) / close_{t-1} ──────────
    if "momentum_1" in requested:
        out["momentum_1"] = close.pct_change(1)

    # ── Medium-term momentum = (close_t − close_{t-5}) / close_{t-5} ─────────
    if "momentum_5" in requested:
        out["momentum_5"] = close.pct_change(5)

    # ── Rolling 20-bar return volatility ─────────────────────────────────────
    if "volatility_20" in requested:
        out["volatility_20"] = close.pct_change().rolling(20, min_periods=2).std()

    # ── VWAP distance = (close − VWAP) / close ───────────────────────────────
    if "vwap_distance" in requested:
        if "vwap" in df.columns:
            vwap = df["vwap"].astype(float)
            out["vwap_distance"] = (close - vwap) / close.replace(0, np.nan)
        else:
            out["vwap_distance"] = 0.0

    # ── Distance to Volume Profile POC ────────────────────────────────────────
    if "dist_to_poc" in requested:
        if "poc" in df.columns:
            poc = df["poc"].astype(float)
            out["dist_to_poc"] = (close - poc) / close.replace(0, np.nan)
        else:
            out["dist_to_poc"] = 0.0

    # ── CVD normalised by 20-bar average volume ───────────────────────────────
    if "cvd_normalized" in requested:
        if "cvd" in df.columns:
            cvd    = df["cvd"].astype(float)
            vol_ma = volume.rolling(20, min_periods=1).mean().replace(0, np.nan)
            out["cvd_normalized"] = cvd / vol_ma
        else:
            out["cvd_normalized"] = 0.0

    # ── Orderflow imbalance = (ask_vol − bid_vol) / total_vol ─────────────────
    if "orderflow_imbalance" in requested:
        if "ask_vol" in df.columns and "bid_vol" in df.columns:
            ask = df["ask_vol"].astype(float)
            bid = df["bid_vol"].astype(float)
            total = (ask + bid).replace(0, np.nan)
            out["orderflow_imbalance"] = (ask - bid) / total
        else:
            out["orderflow_imbalance"] = 0.0

    # ── Footprint bullish imbalance (rolling 5 bars, fraction bullish) ────────
    if "footprint_imbalance_recent" in requested:
        if "footprint_imbalance" in df.columns:
            # Expect +1 bullish, −1 bearish, 0 neutral (or NaN)
            fi = df["footprint_imbalance"].astype(float)
            bullish = (fi > 0).astype(float)
            out["footprint_imbalance_recent"] = bullish.rolling(5, min_periods=1).mean()
        else:
            out["footprint_imbalance_recent"] = 0.0

    return out


# ── Private helpers ────────────────────────────────────────────────────────────

def _rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Wilder's RSI using exponential smoothing."""
    delta = series.diff()
    gain  = delta.clip(lower=0)
    loss  = (-delta).clip(lower=0)
    alpha = 1.0 / period
    avg_gain = gain.ewm(alpha=alpha, adjust=False).mean()
    avg_loss = loss.ewm(alpha=alpha, adjust=False).mean()
    rs  = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    return rsi.fillna(50.0)


def _ema(series: pd.Series, span: int) -> pd.Series:
    """Standard exponential moving average."""
    return series.ewm(span=span, adjust=False).mean()
