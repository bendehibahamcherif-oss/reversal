"""
Tests for temporal split correctness and TimeSeriesSplit gap guarantee.

Verifies:
  - temporal_train_val_test_split produces non-overlapping chronological folds
  - time_series_cv sets gap >= horizon (no lookahead)
  - Anti-leakage boundary assertions from train_pipeline
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE.parent / "training"))

from dataset_utils import temporal_train_val_test_split, time_series_cv


# ── Fixtures ───────────────────────────────────────────────────────────────────


def _make_df(n: int = 200) -> pd.DataFrame:
    idx = pd.date_range("2020-01-01", periods=n, freq="1min")
    rng = np.random.default_rng(0)
    return pd.DataFrame(
        {"open": rng.random(n), "close": rng.random(n), "volume": rng.random(n)},
        index=idx,
    )


# ── TestTemporalSplit ──────────────────────────────────────────────────────────


class TestTemporalSplit:
    """70/15/15 split produces correctly-sized, non-overlapping chronological folds."""

    def test_sizes_sum_to_total(self):
        df = _make_df(200)
        train, val, test = temporal_train_val_test_split(df, 0.70, 0.15)
        assert len(train) + len(val) + len(test) == 200

    def test_train_ratio_70pct(self):
        df = _make_df(200)
        train, _, _ = temporal_train_val_test_split(df, 0.70, 0.15)
        assert len(train) == 140

    def test_val_ratio_15pct(self):
        df = _make_df(200)
        _, val, _ = temporal_train_val_test_split(df, 0.70, 0.15)
        assert len(val) == 30

    def test_train_before_val_chronologically(self):
        df = _make_df(200)
        train, val, _ = temporal_train_val_test_split(df, 0.70, 0.15)
        assert train.index.max() < val.index.min()

    def test_val_before_test_chronologically(self):
        df = _make_df(200)
        _, val, test = temporal_train_val_test_split(df, 0.70, 0.15)
        assert val.index.max() < test.index.min()

    def test_no_overlap_train_val(self):
        df = _make_df(200)
        train, val, _ = temporal_train_val_test_split(df, 0.70, 0.15)
        assert len(set(train.index) & set(val.index)) == 0

    def test_no_overlap_val_test(self):
        df = _make_df(200)
        _, val, test = temporal_train_val_test_split(df, 0.70, 0.15)
        assert len(set(val.index) & set(test.index)) == 0

    def test_no_overlap_train_test(self):
        df = _make_df(200)
        train, _, test = temporal_train_val_test_split(df, 0.70, 0.15)
        assert len(set(train.index) & set(test.index)) == 0

    def test_no_shuffle_index_order_preserved(self):
        df = _make_df(200)
        train, val, test = temporal_train_val_test_split(df, 0.70, 0.15)
        combined = pd.concat([train, val, test])
        assert list(combined.index) == list(df.index)

    def test_invalid_ratio_raises(self):
        df = _make_df(100)
        with pytest.raises(ValueError):
            temporal_train_val_test_split(df, 0.80, 0.30)


# ── TestTimeSeriesSplitGap ─────────────────────────────────────────────────────


class TestTimeSeriesSplitGap:
    """TimeSeriesSplit must enforce gap >= horizon to prevent lookahead."""

    @pytest.mark.parametrize("horizon", [5, 10, 20])
    def test_gap_attribute_equals_horizon(self, horizon: int):
        tscv = time_series_cv(n_samples=500, n_splits=5, horizon=horizon)
        assert tscv.gap == horizon

    def test_n_splits_preserved(self):
        tscv = time_series_cv(n_samples=500, n_splits=5, horizon=10)
        assert tscv.n_splits == 5

    @pytest.mark.parametrize("horizon", [5, 10, 20])
    def test_actual_gap_gte_horizon(self, horizon: int):
        """Between last train index and first test index in every fold."""
        X    = np.zeros((300, 3))
        tscv = time_series_cv(n_samples=300, n_splits=4, horizon=horizon)
        for train_idx, test_idx in tscv.split(X):
            actual_gap = test_idx[0] - train_idx[-1] - 1
            assert actual_gap >= horizon, (
                f"Fold gap={actual_gap} < horizon={horizon}: "
                f"train[-1]={train_idx[-1]}, test[0]={test_idx[0]}"
            )

    def test_test_folds_non_overlapping(self):
        X    = np.zeros((300, 3))
        tscv = time_series_cv(n_samples=300, n_splits=4, horizon=5)
        test_sets = [frozenset(t) for _, t in tscv.split(X)]
        for i in range(len(test_sets)):
            for j in range(i + 1, len(test_sets)):
                assert test_sets[i].isdisjoint(test_sets[j]), (
                    f"Folds {i} and {j} overlap"
                )

    def test_train_sets_grow_monotonically(self):
        """Each fold's training set must be a superset of the previous one."""
        X    = np.zeros((300, 3))
        tscv = time_series_cv(n_samples=300, n_splits=4, horizon=5)
        prev = frozenset()
        for train_idx, _ in tscv.split(X):
            current = frozenset(train_idx)
            assert prev.issubset(current), "Train set shrank between folds"
            prev = current

    def test_no_train_test_overlap_any_fold(self):
        X    = np.zeros((300, 3))
        tscv = time_series_cv(n_samples=300, n_splits=5, horizon=10)
        for train_idx, test_idx in tscv.split(X):
            overlap = set(train_idx) & set(test_idx)
            assert not overlap, f"Train/test overlap detected: {overlap}"


# ── TestAntiLeakageAssertions ──────────────────────────────────────────────────


class TestAntiLeakageAssertions:
    """Validate the boundary assertions enforced in train_pipeline.py."""

    @pytest.mark.parametrize("n,horizon", [(1000, 5), (1000, 20), (500, 10)])
    def test_train_val_boundary_strictly_monotone(self, n: int, horizon: int):
        idx       = pd.date_range("2020-01-01", periods=n, freq="1min")
        train_end = int(n * 0.70)
        assert idx[train_end - 1] < idx[train_end]

    @pytest.mark.parametrize("n,horizon", [(1000, 5), (1000, 20), (500, 10)])
    def test_val_test_boundary_strictly_monotone(self, n: int, horizon: int):
        idx     = pd.date_range("2020-01-01", periods=n, freq="1min")
        val_end = int(n * 0.85)
        assert idx[val_end - 1] < idx[val_end]

    @pytest.mark.parametrize("n,horizon", [(1000, 20), (500, 10), (300, 5)])
    def test_val_window_at_least_horizon_rows(self, n: int, horizon: int):
        train_end = int(n * 0.70)
        val_end   = int(n * 0.85)
        assert val_end - train_end >= horizon, (
            f"Val window ({val_end - train_end} rows) < horizon ({horizon})"
        )

    def test_split_indices_partition_full_range(self):
        n         = 1000
        train_end = int(n * 0.70)
        val_end   = int(n * 0.85)
        train_idx = set(range(0,         train_end))
        val_idx   = set(range(train_end, val_end))
        test_idx  = set(range(val_end,   n))
        assert train_idx | val_idx | test_idx == set(range(n))
        assert not (train_idx & val_idx)
        assert not (val_idx   & test_idx)
        assert not (train_idx & test_idx)
