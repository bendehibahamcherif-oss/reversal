"""
Tests for the ML Signal Engine training pipeline components.

Covers:
    - TestFeatureBuilder     : build_features correctness, no-lookahead, fallbacks
    - TestDatasetBuilder     : build_dataset X/y alignment, NaN-free, label_distribution
    - TestTimeSeriesSplitGap : time_series_cv gap enforcement per fold

Path setup mirrors the project convention:
    /home/user/reversal/server/ai is added so that
    ``training.*`` and ``inference.*`` are importable as namespace packages.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

# ── Path setup ────────────────────────────────────────────────────────────────
_AI_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_AI_ROOT))                        # enables training.* imports
sys.path.insert(0, str(_AI_ROOT / "training"))           # direct flat imports
sys.path.insert(0, str(_AI_ROOT / "inference"))
sys.path.insert(0, str(_AI_ROOT / "monitoring"))

from feature_builder import ALL_FEATURE_NAMES, build_features  # noqa: E402
from dataset_utils import time_series_cv                       # noqa: E402


# ── Shared synthetic data helpers ─────────────────────────────────────────────

def _make_ohlcv(
    n: int = 200,
    seed: int = 0,
    varied_volume: bool = True,
) -> pd.DataFrame:
    """
    Return a synthetic OHLCV DataFrame with a DatetimeIndex.

    200 rows is the project-mandated minimum for meaningful rolling features.
    ``varied_volume=True`` avoids volume_zscore being all-NaN (which happens
    when every bar has the same volume and rolling std == 0).
    """
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2024-01-02 09:00", periods=n, freq="1min")

    ret   = rng.normal(0, 0.005, n)
    close = 100.0 * np.cumprod(1 + ret)
    open_ = np.roll(close, 1)
    open_[0] = close[0]
    high  = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.001, n)))
    low   = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.001, n)))

    if varied_volume:
        volume = rng.uniform(500, 5000, n)
    else:
        volume = np.ones(n) * 1000.0

    return pd.DataFrame(
        {
            "open":   open_,
            "high":   high,
            "low":    low,
            "close":  close,
            "volume": volume,
        },
        index=idx,
    )


def _make_ohlcv_with_range_index(n: int = 200, seed: int = 1) -> pd.DataFrame:
    """OHLCV with a plain RangeIndex (no DatetimeIndex)."""
    df = _make_ohlcv(n=n, seed=seed)
    df.index = pd.RangeIndex(n)
    return df


def _make_ohlcv_noon(n: int = 200, seed: int = 2) -> pd.DataFrame:
    """OHLCV where every bar falls at noon (hour=12), so hour_sin/cos are non-zero."""
    rng = np.random.default_rng(seed)
    # Start exactly at 12:00 and step by 1 minute; with n=200, we stay within noon hour
    idx = pd.date_range("2024-01-02 12:00", periods=n, freq="1min")
    close  = 100.0 * np.cumprod(1 + rng.normal(0, 0.003, n))
    open_  = np.roll(close, 1)
    open_[0] = close[0]
    high   = np.maximum(open_, close) * 1.001
    low    = np.minimum(open_, close) * 0.999
    volume = rng.uniform(500, 5000, n)
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=idx,
    )


def _make_zero_volume_ohlcv(n: int = 200, seed: int = 3) -> pd.DataFrame:
    """OHLCV where all volume bars are zero."""
    df = _make_ohlcv(n=n, seed=seed, varied_volume=False)
    df["volume"] = 0.0
    return df


# ═══════════════════════════════════════════════════════════════════════════════
# 1.  TestFeatureBuilder
# ═══════════════════════════════════════════════════════════════════════════════

class TestFeatureBuilder:
    """Tests for build_features in feature_builder.py."""

    # ── 1.1 All feature names present ─────────────────────────────────────────
    def test_all_features_present(self):
        """build_features must return every column in ALL_FEATURE_NAMES."""
        df = _make_ohlcv()
        X  = build_features(df)

        assert isinstance(X, pd.DataFrame)
        missing = set(ALL_FEATURE_NAMES) - set(X.columns)
        assert not missing, f"Missing features: {sorted(missing)}"

        extra = set(X.columns) - set(ALL_FEATURE_NAMES)
        assert not extra, f"Unexpected extra columns: {sorted(extra)}"

        assert len(X) == len(df)
        assert X.index.equals(df.index)

    # ── 1.2 No future data (no lookahead) ─────────────────────────────────────
    def test_no_future_data(self):
        """
        Feature row 49 computed on df[:50] must equal feature row 49
        computed on df[:51].  If there is any lookahead, the values will differ.
        """
        df = _make_ohlcv(n=200)

        X50 = build_features(df.iloc[:50])
        X51 = build_features(df.iloc[:51])

        row_50 = X50.iloc[49]   # last row of the shorter window
        row_51 = X51.iloc[49]   # same index in the longer window

        # Use allclose with a tight tolerance
        for feat in ALL_FEATURE_NAMES:
            v50 = row_50[feat]
            v51 = row_51[feat]
            if pd.isna(v50) and pd.isna(v51):
                continue   # both NaN is acceptable
            assert math.isclose(float(v50), float(v51), rel_tol=1e-9, abs_tol=1e-12), (
                f"Feature '{feat}' differs between df[:50] and df[:51] at row 49: "
                f"{v50} vs {v51} — possible lookahead!"
            )

    # ── 1.3 Fallback to 0.0 for optional (non-OHLCV) columns ──────────────────
    def test_fallback_zero_for_missing_cols(self):
        """
        An OHLCV-only DataFrame should produce 0.0 (not NaN, not error)
        for every feature that depends on optional columns (poc/vah/val,
        ask/bid, ask_size/bid_size, cvd, footprint_imbalance).
        """
        df = _make_ohlcv()
        X  = build_features(df)

        optional_zero_features = [
            # VOLUME PROFILE
            "dist_poc", "dist_vah", "dist_val", "inside_value_area",
            # ORDERFLOW
            "spread", "queue_imbalance", "bid_ask_pressure",
            # FOOTPRINT
            "cvd", "cvd_slope", "footprint_imbalance_count", "stacked_imbalance",
        ]

        for feat in optional_zero_features:
            series = X[feat]
            non_zero_finite = series[series.notna() & (series != 0.0)]
            assert len(non_zero_finite) == 0, (
                f"Feature '{feat}' expected all-zero fallback, "
                f"but found non-zero values: {non_zero_finite.head()}"
            )

    # ── 1.4 SESSION features non-zero at noon with DatetimeIndex ──────────────
    def test_session_features(self):
        """
        With a DatetimeIndex at noon (hour=12), hour_sin and hour_cos must be
        non-trivially non-zero (not all the same constant).
        """
        df = _make_ohlcv_noon(n=200)
        X  = build_features(df)

        # hour_sin at 12:00 = sin(2π × 12/24) = sin(π) ≈ 0
        # hour_cos at 12:00 = cos(2π × 12/24) = cos(π) = -1
        # At 12:01 the sin/cos rotate slightly — so over 200 bars they vary.
        hour_sin_unique = X["hour_sin"].dropna().unique()
        hour_cos_unique = X["hour_cos"].dropna().unique()

        # Must have more than one unique value (they rotate minute by minute)
        assert len(hour_sin_unique) > 1, "hour_sin should vary over 200 minutes"
        assert len(hour_cos_unique) > 1, "hour_cos should vary over 200 minutes"

        # Neither should be all-zero (confirming DatetimeIndex path was taken)
        assert not (X["hour_sin"] == 0.0).all(), "hour_sin should not be all-zero at noon"
        # hour_cos at noon is close to -1, definitely not all-zero
        assert not (X["hour_cos"] == 0.0).all(), "hour_cos should not be all-zero"

    # ── 1.5 SESSION features with RangeIndex fall back to 0.0 ─────────────────
    def test_session_features_range_index_zero(self):
        """
        With a plain RangeIndex (no DatetimeIndex), all SESSION features must
        fall back to 0.0 (as documented in the module docstring).
        """
        df = _make_ohlcv_with_range_index()
        X  = build_features(df)

        for feat in ("hour_sin", "hour_cos", "day_sin", "day_cos"):
            assert (X[feat] == 0.0).all(), (
                f"Expected RangeIndex fallback to 0.0 for '{feat}', "
                f"but got: {X[feat].unique()}"
            )

    # ── 1.6 ATR always non-negative ────────────────────────────────────────────
    def test_atr_always_positive(self):
        """
        ATR is a volatility measure and must be >= 0 for every finite value.
        """
        df  = _make_ohlcv()
        X   = build_features(df)
        atr = X["atr"].dropna()

        assert (atr >= 0).all(), (
            f"ATR contained negative values: {atr[atr < 0].head()}"
        )

    # ── 1.7 Zero-volume bars do not crash ──────────────────────────────────────
    def test_volume_features_with_zero_volume(self):
        """
        build_features must not raise on a DataFrame where all volume = 0.
        The result may contain NaN or 0.0 but must not raise an exception.
        """
        df = _make_zero_volume_ohlcv()
        try:
            X = build_features(df)
        except Exception as exc:
            pytest.fail(f"build_features raised {type(exc).__name__} with zero-volume data: {exc}")

        # Basic shape checks even when volume is zero
        assert len(X) == len(df)
        assert set(ALL_FEATURE_NAMES).issubset(set(X.columns))

    # ── 1.8 feature_names subset selection ────────────────────────────────────
    def test_subset_feature_names(self):
        """Requesting a subset of features returns only those columns."""
        df     = _make_ohlcv()
        subset = ["ret_1", "atr", "rvol", "hour_sin"]
        X      = build_features(df, feature_names=subset)

        assert set(X.columns) == set(subset)
        assert len(X) == len(df)

    # ── 1.9 Unknown feature name raises ValueError ────────────────────────────
    def test_unknown_feature_name_raises(self):
        """build_features must raise ValueError for unknown feature names."""
        df = _make_ohlcv()
        with pytest.raises(ValueError, match="Unknown feature"):
            build_features(df, feature_names=["ret_1", "not_a_real_feature"])

    # ── 1.10 Missing required OHLCV columns raises KeyError ───────────────────
    def test_missing_required_column_raises(self):
        """build_features must raise KeyError when a required column is absent."""
        df = _make_ohlcv().drop(columns=["volume"])
        with pytest.raises(KeyError):
            build_features(df)


# ═══════════════════════════════════════════════════════════════════════════════
# 2.  TestDatasetBuilder
# ═══════════════════════════════════════════════════════════════════════════════

class TestDatasetBuilder:
    """
    Tests for build_dataset in dataset_builder.py.

    build_dataset internally calls build_features and _compute_labels.
    We test the real implementation end-to-end with synthetic data.

    The training directory exposes ``dataset_builder`` only when imported as
    the ``training`` namespace package (because it uses relative imports).
    """

    @pytest.fixture(autouse=True)
    def _setup(self):
        """Import build_dataset once; cache for all tests in this class."""
        from training.dataset_builder import build_dataset  # noqa: PLC0415
        self.build_dataset = build_dataset
        self.df = _make_ohlcv(n=300, seed=99)

    # ── 2.1 X and y are aligned ────────────────────────────────────────────────
    def test_x_y_aligned(self):
        """len(X) == len(y) and they share the same index."""
        ds = self.build_dataset(self.df, horizon=5, tau_up=0.003, tau_down=-0.003)

        X = ds["X"]
        y = ds["y"]

        assert len(X) == len(y), f"X rows ({len(X)}) != y rows ({len(y)})"
        assert X.index.equals(y.index), "X and y indices differ"

    # ── 2.2 No NaN in final X ─────────────────────────────────────────────────
    def test_no_nan_in_final_dataset(self):
        """After build_dataset's internal dropna, X must have zero NaN values."""
        ds = self.build_dataset(self.df, horizon=5, tau_up=0.003, tau_down=-0.003)
        X  = ds["X"]

        nan_count = int(X.isna().sum().sum())
        assert nan_count == 0, (
            f"X still contains {nan_count} NaN values after dataset construction"
        )

    # ── 2.3 Label distribution keys are correct ───────────────────────────────
    def test_label_distribution_in_output(self):
        """
        label_distribution keys must cover every label class (SHORT, NEUTRAL, LONG).
        The values must be non-negative integers and sum to n_samples.
        """
        ds   = self.build_dataset(self.df, horizon=5, tau_up=0.003, tau_down=-0.003)
        dist = ds["label_distribution"]

        # Keys can be string labels like "SHORT (0)" / "NEUTRAL (1)" / "LONG (2)"
        # or plain integer 0/1/2 — accept both conventions
        all_keys = " ".join(str(k) for k in dist.keys())
        has_coverage = (
            ("SHORT" in all_keys or "0" in all_keys)
            and ("NEUTRAL" in all_keys or "1" in all_keys)
            and ("LONG" in all_keys or "2" in all_keys)
        )
        assert has_coverage, (
            f"label_distribution keys don't cover SHORT/NEUTRAL/LONG: {list(dist.keys())}"
        )

        total = sum(int(v) for v in dist.values())
        assert total == ds["n_samples"], (
            f"label_distribution total ({total}) != n_samples ({ds['n_samples']})"
        )
        for v in dist.values():
            assert int(v) >= 0, f"label_distribution has negative count: {v}"

    # ── 2.4 feature_names in output ───────────────────────────────────────────
    def test_feature_names_in_output(self):
        """ds['feature_names'] must match X.columns exactly and in order."""
        ds = self.build_dataset(self.df, horizon=5, tau_up=0.003, tau_down=-0.003)
        assert list(ds["X"].columns) == ds["feature_names"]

    # ── 2.5 n_samples is consistent ───────────────────────────────────────────
    def test_n_samples_consistent(self):
        """n_samples must equal len(X) == len(y)."""
        ds = self.build_dataset(self.df, horizon=5, tau_up=0.003, tau_down=-0.003)
        assert ds["n_samples"] == len(ds["X"]) == len(ds["y"])

    # ── 2.6 y contains only valid label integers ──────────────────────────────
    def test_y_contains_only_valid_labels(self):
        """y must contain only 0, 1, or 2 (no NaN, no floats)."""
        ds = self.build_dataset(self.df, horizon=5, tau_up=0.003, tau_down=-0.003)
        y  = ds["y"]

        assert not y.isna().any(), "y contains NaN values after build_dataset"
        assert set(y.unique()).issubset({0, 1, 2}), (
            f"y contains unexpected label values: {set(y.unique())}"
        )

    # ── 2.7 Invalid horizon raises ────────────────────────────────────────────
    def test_invalid_horizon_raises(self):
        with pytest.raises(ValueError, match="horizon"):
            self.build_dataset(self.df, horizon=0)

    # ── 2.8 Invalid tau raises ────────────────────────────────────────────────
    def test_invalid_tau_up_raises(self):
        with pytest.raises(ValueError, match="tau_up"):
            self.build_dataset(self.df, horizon=5, tau_up=-0.001, tau_down=-0.003)

    def test_invalid_tau_down_raises(self):
        with pytest.raises(ValueError, match="tau_down"):
            self.build_dataset(self.df, horizon=5, tau_up=0.003, tau_down=0.001)

    # ── 2.9 Dataset hash is reproducible ──────────────────────────────────────
    def test_dataset_hash_reproducible(self):
        """Same input df → same dataset_hash."""
        ds1 = self.build_dataset(self.df, horizon=5, tau_up=0.003, tau_down=-0.003)
        ds2 = self.build_dataset(self.df, horizon=5, tau_up=0.003, tau_down=-0.003)
        assert ds1["dataset_hash"] == ds2["dataset_hash"]


