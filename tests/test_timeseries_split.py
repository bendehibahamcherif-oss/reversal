"""Tests for temporal split and TimeSeriesSplit gap enforcement."""

import numpy as np
import pandas as pd
import pytest
from sklearn.model_selection import TimeSeriesSplit

from dataset_utils import temporal_train_val_test_split, time_series_cv


class TestTemporalSplit:
    def test_correct_sizes_with_100_rows(self):
        df = pd.DataFrame({"a": range(100)})
        train, val, test = temporal_train_val_test_split(df, 0.70, 0.15)
        assert len(train) == 70
        assert len(val)   == 15
        assert len(test)  == 15

    def test_sizes_sum_to_total(self, random_ohlcv_df):
        train, val, test = temporal_train_val_test_split(random_ohlcv_df, 0.70, 0.15)
        assert len(train) + len(val) + len(test) == len(random_ohlcv_df)

    def test_no_overlap_between_splits(self, random_ohlcv_df):
        train, val, test = temporal_train_val_test_split(random_ohlcv_df, 0.70, 0.15)
        assert set(train.index).isdisjoint(set(val.index)),  "train/val overlap"
        assert set(val.index).isdisjoint(set(test.index)),   "val/test overlap"
        assert set(train.index).isdisjoint(set(test.index)), "train/test overlap"

    def test_chronological_order_preserved(self, random_ohlcv_df):
        """All timestamps in train must precede val, which must precede test."""
        train, val, test = temporal_train_val_test_split(random_ohlcv_df, 0.70, 0.15)
        assert train.index.max() < val.index.min(),  "train overlaps val in time"
        assert val.index.max()   < test.index.min(), "val overlaps test in time"

    def test_invalid_ratio_raises(self):
        df = pd.DataFrame({"a": range(50)})
        with pytest.raises(ValueError):
            temporal_train_val_test_split(df, train_ratio=0.7, val_ratio=0.4)


class TestTimeSeriesCV:
    def test_gap_prevents_lookahead(self):
        """
        With gap=H, the last training index must be at least H rows
        before the first test index in every fold.
        """
        n_samples = 100
        horizon   = 10
        tscv = time_series_cv(n_samples, n_splits=3, horizon=horizon)
        X    = np.arange(n_samples).reshape(-1, 1)

        for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
            gap_actual = test_idx[0] - train_idx[-1] - 1
            assert gap_actual >= horizon, \
                f"Fold {fold}: gap={gap_actual} < horizon={horizon} — lookahead possible"

    def test_test_indices_always_newer_than_train(self):
        """No test index may appear in any train fold."""
        tscv = time_series_cv(80, n_splits=4, horizon=5)
        X    = np.arange(80).reshape(-1, 1)
        for train_idx, test_idx in tscv.split(X):
            assert max(train_idx) < min(test_idx)

    def test_n_splits_respected(self):
        tscv = time_series_cv(100, n_splits=5, horizon=3)
        X    = np.arange(100).reshape(-1, 1)
        folds = list(tscv.split(X))
        assert len(folds) == 5

    def test_returns_timeseries_split_instance(self):
        result = time_series_cv(50, n_splits=3, horizon=2)
        assert isinstance(result, TimeSeriesSplit)
