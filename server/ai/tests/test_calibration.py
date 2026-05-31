"""
Tests for model calibration — CalibratedClassifierCV and Brier score helpers.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from sklearn.linear_model import LogisticRegression

_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE.parent / "training"))

from calibration import (
    brier_long_class,
    calibrate_model,
    calibration_gain,
    compare_calibration,
    get_calibration_curve,
)


# ── Fixtures ───────────────────────────────────────────────────────────────────


@pytest.fixture
def three_class_data():
    """Small 3-class dataset: SHORT=0, NEUTRAL=1, LONG=2."""
    rng = np.random.default_rng(42)
    n   = 300
    X   = rng.standard_normal((n, 10))
    y   = rng.integers(0, 3, n)
    return X, y


@pytest.fixture
def fitted_lr(three_class_data):
    X, y = three_class_data
    lr   = LogisticRegression(max_iter=500, random_state=42)
    lr.fit(X[:200], y[:200])
    return lr, X, y


# ── TestBrierLongClass ─────────────────────────────────────────────────────────


class TestBrierLongClass:
    def test_perfect_prediction_zero_brier(self):
        y     = np.array([2, 2, 1, 0])
        proba = np.array([
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
        ])
        assert brier_long_class(y, proba, long_class_idx=2) == pytest.approx(0.0, abs=1e-6)

    def test_worst_prediction_max_brier(self):
        y     = np.array([2, 2])
        proba = np.array([[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
        assert brier_long_class(y, proba, long_class_idx=2) == pytest.approx(1.0, abs=1e-6)

    def test_returns_float(self, three_class_data):
        X, y  = three_class_data
        proba = np.random.default_rng(0).dirichlet([1, 1, 1], size=len(y))
        result = brier_long_class(y, proba, long_class_idx=2)
        assert isinstance(result, float)

    def test_range_zero_to_one(self, three_class_data):
        X, y  = three_class_data
        proba = np.random.default_rng(1).dirichlet([1, 1, 1], size=len(y))
        result = brier_long_class(y, proba, long_class_idx=2)
        assert 0.0 <= result <= 1.0

    def test_uniform_proba_gives_expected_brier(self):
        # For uniform predictions (1/3) on a balanced dataset the Brier ≈ 0.222
        n     = 300
        y     = np.array([0, 1, 2] * 100)
        proba = np.full((n, 3), 1.0 / 3)
        bs    = brier_long_class(y, proba, long_class_idx=2)
        assert 0.20 <= bs <= 0.24


# ── TestCalibrationGain ────────────────────────────────────────────────────────


class TestCalibrationGain:
    def test_positive_gain_when_improved(self):
        gain = calibration_gain(0.20, 0.15)
        assert gain == pytest.approx(0.25, abs=1e-4)

    def test_zero_gain_when_base_is_zero(self):
        assert calibration_gain(0.0, 0.0) == 0.0

    def test_negative_gain_when_calibration_worse(self):
        assert calibration_gain(0.10, 0.15) < 0.0

    def test_full_improvement_gives_gain_one(self):
        assert calibration_gain(0.10, 0.0) == pytest.approx(1.0, abs=1e-6)


# ── TestCalibrateModel ─────────────────────────────────────────────────────────


class TestCalibrateModel:
    def test_predict_proba_shape(self, fitted_lr):
        lr, X, y = fitted_lr
        cal      = calibrate_model(lr, X[200:250], y[200:250], method="sigmoid")
        proba    = cal.predict_proba(X[250:])
        assert proba.shape == (50, 3)

    def test_proba_rows_sum_to_one(self, fitted_lr):
        lr, X, y = fitted_lr
        cal      = calibrate_model(lr, X[200:250], y[200:250])
        proba    = cal.predict_proba(X[250:])
        np.testing.assert_allclose(proba.sum(axis=1), 1.0, atol=1e-6)

    def test_proba_non_negative(self, fitted_lr):
        lr, X, y = fitted_lr
        cal      = calibrate_model(lr, X[200:250], y[200:250])
        proba    = cal.predict_proba(X[250:])
        assert (proba >= 0.0).all()

    def test_sigmoid_method_does_not_raise(self, fitted_lr):
        lr, X, y = fitted_lr
        cal = calibrate_model(lr, X[200:250], y[200:250], method="sigmoid")
        assert cal is not None

    def test_isotonic_method_does_not_raise(self, fitted_lr):
        lr, X, y = fitted_lr
        cal = calibrate_model(lr, X[200:250], y[200:250], method="isotonic")
        assert cal is not None

    def test_calibrated_reports_fitted(self, fitted_lr):
        lr, X, y = fitted_lr
        cal = calibrate_model(lr, X[200:250], y[200:250])
        assert callable(getattr(cal, "predict_proba", None))
        assert cal.__sklearn_is_fitted__() is True


# ── TestCompareCalibration ─────────────────────────────────────────────────────


class TestCompareCalibration:
    def test_returns_required_keys(self, three_class_data):
        X, y      = three_class_data
        proba     = np.random.default_rng(5).dirichlet([1, 1, 1], size=len(y))
        proba_cal = np.random.default_rng(6).dirichlet([1, 1, 1], size=len(y))
        result    = compare_calibration(y, proba, proba_cal, long_class_idx=2)
        for key in ("brier_before", "brier_after", "gain", "improved"):
            assert key in result, f"Missing key: {key}"

    def test_improved_flag_true_when_cal_lower(self):
        y         = np.array([2, 2, 2, 0, 0, 0, 1, 1, 1] * 10)
        proba_bad = np.full((90, 3), 1.0 / 3)  # uniform — high Brier
        proba_good = np.zeros((90, 3))
        for i, cls in enumerate(y):
            proba_good[i, cls] = 1.0          # perfect — Brier = 0
        result = compare_calibration(y, proba_bad, proba_good, long_class_idx=2)
        assert result["improved"] is True
        assert result["brier_after"] < result["brier_before"]

    def test_improved_flag_false_when_cal_worse(self):
        y          = np.array([2, 2, 2, 0, 0, 0, 1, 1, 1] * 10)
        proba_good = np.zeros((90, 3))
        for i, cls in enumerate(y):
            proba_good[i, cls] = 1.0
        proba_bad = np.full((90, 3), 1.0 / 3)
        result = compare_calibration(y, proba_good, proba_bad, long_class_idx=2)
        assert result["improved"] is False

    def test_gain_is_float(self, three_class_data):
        X, y   = three_class_data
        proba  = np.random.default_rng(7).dirichlet([1, 1, 1], size=len(y))
        result = compare_calibration(y, proba, proba, long_class_idx=2)
        assert isinstance(result["gain"], float)


# ── TestGetCalibrationCurve ────────────────────────────────────────────────────


class TestGetCalibrationCurve:
    def test_output_has_required_keys(self):
        rng       = np.random.default_rng(8)
        y         = rng.integers(0, 3, 100)
        proba_col = rng.random(100)
        result    = get_calibration_curve(y, proba_col, "LONG", class_idx=2, n_bins=5)
        for key in ("class", "prob_true", "prob_pred"):
            assert key in result

    def test_class_name_preserved(self):
        rng  = np.random.default_rng(9)
        y    = rng.integers(0, 3, 100)
        pcol = rng.random(100)
        result = get_calibration_curve(y, pcol, "LONG", class_idx=2)
        assert result["class"] == "LONG"

    def test_equal_length_arrays(self):
        rng  = np.random.default_rng(10)
        y    = rng.integers(0, 3, 100)
        pcol = rng.random(100)
        result = get_calibration_curve(y, pcol, "LONG", class_idx=2, n_bins=5)
        assert len(result["prob_true"]) == len(result["prob_pred"])

    def test_too_few_samples_returns_empty(self):
        y    = np.array([0, 1])
        pcol = np.array([0.1, 0.9])
        result = get_calibration_curve(y, pcol, "LONG", class_idx=2, n_bins=10)
        assert isinstance(result["prob_true"], list)
        assert isinstance(result["prob_pred"], list)
