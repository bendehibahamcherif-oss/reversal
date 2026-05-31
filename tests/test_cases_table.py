"""
Test cases from the specification table — all 8 scenarios.

Cas  Description
 1   Étiquetage sans lookahead          make_labels returns +1/-1/+1/NaN
 2   TimeSeriesSplit avec gap           test_start ≥ train_end + gap
 3   Pipeline fit sur train seulement   StandardScaler uses X_train stats only
 4   Gestion des valeurs manquantes     SimpleImputer removes NaN residuals
 5   Stabilité du schéma des features   ValueError on column-name mismatch
 6   Payload JSON invalide (API)        _validate_payload → ValueError (≡ 400)
 7   Latence d'inférence p95            simulated p95 < 500 ms threshold
 8   Champion vs Challenger             XGBoost acc ≥ LightGBM acc (separable data)
"""

import sys
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler

# ── Module path setup ──────────────────────────────────────────────────────────
_TRAINING  = Path(__file__).parent.parent / "server" / "ai" / "training"
_INFERENCE = Path(__file__).parent.parent / "server" / "ai" / "inference"
sys.path.insert(0, str(_TRAINING))
sys.path.insert(0, str(_INFERENCE))

from infer        import _validate_payload         # noqa: E402
from label_builder import make_labels              # noqa: E402
from pipeline      import create_pipeline          # noqa: E402  (also aliased as train_pipeline)


# ── Fixtures ───────────────────────────────────────────────────────────────────

@pytest.fixture
def sample_df():
    """4-row DataFrame: prices [10, 12, 11, 13] with a 1-minute DatetimeIndex."""
    idx = pd.date_range("2020-01-01", periods=4, freq="min")
    return pd.DataFrame({"close": [10.0, 12.0, 11.0, 13.0]}, index=idx)


@pytest.fixture
def simple_timeseries():
    """Array [0 … 9] used for split boundary tests."""
    return np.arange(10)


@pytest.fixture
def gaussian_data():
    """100-sample × 2-feature Gaussian matrix with one planted NaN."""
    rng = np.random.default_rng(0)
    X = rng.standard_normal((100, 2))
    X[0, 0] = np.nan
    return X


# ══════════════════════════════════════════════════════════════════════════════
# Cas 1 — Étiquetage sans lookahead
# ══════════════════════════════════════════════════════════════════════════════

class TestMakeLabelsNoLookahead:
    def test_values_match_expected(self, sample_df):
        """
        Prices [10, 12, 11, 13] with horizon=1:
          t=0 → 12 > 10 → +1
          t=1 → 11 < 12 → -1
          t=2 → 13 > 11 → +1
          t=3 → NaN  (no future data)
        """
        y = make_labels(sample_df, horizon=1)
        assert y.iloc[0] ==  1.0, f"expected +1, got {y.iloc[0]}"
        assert y.iloc[1] == -1.0, f"expected -1, got {y.iloc[1]}"
        assert y.iloc[2] ==  1.0, f"expected +1, got {y.iloc[2]}"
        assert pd.isna(y.iloc[3]),  "last label must be NaN (no future)"

    def test_last_horizon_rows_always_nan(self, sample_df):
        for h in (1, 2, 3):
            y = make_labels(sample_df, horizon=h)
            assert y.iloc[-h:].isna().all(), \
                f"horizon={h}: last {h} labels must be NaN"

    def test_no_future_data_used(self, sample_df):
        """
        Changing prices beyond t+horizon must not affect label[t].
        label[0] depends only on close[0] and close[1] — corrupting close[2+]
        must leave label[0] unchanged.
        """
        y_original = make_labels(sample_df, horizon=1)

        corrupted = sample_df.copy()
        corrupted.iloc[2:, 0] *= 999
        y_corrupted = make_labels(corrupted, horizon=1)

        assert y_original.iloc[0] == y_corrupted.iloc[0], \
            "label[0] must not be affected by future price corruption"

    @pytest.mark.parametrize("prices,horizon,expected", [
        ([10, 20, 15, 25], 1, [1.0, -1.0, 1.0]),   # strict up-down-up
        ([5, 5, 5, 5],     1, [0.0, 0.0, 0.0]),     # flat → 0
        ([10, 8, 12, 6],   2, [1.0, -1.0]),          # horizon=2, 2 valid labels
    ])
    def test_parametrized_price_sequences(self, prices, horizon, expected):
        idx = pd.date_range("2024-01-01", periods=len(prices), freq="min")
        df  = pd.DataFrame({"close": prices}, index=idx)
        y   = make_labels(df, horizon=horizon).dropna()
        assert list(y.values) == expected, f"got {list(y.values)}, expected {expected}"