# ═══════════════════════════════════════════════════════════════════════════════
# 3.  TestTimeSeriesSplitGap
# ═══════════════════════════════════════════════════════════════════════════════

class TestTimeSeriesSplitGap:
    """
    Tests for time_series_cv(n_samples, n_splits, horizon) from dataset_utils.py.

    The key invariant:  for every fold, the first test index minus the last
    train index minus 1 must be >= horizon (the gap).

    sklearn's TimeSeriesSplit(gap=g) guarantees test_start - train_end - 1 == g,
    so gap >= horizon is equivalent to gap == horizon when called via time_series_cv.
    """

    # ── 3.1 Gap enforcement ────────────────────────────────────────────────────
    @pytest.mark.parametrize("horizon", [1, 5, 10, 20])
    def test_gap_enforcement(self, horizon: int):
        """
        For every fold, test_start - train_end - 1 >= horizon.
        (train_end = last training index; test_start = first test index)
        """
        n_samples = 300
        n_splits  = 5
        tscv      = time_series_cv(n_samples=n_samples, n_splits=n_splits, horizon=horizon)

        dummy_X = np.zeros((n_samples, 1))

        for fold_idx, (train_idx, test_idx) in enumerate(tscv.split(dummy_X)):
            train_end  = int(train_idx[-1])
            test_start = int(test_idx[0])
            gap        = test_start - train_end - 1

            assert gap >= horizon, (
                f"Fold {fold_idx} (horizon={horizon}): "
                f"gap={gap} < horizon={horizon} — lookahead possible! "
                f"train_end={train_end}, test_start={test_start}"
            )

    # ── 3.2 Correct number of splits produced ─────────────────────────────────
    def test_n_splits_count(self):
        """time_series_cv must produce exactly n_splits folds."""
        tscv    = time_series_cv(n_samples=200, n_splits=4, horizon=5)
        dummy_X = np.zeros((200, 1))
        folds   = list(tscv.split(dummy_X))
        assert len(folds) == 4

    # ── 3.3 No overlap between train and test sets ────────────────────────────
    def test_no_train_test_overlap(self):
        """Train and test indices must be disjoint in every fold."""
        tscv    = time_series_cv(n_samples=200, n_splits=3, horizon=5)
        dummy_X = np.zeros((200, 1))

        for fold_idx, (train_idx, test_idx) in enumerate(tscv.split(dummy_X)):
            overlap = set(train_idx) & set(test_idx)
            assert not overlap, (
                f"Fold {fold_idx}: train and test sets overlap at indices {overlap}"
            )

    # ── 3.4 Chronological ordering within each fold ───────────────────────────
    def test_chronological_order(self):
        """
        Within each fold, all train indices must come before all test indices
        (max(train) < min(test)).
        """
        tscv    = time_series_cv(n_samples=200, n_splits=4, horizon=3)
        dummy_X = np.zeros((200, 1))

        for fold_idx, (train_idx, test_idx) in enumerate(tscv.split(dummy_X)):
            assert max(train_idx) < min(test_idx), (
                f"Fold {fold_idx}: train indices are not all before test indices"
            )

    # ── 3.5 tscv.gap matches requested horizon ────────────────────────────────
    def test_gap_attribute_matches_horizon(self):
        """The TimeSeriesSplit object's .gap attribute must equal horizon."""
        for horizon in (1, 5, 10):
            tscv = time_series_cv(n_samples=200, n_splits=3, horizon=horizon)
            assert tscv.gap == horizon, (
                f"tscv.gap={tscv.gap} != horizon={horizon}"
            )

    # ── 3.6 Increasing fold sizes ─────────────────────────────────────────────
    def test_train_sets_grow_monotonically(self):
        """
        In walk-forward CV, each successive training set must be at least as
        large as the previous one.
        """
        tscv    = time_series_cv(n_samples=300, n_splits=5, horizon=10)
        dummy_X = np.zeros((300, 1))

        prev_train_size = 0
        for fold_idx, (train_idx, _) in enumerate(tscv.split(dummy_X)):
            current_size = len(train_idx)
            assert current_size >= prev_train_size, (
                f"Fold {fold_idx}: training set shrank from {prev_train_size} "
                f"to {current_size}"
            )
            prev_train_size = current_size
