"""
Feature catalogue schema for the ML Signal Engine P1 feature set.

Provides a typed catalogue of all 30 features produced by feature_builder.py,
along with helpers to serialise / deserialise the catalogue as JSON.

Public API
----------
FEATURE_SCHEMA   : dict  — full catalogue keyed by feature name.
FEATURE_NAMES    : List[str] — ordered list matching ALL_FEATURE_NAMES in
                   feature_builder.py.

get_schema_json() -> str
    Return FEATURE_SCHEMA as a pretty-printed JSON string.

save_schema(output_dir: str) -> str
    Serialise FEATURE_SCHEMA to ``<output_dir>/feature_schema.json``.
    Returns the absolute path of the written file.

load_schema(path: str) -> dict
    Load a previously saved feature_schema.json.
    Raises FileNotFoundError if the file does not exist.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import List

# ---------------------------------------------------------------------------
# Catalogue
# ---------------------------------------------------------------------------

FEATURE_SCHEMA: dict = {
    # ── PRICE_ACTION ──────────────────────────────────────────────────────
    "ret_1": {
        "family":      "PRICE_ACTION",
        "description": "1-bar close-to-close return (pct_change).",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    False,
    },
    "ret_5": {
        "family":      "PRICE_ACTION",
        "description": "5-bar close-to-close return (pct_change).",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    False,
    },
    "ret_10": {
        "family":      "PRICE_ACTION",
        "description": "10-bar close-to-close return (pct_change).",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    False,
    },
    "log_return": {
        "family":      "PRICE_ACTION",
        "description": "Natural log of close[t] / close[t-1].",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    False,
    },
    "body_pct": {
        "family":      "PRICE_ACTION",
        "description": "(close - open) / close — signed; positive = bullish bar.",
        "dtype":       "float64",
        "range":       "[-1, +1]",
        "optional":    False,
    },
    "upper_wick_pct": {
        "family":      "PRICE_ACTION",
        "description": "(high - candle_top) / close — fraction of bar above the body.",
        "dtype":       "float64",
        "range":       "[0, +inf)",
        "optional":    False,
    },
    "lower_wick_pct": {
        "family":      "PRICE_ACTION",
        "description": "(candle_bottom - low) / close — fraction of bar below the body.",
        "dtype":       "float64",
        "range":       "[0, +inf)",
        "optional":    False,
    },
    "range_pct": {
        "family":      "PRICE_ACTION",
        "description": "(high - low) / close — total bar range as fraction of close.",
        "dtype":       "float64",
        "range":       "[0, +inf)",
        "optional":    False,
    },
    # ── VOLATILITY ────────────────────────────────────────────────────────
    "rolling_vol_5": {
        "family":      "VOLATILITY",
        "description": "5-bar rolling standard deviation of log returns (min_periods=2).",
        "dtype":       "float64",
        "range":       "[0, +inf)",
        "optional":    False,
    },
    "rolling_vol_20": {
        "family":      "VOLATILITY",
        "description": "20-bar rolling standard deviation of log returns (min_periods=2).",
        "dtype":       "float64",
        "range":       "[0, +inf)",
        "optional":    False,
    },
    "atr": {
        "family":      "VOLATILITY",
        "description": "EWM Average True Range (span=14, adjust=False). TR = max(H-L, |H-prevC|, |L-prevC|).",
        "dtype":       "float64",
        "range":       "[0, +inf)",
        "optional":    False,
    },
    # ── VOLUME ────────────────────────────────────────────────────────────
    "rvol": {
        "family":      "VOLUME",
        "description": "Relative volume: current bar volume / 20-bar rolling mean volume.",
        "dtype":       "float64",
        "range":       "[0, +inf)",
        "optional":    False,
    },
    "volume_zscore": {
        "family":      "VOLUME",
        "description": "(volume - mean_20) / std_20 — standardised volume anomaly.",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    False,
    },
    "volume_delta": {
        "family":      "VOLUME",
        "description": "Bar-over-bar raw volume change (signed difference).",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    False,
    },
    # ── VOLUME_PROFILE ────────────────────────────────────────────────────
    "dist_poc": {
        "family":      "VOLUME_PROFILE",
        "description": "(close - poc) / close — distance from Point of Control. Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    True,
    },
    "dist_vah": {
        "family":      "VOLUME_PROFILE",
        "description": "(close - vah) / close — distance from Value Area High. Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    True,
    },
    "dist_val": {
        "family":      "VOLUME_PROFILE",
        "description": "(close - val) / close — distance from Value Area Low. Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    True,
    },
    "inside_value_area": {
        "family":      "VOLUME_PROFILE",
        "description": "1.0 if val <= close <= vah, else 0.0. Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "{0.0, 1.0}",
        "optional":    True,
    },
    # ── ORDERFLOW ─────────────────────────────────────────────────────────
    "spread": {
        "family":      "ORDERFLOW",
        "description": "Best ask minus best bid (ask - bid). Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "[0, +inf)",
        "optional":    True,
    },
    "mid_price": {
        "family":      "ORDERFLOW",
        "description": "(ask + bid) / 2. Fallback: close.",
        "dtype":       "float64",
        "range":       "(0, +inf)",
        "optional":    True,
    },
    "queue_imbalance": {
        "family":      "ORDERFLOW",
        "description": "(bid_size - ask_size) / (bid_size + ask_size) — signed queue depth imbalance. Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "[-1, +1]",
        "optional":    True,
    },
    "bid_ask_pressure": {
        "family":      "ORDERFLOW",
        "description": "5-bar rolling (sum bid-ask net) / (sum total size) — sustained directional pressure. Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "[-1, +1]",
        "optional":    True,
    },
    # ── FOOTPRINT ─────────────────────────────────────────────────────────
    "cvd": {
        "family":      "FOOTPRINT",
        "description": "Raw Cumulative Volume Delta series from the CVD column. Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    True,
    },
    "cvd_slope": {
        "family":      "FOOTPRINT",
        "description": "cvd.diff(5) / 5-bar mean volume — rate of change of CVD. Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "(-inf, +inf)",
        "optional":    True,
    },
    "footprint_imbalance_count": {
        "family":      "FOOTPRINT",
        "description": "Rolling 5-bar sum of per-bar footprint imbalance (+1/-1/0). Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "[-5, +5]",
        "optional":    True,
    },
    "stacked_imbalance": {
        "family":      "FOOTPRINT",
        "description": "+1 if last 3 bars all bullish footprint imbalance; -1 if all bearish; 0 otherwise. Fallback: 0.0.",
        "dtype":       "float64",
        "range":       "{-1.0, 0.0, +1.0}",
        "optional":    True,
    },
    # ── SESSION ───────────────────────────────────────────────────────────
    "hour_sin": {
        "family":      "SESSION",
        "description": "sin(2π × fractional_hour / 24) — cyclical hour-of-day encoding.",
        "dtype":       "float64",
        "range":       "[-1, +1]",
        "optional":    False,
    },
    "hour_cos": {
        "family":      "SESSION",
        "description": "cos(2π × fractional_hour / 24) — cyclical hour-of-day encoding.",
        "dtype":       "float64",
        "range":       "[-1, +1]",
        "optional":    False,
    },
    "day_sin": {
        "family":      "SESSION",
        "description": "sin(2π × day_of_week / 7) — cyclical weekday encoding (0=Mon … 6=Sun).",
        "dtype":       "float64",
        "range":       "[-1, +1]",
        "optional":    False,
    },
    "day_cos": {
        "family":      "SESSION",
        "description": "cos(2π × day_of_week / 7) — cyclical weekday encoding (0=Mon … 6=Sun).",
        "dtype":       "float64",
        "range":       "[-1, +1]",
        "optional":    False,
    },
}

# Ordered list of feature names — same order as ALL_FEATURE_NAMES in feature_builder.py
FEATURE_NAMES: List[str] = [
    # PRICE_ACTION
    "ret_1", "ret_5", "ret_10", "log_return",
    "body_pct", "upper_wick_pct", "lower_wick_pct", "range_pct",
    # VOLATILITY
    "rolling_vol_5", "rolling_vol_20", "atr",
    # VOLUME
    "rvol", "volume_zscore", "volume_delta",
    # VOLUME_PROFILE
    "dist_poc", "dist_vah", "dist_val", "inside_value_area",
    # ORDERFLOW
    "spread", "mid_price", "queue_imbalance", "bid_ask_pressure",
    # FOOTPRINT
    "cvd", "cvd_slope", "footprint_imbalance_count", "stacked_imbalance",
    # SESSION
    "hour_sin", "hour_cos", "day_sin", "day_cos",
]

# Sanity check at import time: every entry in FEATURE_NAMES must be in the catalogue
_missing = [f for f in FEATURE_NAMES if f not in FEATURE_SCHEMA]
if _missing:
    raise RuntimeError(  # pragma: no cover
        f"feature_schema.py internal error — FEATURE_NAMES contains names absent "
        f"from FEATURE_SCHEMA: {_missing}"
    )


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def get_schema_json() -> str:
    """Return FEATURE_SCHEMA serialised as a pretty-printed JSON string."""
    return json.dumps(FEATURE_SCHEMA, indent=2)


def save_schema(output_dir: str) -> str:
    """
    Serialise FEATURE_SCHEMA to ``<output_dir>/feature_schema.json``.

    Parameters
    ----------
    output_dir : str
        Directory where the file is written.  Created if it does not exist.

    Returns
    -------
    str — absolute path of the written file.
    """
    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, "feature_schema.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(get_schema_json())
        fh.write("\n")
    return os.path.abspath(out_path)


def load_schema(path: str) -> dict:
    """
    Load a previously saved ``feature_schema.json`` file.

    Parameters
    ----------
    path : str
        Absolute or relative path to the JSON file.

    Returns
    -------
    dict — the parsed feature catalogue.

    Raises
    ------
    FileNotFoundError
        If *path* does not exist on the filesystem.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Feature schema file not found: {path!r}")
    with p.open("r", encoding="utf-8") as fh:
        return json.load(fh)