# ══════════════════════════════════════════════════════════════════════════════
# Cas 2 — TimeSeriesSplit avec gap
# ══════════════════════════════════════════════════════════════════════════════

class TestTimeSeriesSplitGap:
    @pytest.mark.parametrize("gap", [1, 2, 5])
    def test_test_start_at_least_gap_after_train_end(self, gap):
        """
        For every fold: test_idx.min() − train_idx.max() >= gap.
        """
        X    = np.arange(30).reshape(-1, 1)
        tscv = TimeSeriesSplit(n_splits=3, gap=gap)
        for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
            distance = test_idx.min() - train_idx.max()
            assert distance >= gap, (
                f"Fold {fold}, gap={gap}: "
                f"test starts at {test_idx.min()}, train ends at {train_idx.max()}, "
                f"distance={distance} < gap"
            )

    def test_no_index_shared_between_train_and_test(self):
        X    = np.arange(20).reshape(-1, 1)
        tscv = TimeSeriesSplit(n_splits=4, gap=2)
        for train_idx, test_idx in tscv.split(X):
            assert len(set(train_idx) & set(test_idx)) == 0

    def test_test_always_newer_than_train(self):
        X    = np.arange(15).reshape(-1, 1)
        tscv = TimeSeriesSplit(n_splits=3, gap=1)
        for train_idx, test_idx in tscv.split(X):
            assert train_idx.max() < test_idx.min()


# ══════════════════════════════════════════════════════════════════════════════
# Cas 3 — Pipeline fit sur train seulement
# ══════════════════════════════════════════════════════════════════════════════

class TestPipelineFitOnTrainOnly:
    def test_scaler_uses_only_train_statistics(self, simple_timeseries):
        """
        StandardScaler fit on a biased X_train must apply those train-derived
        statistics when transforming X_test — it must NOT re-fit on X_test.
        """
        X_train = simple_timeseries[:8].reshape(-1, 1).astype(float) + 5.0
        X_test  = simple_timeseries[8:].reshape(-1, 1).astype(float)

        scaler = StandardScaler()
        scaler.fit(X_train)
        X_test_scaled = scaler.transform(X_test)

        # Expected: apply train mean/std to test values
        expected = (X_test - np.mean(X_train)) / np.std(X_train)
        np.testing.assert_allclose(X_test_scaled, expected, rtol=1e-10)

    def test_pipeline_mean_not_from_test_data(self):
        """
        Fitting on a high-valued X_train (mean≈200) then transforming a
        low-valued X_test (mean≈2): the recorded mean must match the train
        set, not the test set.
        """
        X_train = np.array([[180.], [190.], [200.], [210.], [220.]])  # mean=200
        X_test  = np.array([[1.], [2.], [3.]])                         # mean=2

        pipe = create_pipeline()
        pipe.fit(X_train, np.zeros(len(X_train)))

        recorded_mean = float(pipe.named_steps["scaler"].mean_[0])
        train_mean    = float(np.mean(X_train))

        assert abs(recorded_mean - train_mean) < 1e-9, \
            f"Scaler mean ({recorded_mean:.2f}) != train mean ({train_mean:.2f})"
        assert abs(recorded_mean - float(np.mean(X_test))) > 100.0, \
            "Scaler mean must NOT equal test set mean"


