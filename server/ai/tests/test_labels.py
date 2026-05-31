"""
Tests for label_builder.py — covering make_labels, create_labels,
and the P1 label builder (build_p1_labels).

Path setup:  label_builder lives at
    /home/user/reversal/server/ai/training/label_builder.py

build_p1_labels specification
-------------------------------
Signature: build_p1_labels(df, horizon, tau_up, tau_down) -> pd.Series

- entry_price = open[t+1]  (open of the NEXT candle, i.e. open.shift(-1))
- exit_price  = close[t+horizon]
- net_return  = (exit_price - entry_price) / entry_price
- LONG    = 2   if net_return >= tau_up
- SHORT   = 0   if net_return <= tau_down
- NEUTRAL = 1   otherwise
- Last `horizon` rows → NaN (no future close available)
- Also NaN when entry_price is 0 or either price is non-finite

The tests use a *reference implementation* (_ref_build_p1_labels) defined
in this module.  They test the reference directly (always runs) and, when
build_p1_labels is present in label_builder, they verify the real
implementation matches the reference on every synthetic dataset.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

# ── Path setup ────────────────────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent.parent / "training"))

from label_builder import create_labels, make_labels  # noqa: E402

# Try to import the real build_p1_labels — gracefully absent
try:
    from label_builder import build_p1_labels as _real_build_p1_labels  # type: ignore

    _HAS_REAL = True
except ImportError:
    _HAS_REAL = False


# ── Reference implementation ──────────────────────────────────────────────────

def _ref_build_p1_labels(
    df: pd.DataFrame,
    horizon: int,
    tau_up: float,
    tau_down: float,
    open_col: str = "open",
    close_col: str = "close",
) -> pd.Series:
    """
    Pure-Python reference for build_p1_labels.

    Label encoding:
        LONG    = 2
        NEUTRAL = 1
        SHORT   = 0
        NaN     = NaN  (last horizon rows, or invalid prices)
    """
    if horizon < 1:
        raise ValueError(f"horizon must be >= 1, got {horizon}")

    opens  = df[open_col].to_numpy(dtype=float)
    closes = df[close_col].to_numpy(dtype=float)
    n      = len(df)
    labels = np.full(n, np.nan)

    # Valid rows: 0 .. n-horizon-1 (need open[t+1] and close[t+horizon])
    for t in range(n - horizon):
        entry = opens[t + 1]        # open of next candle
        exit_ = closes[t + horizon] # close at horizon

        if not (np.isfinite(entry) and np.isfinite(exit_)) or entry == 0:
            continue

        net_ret = (exit_ - entry) / entry

        if net_ret >= tau_up:
            labels[t] = 2.0   # LONG
        elif net_ret <= tau_down:
            labels[t] = 0.0   # SHORT
        else:
            labels[t] = 1.0   # NEUTRAL

    return pd.Series(labels, index=df.index, dtype=float)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _make_ohlcv(
    n: int = 50,
    base_price: float = 100.0,
    freq: str = "1min",
) -> pd.DataFrame:
    """Return a synthetic OHLCV DataFrame with a DatetimeIndex."""
    idx = pd.date_range("2024-01-02 09:00", periods=n, freq=freq)
    rng = np.random.default_rng(seed=42)
    noise = rng.normal(0, 0.001, n)
    close = base_price * np.cumprod(1 + noise)
    open_ = np.roll(close, 1)
    open_[0] = close[0]
    high  = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.0005, n)))
    low   = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.0005, n)))
    vol   = rng.integers(1000, 10000, n).astype(float)
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": vol},
        index=idx,
    )


def _make_flat_ohlcv(n: int = 30, price: float = 100.0) -> pd.DataFrame:
    """OHLCV where open == high == low == close == price for every bar."""
    idx = pd.date_range("2024-01-02 09:00", periods=n, freq="1min")
    return pd.DataFrame(
        {
            "open":   np.full(n, price),
            "high":   np.full(n, price),
            "low":    np.full(n, price),
            "close":  np.full(n, price),
            "volume": np.ones(n) * 1000.0,
        },
        index=idx,
    )


def _make_trending_ohlcv(
    n: int = 50,
    start: float = 100.0,
    step: float = 0.5,
) -> pd.DataFrame:
    """OHLCV with strictly increasing prices (step per bar)."""
    idx    = pd.date_range("2024-01-02 09:00", periods=n, freq="1min")
    prices = start + np.arange(n) * step
    return pd.DataFrame(
        {
            "open":   prices,
            "high":   prices + 0.1,
            "low":    prices - 0.1,
            "close":  prices,
            "volume": np.ones(n) * 1000.0,
        },
        index=idx,
    )


def _make_falling_ohlcv(
    n: int = 50,
    start: float = 100.0,
    step: float = 0.5,
) -> pd.DataFrame:
    """OHLCV with strictly decreasing prices (step per bar)."""
    idx    = pd.date_range("2024-01-02 09:00", periods=n, freq="1min")
    prices = start - np.arange(n) * step
    return pd.DataFrame(
        {
            "open":   prices,
            "high":   prices + 0.1,
            "low":    prices - 0.1,
            "close":  prices,
            "volume": np.ones(n) * 1000.0,
        },
        index=idx,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1: Tests for make_labels
# ═══════════════════════════════════════════════════════════════════════════════

class TestMakeLabels:
    """Tests for make_labels(df, horizon, price_col) → Series of +1/-1/0/NaN."""

    def test_returns_series_same_length(self):
        df     = _make_ohlcv(40)
        labels = make_labels(df, horizon=5)
        assert isinstance(labels, pd.Series)
        assert len(labels) == len(df)
        assert labels.index.equals(df.index)

    def test_last_horizon_rows_nan(self):
        df      = _make_ohlcv(40)
        horizon = 5
        labels  = make_labels(df, horizon=horizon)
        assert labels.iloc[-horizon:].isna().all(), (
            "Last horizon rows must all be NaN"
        )

    def test_up_label_when_price_rises(self):
        df = _make_trending_ohlcv(n=30, start=100.0, step=1.0)
        labels = make_labels(df, horizon=3)
        # All non-tail rows should be +1 (price is strictly increasing)
        valid = labels.dropna()
        assert (valid == 1.0).all(), f"Expected all +1, got: {valid.unique()}"

    def test_down_label_when_price_falls(self):
        df = _make_falling_ohlcv(n=30, start=100.0, step=1.0)
        labels = make_labels(df, horizon=3)
        valid = labels.dropna()
        assert (valid == -1.0).all(), f"Expected all -1, got: {valid.unique()}"

    def test_zero_label_for_flat_price(self):
        df     = _make_flat_ohlcv(n=20, price=100.0)
        labels = make_labels(df, horizon=3)
        valid  = labels.dropna()
        assert (valid == 0.0).all(), f"Expected all 0, got: {valid.unique()}"

    def test_invalid_horizon_raises(self):
        df = _make_ohlcv(20)
        with pytest.raises(ValueError, match="horizon"):
            make_labels(df, horizon=0)

    def test_missing_price_col_raises(self):
        df = _make_ohlcv(20)
        with pytest.raises(KeyError):
            make_labels(df, horizon=5, price_col="nonexistent")

    def test_output_values_only_valid(self):
        df     = _make_ohlcv(50)
        labels = make_labels(df, horizon=5)
        valid  = labels.dropna()
        assert set(valid.unique()).issubset({-1.0, 0.0, 1.0})


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2: Tests for create_labels
# ═══════════════════════════════════════════════════════════════════════════════

class TestCreateLabels:
    """Tests for create_labels(df, horizon, up_threshold, down_threshold) → UP/DOWN/NEUTRAL/NaN."""

    def test_returns_series_same_length(self):
        df     = _make_ohlcv(50)
        labels = create_labels(df, horizon=5, up_threshold=0.005, down_threshold=-0.005)
        assert len(labels) == len(df)

    def test_last_horizon_rows_nan(self):
        df      = _make_ohlcv(50)
        horizon = 7
        labels  = create_labels(df, horizon=horizon, up_threshold=0.005, down_threshold=-0.005)
        assert labels.iloc[-horizon:].isna().all()

    def test_strongly_rising_price_gets_up(self):
        # Build a DF where close always goes up >= 2% every 5 bars
        df = _make_trending_ohlcv(n=50, start=100.0, step=2.0)
        labels = create_labels(df, horizon=5, up_threshold=0.01, down_threshold=-0.01)
        valid = labels.dropna()
        assert (valid == "UP").all(), f"Got unexpected labels: {valid.unique()}"

    def test_strongly_falling_price_gets_down(self):
        df = _make_falling_ohlcv(n=50, start=200.0, step=2.0)
        labels = create_labels(df, horizon=5, up_threshold=0.01, down_threshold=-0.01)
        valid = labels.dropna()
        assert (valid == "DOWN").all()

    def test_flat_price_gets_neutral(self):
        df = _make_flat_ohlcv(n=30, price=100.0)
        labels = create_labels(df, horizon=3, up_threshold=0.005, down_threshold=-0.005)
        valid = labels.dropna()
        assert (valid == "NEUTRAL").all()

    def test_output_only_valid_string_labels(self):
        df     = _make_ohlcv(80)
        labels = create_labels(df, horizon=10, up_threshold=0.003, down_threshold=-0.003)
        valid  = labels.dropna()
        allowed = {"UP", "DOWN", "NEUTRAL"}
        unexpected = set(valid.unique()) - allowed
        assert not unexpected, f"Unexpected label values: {unexpected}"

    def test_invalid_up_threshold_raises(self):
        df = _make_ohlcv(20)
        with pytest.raises(ValueError):
            create_labels(df, horizon=5, up_threshold=-0.005, down_threshold=-0.005)

    def test_invalid_down_threshold_raises(self):
        df = _make_ohlcv(20)
        with pytest.raises(ValueError):
            create_labels(df, horizon=5, up_threshold=0.005, down_threshold=0.005)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3: Reference build_p1_labels tests (always run)
# ═══════════════════════════════════════════════════════════════════════════════

class TestRefBuildP1Labels:
    """
    Tests that exercise the reference implementation _ref_build_p1_labels.
    These always run regardless of whether label_builder exports build_p1_labels.
    They verify the *specification* — the real implementation must match.
    """

    # ── 1. LONG label ─────────────────────────────────────────────────────────
    def test_p1_long_label(self):
        """
        When exit close is well above entry open, the label should be LONG (2).
        """
        tau_up   = 0.01   # 1%
        tau_down = -0.01
        horizon  = 3
        n        = 20

        idx    = pd.date_range("2024-01-02 09:00", periods=n, freq="1min")
        open_  = np.full(n, 100.0)
        # close[t + horizon] = 102.0 → net_return = (102 - 100) / 100 = 0.02 ≥ tau_up
        close_ = np.full(n, 102.0)
        df = pd.DataFrame(
            {"open": open_, "high": close_ + 0.1, "low": open_ - 0.1, "close": close_, "volume": np.ones(n)},
            index=idx,
        )
        labels = _ref_build_p1_labels(df, horizon=horizon, tau_up=tau_up, tau_down=tau_down)
        valid  = labels.dropna()
        assert (valid == 2.0).all(), f"Expected LONG(2), got: {valid.unique()}"

    # ── 2. SHORT label ────────────────────────────────────────────────────────
    def test_p1_short_label(self):
        """
        When exit close is well below entry open, the label should be SHORT (0).
        """
        tau_up   = 0.01
        tau_down = -0.01
        horizon  = 3
        n        = 20

        idx    = pd.date_range("2024-01-02 09:00", periods=n, freq="1min")
        open_  = np.full(n, 100.0)
        # close[t + horizon] = 98.0 → net_return = (98 - 100) / 100 = -0.02 ≤ tau_down
        close_ = np.full(n, 98.0)
        df = pd.DataFrame(
            {"open": open_, "high": open_ + 0.1, "low": close_ - 0.1, "close": close_, "volume": np.ones(n)},
            index=idx,
        )
        labels = _ref_build_p1_labels(df, horizon=horizon, tau_up=tau_up, tau_down=tau_down)
        valid  = labels.dropna()
        assert (valid == 0.0).all(), f"Expected SHORT(0), got: {valid.unique()}"

    # ── 3. NEUTRAL label ──────────────────────────────────────────────────────
    def test_p1_neutral_label(self):
        """
        When prices are perfectly flat, net_return = 0 → NEUTRAL (1).
        """
        tau_up   = 0.005
        tau_down = -0.005
        horizon  = 3
        n        = 20
        price    = 100.0

        idx    = pd.date_range("2024-01-02 09:00", periods=n, freq="1min")
        prices = np.full(n, price)
        df = pd.DataFrame(
            {"open": prices, "high": prices, "low": prices, "close": prices, "volume": np.ones(n)},
            index=idx,
        )
        labels = _ref_build_p1_labels(df, horizon=horizon, tau_up=tau_up, tau_down=tau_down)
        valid  = labels.dropna()
        assert (valid == 1.0).all(), f"Expected NEUTRAL(1), got: {valid.unique()}"

    # ── 4. Last horizon rows NaN ──────────────────────────────────────────────
    def test_last_horizon_rows_nan(self):
        """The last `horizon` rows must always be NaN."""
        for horizon in (1, 5, 10):
            df     = _make_ohlcv(n=50)
            labels = _ref_build_p1_labels(df, horizon=horizon, tau_up=0.005, tau_down=-0.005)
            tail   = labels.iloc[-horizon:]
            assert tail.isna().all(), (
                f"horizon={horizon}: expected NaN tail, got {tail.values}"
            )

    # ── 5. No lookahead: corrupting prices beyond t+horizon is safe ───────────
    def test_no_lookahead_p1(self):
        """
        Corrupting close prices strictly after t+horizon must not change labels
        for row t.  Corrupting open[t+1] or close[t+horizon] SHOULD change them.
        """
        horizon  = 3
        tau_up   = 0.005
        tau_down = -0.005
        df_orig  = _make_ohlcv(n=40, base_price=100.0)

        labels_orig = _ref_build_p1_labels(df_orig, horizon, tau_up, tau_down)

        # Corrupt rows strictly beyond horizon from row 0 (row index > horizon)
        # i.e. close[horizon + 1 :] — row 0 only looks at close[horizon], not beyond
        t = 0
        beyond_index = t + horizon + 1

        df_safe = df_orig.copy()
        df_safe.iloc[beyond_index:, df_safe.columns.get_loc("close")] *= 999.0

        labels_safe = _ref_build_p1_labels(df_safe, horizon, tau_up, tau_down)
        # Row 0's label must not change
        assert labels_orig.iloc[t] == labels_safe.iloc[t] or (
            pd.isna(labels_orig.iloc[t]) and pd.isna(labels_safe.iloc[t])
        ), "Corrupting data beyond t+horizon changed label at row 0"

        # Now corrupt the entry price (open[t+1]) — label at t=0 SHOULD change
        df_corrupt_entry = df_orig.copy()
        df_corrupt_entry.iloc[1, df_corrupt_entry.columns.get_loc("open")] *= 50.0
        labels_corrupt_entry = _ref_build_p1_labels(df_corrupt_entry, horizon, tau_up, tau_down)
        # The label at t=0 should differ (or become NaN if price blows up)
        # We assert that the labels object is different, not necessarily t=0 only
        assert not labels_orig.equals(labels_corrupt_entry), (
            "Corrupting open[t+1] (entry price) should change the labels Series"
        )

    # ── 6. Entry price uses open[t+1], not close[t] ──────────────────────────
    def test_entry_price_is_next_open(self):
        """
        Build a DF where open[t+1] = 100 and close[t] = 50.
        Make close[t+horizon] = 105.
        With entry=open[t+1]=100: net_return = 0.05 → LONG.
        With entry=close[t]=50: net_return = 1.10 → also LONG but different magnitude.
        We distinguish by setting close[t] = 105 and open[t+1] = 100:
            if label uses close[t]=105 as entry: net_return = 0 → NEUTRAL
            if label uses open[t+1]=100 as entry: net_return = 0.05 → LONG
        """
        tau_up   = 0.01
        tau_down = -0.01
        horizon  = 1
        n        = 5

        idx    = pd.date_range("2024-01-02 09:00", periods=n, freq="1min")
        # close[t] = 105 — if used as entry, net_return = (105 - 105)/105 = 0 → NEUTRAL
        # open[t+1] = 100 — actual entry, net_return = (105 - 100)/100 = 0.05 → LONG
        open_  = np.array([95.0, 100.0, 100.0, 100.0, 100.0])
        close_ = np.array([105.0, 105.0, 105.0, 105.0, 105.0])
        df = pd.DataFrame(
            {"open": open_, "high": close_ + 1.0, "low": open_ - 1.0, "close": close_, "volume": np.ones(n)},
            index=idx,
        )
        labels = _ref_build_p1_labels(df, horizon=1, tau_up=tau_up, tau_down=tau_down)
        # Row t=0: entry=open[1]=100, exit=close[1]=105, net_ret=0.05 ≥ tau_up → LONG=2
        assert labels.iloc[0] == 2.0, (
            f"Expected LONG(2) when open[t+1]=100, close[t+horizon]=105; got {labels.iloc[0]}"
        )

    # ── 7. Only valid class values in output ──────────────────────────────────
    def test_label_classes_valid(self):
        """Output must contain only 0.0, 1.0, 2.0, or NaN."""
        df     = _make_ohlcv(n=100)
        labels = _ref_build_p1_labels(df, horizon=5, tau_up=0.005, tau_down=-0.005)
        valid  = labels.dropna()
        unexpected = set(valid.unique()) - {0.0, 1.0, 2.0}
        assert not unexpected, f"Unexpected label values: {unexpected}"

    # ── 8. Parametrize horizons ───────────────────────────────────────────────
    @pytest.mark.parametrize("horizon", [1, 5, 10])
    def test_parametrize_horizons(self, horizon: int):
        """build_p1_labels works correctly for multiple horizons."""
        n      = max(50, horizon * 5)
        df     = _make_ohlcv(n=n)
        labels = _ref_build_p1_labels(df, horizon=horizon, tau_up=0.005, tau_down=-0.005)

        # Shape and index
        assert len(labels) == n
        assert labels.index.equals(df.index)

        # Last horizon rows must be NaN
        assert labels.iloc[-horizon:].isna().all()

        # At least one valid (non-NaN) label should exist for n >> horizon
        assert labels.dropna().notna().any()

        # Values restricted to {0, 1, 2}
        valid = labels.dropna()
        assert set(valid.unique()).issubset({0.0, 1.0, 2.0})


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4: Real implementation parity tests (skipped when absent)
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.skipif(not _HAS_REAL, reason="build_p1_labels not exported from label_builder")
class TestRealBuildP1LabelsParity:
    """
    When build_p1_labels is present in label_builder.py, verify it matches
    the reference on a battery of synthetic DataFrames.
    """

    @pytest.mark.parametrize("seed", [0, 7, 42, 99])
    def test_matches_reference_random(self, seed: int):
        rng = np.random.default_rng(seed)
        n   = 80
        idx = pd.date_range("2024-01-02 09:00", periods=n, freq="1min")
        close = 100.0 * np.cumprod(1 + rng.normal(0, 0.002, n))
        open_ = np.roll(close, 1)
        open_[0] = close[0]
        df = pd.DataFrame(
            {
                "open":   open_,
                "high":   np.maximum(open_, close) * 1.001,
                "low":    np.minimum(open_, close) * 0.999,
                "close":  close,
                "volume": rng.integers(1000, 5000, n).astype(float),
            },
            index=idx,
        )
        ref  = _ref_build_p1_labels(df, horizon=5, tau_up=0.005, tau_down=-0.005)
        real = _real_build_p1_labels(df, horizon=5, tau_up=0.005, tau_down=-0.005)
        pd.testing.assert_series_equal(ref, real, check_names=False)

    def test_matches_reference_flat(self):
        df  = _make_flat_ohlcv(n=30, price=100.0)
        ref  = _ref_build_p1_labels(df, horizon=3, tau_up=0.005, tau_down=-0.005)
        real = _real_build_p1_labels(df, horizon=3, tau_up=0.005, tau_down=-0.005)
        pd.testing.assert_series_equal(ref, real, check_names=False)

    def test_matches_reference_trending_up(self):
        df   = _make_trending_ohlcv(n=40, start=100.0, step=1.0)
        ref  = _ref_build_p1_labels(df, horizon=5, tau_up=0.01, tau_down=-0.01)
        real = _real_build_p1_labels(df, horizon=5, tau_up=0.01, tau_down=-0.01)
        pd.testing.assert_series_equal(ref, real, check_names=False)

    def test_matches_reference_trending_down(self):
        df   = _make_falling_ohlcv(n=40, start=200.0, step=1.0)
        ref  = _ref_build_p1_labels(df, horizon=5, tau_up=0.01, tau_down=-0.01)
        real = _real_build_p1_labels(df, horizon=5, tau_up=0.01, tau_down=-0.01)
        pd.testing.assert_series_equal(ref, real, check_names=False)

    @pytest.mark.parametrize("horizon", [1, 5, 10])
    def test_real_parametrize_horizons(self, horizon: int):
        n  = max(50, horizon * 6)
        df = _make_ohlcv(n=n)
        ref  = _ref_build_p1_labels(df, horizon=horizon, tau_up=0.005, tau_down=-0.005)
        real = _real_build_p1_labels(df, horizon=horizon, tau_up=0.005, tau_down=-0.005)
        pd.testing.assert_series_equal(ref, real, check_names=False)
