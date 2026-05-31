"""
Shared pytest fixtures for the ML Signal Engine test suite.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

# Make training and inference modules importable
_TRAINING_DIR  = Path(__file__).parent.parent / "server" / "ai" / "training"
_INFERENCE_DIR = Path(__file__).parent.parent / "server" / "ai" / "inference"
sys.path.insert(0, str(_TRAINING_DIR))
sys.path.insert(0, str(_INFERENCE_DIR))


# ── Synthetic price DataFrames ─────────────────────────────────────────────────

@pytest.fixture
def monotone_up_df():
    """100-row DataFrame with monotonically increasing close prices."""
    prices = np.arange(100.0, 200.0)
    return pd.DataFrame({
        "open":   prices - 0.5,
        "high":   prices + 1.0,
        "low":    prices - 1.0,
        "close":  prices,
        "volume": np.ones(100) * 10_000,
    })


@pytest.fixture
def flat_df():
    """100-row DataFrame with flat price (all returns = 0 → NEUTRAL)."""
    prices = np.full(100, 150.0)
    return pd.DataFrame({
        "open":   prices,
        "high":   prices + 0.01,
        "low":    prices - 0.01,
        "close":  prices,
        "volume": np.ones(100) * 5_000,
    })


@pytest.fixture
def random_ohlcv_df():
    """200-row synthetic OHLCV with realistic structure and all P1 columns."""
    rng    = np.random.default_rng(0)
    n      = 200
    prices = 100 + np.cumsum(rng.normal(0, 0.2, n))
    vol    = rng.integers(5_000, 20_000, n).astype(float)
    df = pd.DataFrame({
        "open":   prices - rng.uniform(0, 0.5, n),
        "high":   prices + rng.uniform(0, 1.0, n),
        "low":    prices - rng.uniform(0, 1.0, n),
        "close":  prices,
        "volume": vol,
        "vwap":   prices * (1 + rng.uniform(-0.002, 0.002, n)),
        "rsi_14": rng.uniform(20, 80, n),
        "ema_9":  prices * (1 + rng.uniform(-0.01, 0.01, n)),
        "ema_20": prices * (1 + rng.uniform(-0.02, 0.02, n)),
        "cvd":    np.cumsum(rng.normal(0, 500, n)),
        "poc":    prices * (1 + rng.uniform(-0.005, 0.005, n)),
        "ask_vol": vol * rng.uniform(0.4, 0.6, n),
        "bid_vol": vol * rng.uniform(0.4, 0.6, n),
        "footprint_imbalance": rng.choice([-1, 0, 1], n).astype(float),
    })
    df.index = pd.date_range("2024-01-01 09:30", periods=n, freq="1min")
    return df