# ══════════════════════════════════════════════════════════════════════════════
# Cas 4 — Gestion des valeurs manquantes
# ══════════════════════════════════════════════════════════════════════════════

class TestNaNHandling:
    def test_pipeline_removes_nan_residuals(self, gaussian_data):
        """After fit+transform the output must contain no NaN values."""
        X_train = gaussian_data[:80]
        X_test  = gaussian_data[80:]

        pipe = create_pipeline()
        pipe.fit(X_train)
        X_out = pipe.transform(X_test)

        assert not np.isnan(X_out).any(), \
            "Pipeline output must not contain NaN after imputation"

    def test_pipeline_does_not_crash_on_nan_input(self, gaussian_data):
        """fit() on data containing NaN must not raise an exception."""
        X = gaussian_data.copy()
        X[5,  1] = np.nan
        X[20, 0] = np.nan

        pipe = create_pipeline()
        try:
            pipe.fit(X)
        except Exception as exc:
            pytest.fail(f"Pipeline raised unexpectedly on NaN input: {exc}")

    def test_imputer_fills_with_train_mean(self):
        """The imputed value for a NaN must equal the column mean of the fit data."""
        X_train = np.array([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])
        X_test  = np.array([[np.nan, 8.0]])

        pipe = create_pipeline()
        pipe.fit(X_train)

        imputed = pipe.named_steps["imputer"].transform(X_test)
        expected_fill = np.mean([1.0, 3.0, 5.0])  # column 0 mean of X_train
        assert abs(imputed[0, 0] - expected_fill) < 1e-9


# ══════════════════════════════════════════════════════════════════════════════
# Cas 5 — Stabilité du schéma des features
# ══════════════════════════════════════════════════════════════════════════════

class TestFeatureSchemaStability:
    def test_same_columns_transform_succeeds(self):
        df_train = pd.DataFrame(np.random.randn(10, 3), columns=["a", "b", "c"])
        df_new   = pd.DataFrame(np.random.randn(5,  3), columns=["a", "b", "c"])

        pipe = create_pipeline()
        pipe.fit(df_train)
        result = pipe.transform(df_new)
        assert result.shape == (5, 3)

    def test_different_column_names_raise_value_error(self):
        """sklearn >= 1.0: fit on ['a','b','c'], transform on ['a','b','d'] → ValueError."""
        df_train = pd.DataFrame(np.random.randn(10, 3), columns=["a", "b", "c"])
        df_wrong = pd.DataFrame(np.random.randn(5,  3), columns=["a", "b", "d"])

        pipe = create_pipeline()
        pipe.fit(df_train)

        with pytest.raises(ValueError):
            pipe.transform(df_wrong)

    def test_extra_column_raises(self):
        df_train = pd.DataFrame(np.random.randn(10, 2), columns=["a", "b"])
        df_extra = pd.DataFrame(np.random.randn(5,  3), columns=["a", "b", "c"])

        pipe = create_pipeline()
        pipe.fit(df_train)

        with pytest.raises((ValueError, Exception)):
            pipe.transform(df_extra)


# ══════════════════════════════════════════════════════════════════════════════
# Cas 6 — Payload JSON invalide (équivalent HTTP 400)
# ══════════════════════════════════════════════════════════════════════════════

