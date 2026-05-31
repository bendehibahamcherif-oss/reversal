"""Tests for label_builder.py — verifying no-lookahead guarantee."""

import numpy as np
import pandas as pd
import pytest

from label_builder import (
    LABEL_DOWN,
    LABEL_NEUTRAL,
    LABEL_UP,
    create_labels,
    create_triple_barrier_labels,
)


class TestCreateLabels:
    def test_monotone_up_labels_all_up(self, monotone_up_df):
        """Monotonically rising prices → every labelable row is UP."""
        horizon = 10
        labels = create_labels(monotone_up_df, horizon=horizon,
                               up_threshold=0.001, down_threshold=-0.001)
        # All rows except last `horizon` should be UP
        labelable = labels.iloc[:-horizon]
        assert (labelable == LABEL_UP).all(), \
            f"Expected all UP, got: {labelable.value_counts().to_dict()}"

    def test_last_horizon_rows_are_nan(self, monotone_up_df):
        """Last `horizon` entries must always be NaN — no future data."""
        horizon = 10
        labels = create_labels(monotone_up_df, horizon=horizon,
                               up_threshold=0.005, down_threshold=-0.005)
        assert labels.iloc[-horizon:].isna().all(), \
            "Last horizon rows must be NaN"

    def test_flat_price_produces_neutral(self, flat_df):
        """Flat price series returns ≡ 0 → all labels NEUTRAL."""
        horizon = 5
        labels = create_labels(flat_df, horizon=horizon,
                               up_threshold=0.001, down_threshold=-0.001)
        valid = labels.dropna()
        assert (valid == LABEL_NEUTRAL).all(), \
            f"Expected NEUTRAL, got: {valid.value_counts().to_dict()}"

    def test_length_matches_input(self, random_ohlcv_df):
        """Output Series must have same length as input DataFrame."""
        labels = create_labels(random_ohlcv_df, horizon=5,
                               up_threshold=0.005, down_threshold=-0.005)
        assert len(labels) == len(random_ohlcv_df)

    def test_index_preserved(self, random_ohlcv_df):
        labels = create_labels(random_ohlcv_df, horizon=5,
                               up_threshold=0.005, down_threshold=-0.005)
        assert labels.index.equals(random_ohlcv_df.index)

    def test_only_valid_class_values(self, random_ohlcv_df):
        """Non-NaN labels must only be UP, DOWN, or NEUTRAL."""
        labels = create_labels(random_ohlcv_df, horizon=5,
                               up_threshold=0.005, down_threshold=-0.005)
        valid = labels.dropna()
        assert set(valid.unique()).issubset({LABEL_UP, LABEL_DOWN, LABEL_NEUTRAL})

    def test_no_future_price_in_label_t(self, monotone_up_df):
        """
        Anti-leakage: dropping the future close and re-labelling must give
        the same result.  label[t] depends only on close[t] and close[t+H].
        """
        df       = monotone_up_df.copy()
        horizon  = 5
        labels_a = create_labels(df, horizon=horizon,
                                 up_threshold=0.001, down_threshold=-0.001)

        # Corrupt all future prices that should NOT affect label[0]
        df_corrupted = df.copy()
        df_corrupted.loc[df_corrupted.index[horizon + 1:], "close"] *= 9999

        labels_b = create_labels(df_corrupted, horizon=horizon,
                                 up_threshold=0.001, down_threshold=-0.001)

        # label[0] uses close[0] and close[horizon], which we did NOT corrupt
        assert labels_a.iloc[0] == labels_b.iloc[0]

    def test_invalid_horizon_raises(self, monotone_up_df):
        with pytest.raises(ValueError, match="horizon"):
            create_labels(monotone_up_df, horizon=0,
                          up_threshold=0.005, down_threshold=-0.005)

    def test_invalid_thresholds_raise(self, monotone_up_df):
        with pytest.raises(ValueError):
            create_labels(monotone_up_df, horizon=5,
                          up_threshold=-0.005,   # wrong sign
                          down_threshold=-0.005)

    def test_missing_price_col_raises(self, monotone_up_df):
        with pytest.raises(KeyError):
            create_labels(monotone_up_df, horizon=5,
                          up_threshold=0.005, down_threshold=-0.005,
                          price_col="nonexistent_col")


class TestTripleBarrierLabels:
    def test_strong_up_move_hits_profit_target(self):
        prices = np.linspace(100, 110, 50)
        df = pd.DataFrame({"close": prices, "high": prices + 0.5, "low": prices - 0.5})
        labels = create_triple_barrier_labels(df, horizon=10,
                                              profit_target=0.02, stop_loss=0.05)
        assert labels.iloc[0] == LABEL_UP

    def test_last_horizon_are_nan(self, flat_df):
        horizon = 8
        labels = create_triple_barrier_labels(flat_df, horizon=horizon,
                                              profit_target=0.01, stop_loss=0.01)
        assert labels.iloc[-horizon:].isna().all()
