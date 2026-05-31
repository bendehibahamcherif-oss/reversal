"""Tests for feature engineering and dataset utilities."""

import numpy as np
import pandas as pd
import pytest

from dataset_utils import compute_dataframe_hash, compute_schema_hash
from feature_engineering import FEATURE_NAMES_P1, compute_features


class TestComputeFeatures:
    def test_returns_correct_column_count(self, random_ohlcv_df):
        X = compute_features(random_ohlcv_df)
        assert set(FEATURE_NAMES_P1).issubset(set(X.columns)), \
            f"Missing features: {set(FEATURE_NAMES_P1) - set(X.columns)}"

    def test_same_length_as_input(self, random_ohlcv_df):
        X = compute_features(random_ohlcv_df)
        assert len(X) == len(random_ohlcv_df)

    def test_index_matches_input(self, random_ohlcv_df):
        X = compute_features(random_ohlcv_df)
        assert X.index.equals(random_ohlcv_df.index)

    def test_no_future_columns_added(self, random_ohlcv_df):
        """compute_features must only add columns from FEATURE_NAMES_P1."""
        X = compute_features(random_ohlcv_df)
        unexpected = set(X.columns) - set(FEATURE_NAMES_P1)
        assert not unexpected, f"Unexpected feature columns: {unexpected}"

    def test_finite_values_for_complete_data(self, random_ohlcv_df):
        """With a well-formed 200-row DataFrame the majority of values should be finite."""
        X = compute_features(random_ohlcv_df)
        # After warm-up rows, everything should be finite
        tail = X.iloc[30:]
        finite_frac = tail.notna().values.mean()
        assert finite_frac > 0.95, f"Too many NaN in features: {1 - finite_frac:.2%}"

    def test_subset_feature_names(self, random_ohlcv_df):
        """Requesting a subset of features only produces those columns."""
        subset = ["rsi_14", "volume_ratio", "momentum_1"]
        X = compute_features(random_ohlcv_df, feature_names=subset)
        assert list(X.columns) == subset or set(X.columns) == set(subset)

    def test_fallback_to_zero_for_missing_optional_cols(self, monotone_up_df):
        """DataFrame with only OHLCV — optional features should default to 0."""
        X = compute_features(monotone_up_df)
        assert "vwap_distance"            in X.columns
        assert "cvd_normalized"           in X.columns
        assert "orderflow_imbalance"      in X.columns
        assert "footprint_imbalance_recent" in X.columns
        # All optional ones should be scalar 0 (not NaN)
        for col in ["vwap_distance", "cvd_normalized", "orderflow_imbalance",
                    "footprint_imbalance_recent"]:
            assert (X[col] == 0.0).all(), f"{col} should be 0 when source col absent"

    def test_rsi_normalised_to_0_1(self, random_ohlcv_df):
        """RSI input [0,100] must be normalised to [0,1] in the feature."""
        X = compute_features(random_ohlcv_df, feature_names=["rsi_14"])
        valid = X["rsi_14"].dropna()
        assert valid.between(0.0, 1.0).all(), "rsi_14 out of [0, 1] range"

    def test_volume_ratio_positive(self, random_ohlcv_df):
        X      = compute_features(random_ohlcv_df, feature_names=["volume_ratio"])
        valid  = X["volume_ratio"].dropna()
        assert (valid > 0).all(), "volume_ratio must be positive"


class TestHashing:
    def test_same_dataframe_same_hash(self, random_ohlcv_df):
        h1 = compute_dataframe_hash(random_ohlcv_df)
        h2 = compute_dataframe_hash(random_ohlcv_df.copy())
        assert h1 == h2

    def test_different_data_different_hash(self, random_ohlcv_df):
        modified = random_ohlcv_df.copy()
        modified.iloc[0, 0] += 0.0001
        h1 = compute_dataframe_hash(random_ohlcv_df)
        h2 = compute_dataframe_hash(modified)
        assert h1 != h2

    def test_schema_hash_sensitive_to_order(self):
        h1 = compute_schema_hash(["rsi_14", "volume_ratio", "momentum_1"])
        h2 = compute_schema_hash(["rsi_14", "momentum_1",  "volume_ratio"])
        # sorted internally, so order-insensitive → same hash
        assert h1 == h2

    def test_schema_hash_sensitive_to_name_change(self):
        h1 = compute_schema_hash(["rsi_14", "volume_ratio"])
        h2 = compute_schema_hash(["rsi_14", "volume_ratio_v2"])
        assert h1 != h2

    def test_hash_is_hex_string(self, random_ohlcv_df):
        h = compute_dataframe_hash(random_ohlcv_df)
        assert isinstance(h, str)
        assert all(c in "0123456789abcdef" for c in h)