class TestInvalidPayload:
    """
    _validate_payload raises ValueError for bad payloads — this is the Python
    enforcement layer that the Node.js mlRoutes.js maps to HTTP 400.
    """

    # Each tuple is (complete_bad_payload, human description).
    # Payloads are fully specified so that each one triggers exactly
    # the intended validation error.
    _BAD = [
        (
            {},
            "empty payload — all required keys missing",
        ),
        (
            {"symb": "SPY"},
            "wrong field name; model_b64/features/feature_names/inv_label_map absent",
        ),
        (
            {"model_b64": "x", "features": {"r": 0.5}, "feature_names": ["r"]},
            "missing inv_label_map",
        ),
        (
            {"model_b64": "x", "features": [0.5, 1.0],
             "feature_names": ["r"], "inv_label_map": {}},
            "features is a list, not a dict",
        ),
        (
            {"model_b64": "x", "features": {"rsi_14": float("inf")},
             "feature_names": ["rsi_14"], "inv_label_map": {}},
            "non-finite feature value",
        ),
        (
            {"model_b64": "x", "features": {"bad name!": 1.0},
             "feature_names": ["bad name!"], "inv_label_map": {}},
            "illegal character in feature name",
        ),
        (
            {"model_b64": "x", "features": {"rsi_14": float("nan")},
             "feature_names": ["rsi_14"], "inv_label_map": {}},
            "NaN feature value",
        ),
    ]

    @pytest.mark.parametrize("bad_payload,description", _BAD)
    def test_invalid_payload_raises_value_error(self, bad_payload, description):
        """Each malformed payload must raise ValueError (≡ HTTP 400 Bad Request)."""
        with pytest.raises(ValueError):
            _validate_payload(bad_payload)

    @pytest.mark.parametrize("bad_payload", [
        {},
        {"symb": "SPY"},
        {"features": [0.5, 1.0]},
    ])
    def test_main_returns_error_json_for_invalid_payload(self, bad_payload):
        """
        When main() receives an invalid payload via stdin it must return
        exit code 1 and write { ok: false } to stdout.
        """
        import json
        from infer import main

        stdin_str  = json.dumps(bad_payload) + "\n"
        stdout_buf = StringIO()

        with patch("sys.stdin",  StringIO(stdin_str)), \
             patch("sys.stdout", stdout_buf):
            rc = main()

        assert rc == 1
        out = json.loads(stdout_buf.getvalue())
        assert out.get("ok") is False


# ══════════════════════════════════════════════════════════════════════════════
# Cas 7 — Latence d'inférence p95 simulée
# ══════════════════════════════════════════════════════════════════════════════

class TestInferenceLatencyP95:
    THRESHOLD_MS = 500.0   # 500 ms hard ceiling for p95

    def test_simulated_normal_distribution_under_threshold(self):
        """
        Synthetic latency distribution centred at 400 ms, σ=50 ms:
        p95 must stay well below 500 ms.
        """
        rng   = np.random.default_rng(42)
        times = rng.normal(loc=400.0, scale=50.0, size=1000)  # milliseconds
        p95   = float(np.percentile(times, 95))
        assert p95 < self.THRESHOLD_MS, \
            f"Simulated p95 = {p95:.1f} ms exceeds threshold {self.THRESHOLD_MS} ms"

    def test_percentile_calculation_correct(self):
        """np.percentile of a known sequence."""
        times = np.linspace(0, 1000, 1001)   # 0, 1, 2, …, 1000 ms
        p95   = float(np.percentile(times, 95))
        assert abs(p95 - 950.0) < 1.0

    def test_worst_case_distribution_detection(self):
        """
        A distribution where 10 % of requests are very slow (mean=800 ms)
        must push p95 above the 500 ms threshold.
        With 900 fast + 100 slow samples: p95 = 50th-from-top = in slow group.
        """
        rng   = np.random.default_rng(0)
        times = np.concatenate([
            rng.normal(100, 20,  900),   # 90 % fast  (~100 ms)
            rng.normal(800, 50,  100),   # 10 % slow  (~800 ms) → p95 in this group
        ])
        p95 = float(np.percentile(times, 95))
        assert p95 > self.THRESHOLD_MS, \
            f"Expected p95={p95:.1f} ms to exceed {self.THRESHOLD_MS} ms threshold"

    @pytest.mark.parametrize("loc,scale,expected_ok", [
        (200, 30,  True),   # fast → p95 ~ 249 ms → OK
        (400, 50,  True),   # moderate → p95 ~ 482 ms → OK
        (600, 100, False),  # slow → p95 ~ 765 ms → fails
    ])
    def test_parametrized_latency_scenarios(self, loc, scale, expected_ok):
        rng   = np.random.default_rng(1)
        times = rng.normal(loc=loc, scale=scale, size=2000)
        p95   = float(np.percentile(times, 95))
        if expected_ok:
            assert p95 < self.THRESHOLD_MS, f"Expected OK, p95={p95:.1f} ms"
        else:
            assert p95 >= self.THRESHOLD_MS, f"Expected FAIL, p95={p95:.1f} ms"


# ══════════════════════════════════════════════════════════════════════════════
# Cas 8 — Champion vs Challenger (données synthétiques séparables)
# ══════════════════════════════════════════════════════════════════════════════

class TestChampionVsChallenger:
    @pytest.fixture
    def separable_data(self):
        """Three perfectly separable classes (XGBoost and LightGBM both get 100%)."""
        X = np.vstack([
            np.zeros((50, 2)),
            np.ones((50, 2)),
            np.full((50, 2), 2.0),
        ])
        y = np.array([0] * 50 + [1] * 50 + [2] * 50)
        return X, y

    def test_xgboost_accuracy_gte_lightgbm(self, separable_data):
        """
        On perfectly separable data, the champion (XGBoost) must perform
        at least as well as the challenger (LightGBM).
        """
        from lightgbm import LGBMClassifier
        from xgboost import XGBClassifier

        X, y = separable_data

        xgb = XGBClassifier(
            objective="multi:softprob",
            num_class=3,
            n_estimators=50,
            random_state=42,
            verbosity=0,
        )
        lgb = LGBMClassifier(
            objective="multiclass",
            num_class=3,
            n_estimators=50,
            random_state=42,
            verbose=-1,
        )

        xgb.fit(X, y)
        lgb.fit(X, y)

        acc_xgb = float(np.mean(xgb.predict(X) == y))
        acc_lgb = float(np.mean(lgb.predict(X) == y))

        assert acc_xgb >= acc_lgb, (
            f"Champion (XGBoost) acc={acc_xgb:.4f} < "
            f"Challenger (LightGBM) acc={acc_lgb:.4f}"
        )

    def test_both_models_near_perfect_on_separable_data(self, separable_data):
        """Both models must achieve > 95 % on linearly-separable classes."""
        from lightgbm import LGBMClassifier
        from xgboost import XGBClassifier

        X, y = separable_data

        for Model, kwargs in [
            (XGBClassifier, {"objective": "multi:softprob", "num_class": 3,
                             "n_estimators": 50, "random_state": 0, "verbosity": 0}),
            (LGBMClassifier, {"objective": "multiclass", "num_class": 3,
                              "n_estimators": 50, "random_state": 0, "verbose": -1}),
        ]:
            m = Model(**kwargs)
            m.fit(X, y)
            acc = float(np.mean(m.predict(X) == y))
            assert acc > 0.95, f"{Model.__name__} accuracy {acc:.4f} too low on separable data"

    @pytest.mark.parametrize("n_estimators", [10, 50, 100])
    def test_xgboost_consistent_across_estimator_counts(self, separable_data, n_estimators):
        """XGBoost must reach ≥ 95 % regardless of n_estimators on separable data."""
        from xgboost import XGBClassifier

        X, y = separable_data
        m = XGBClassifier(objective="multi:softprob", num_class=3,
                          n_estimators=n_estimators, random_state=7, verbosity=0)
        m.fit(X, y)
        acc = float(np.mean(m.predict(X) == y))
        assert acc >= 0.95, f"n_estimators={n_estimators}: acc={acc:.4f} < 0.95"
