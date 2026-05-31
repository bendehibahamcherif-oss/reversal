"""
Model calibration utilities — ML Signal Engine.

Implements prefit Platt scaling and isotonic regression compatible with
sklearn >= 1.2 (where cv='prefit' was removed from CalibratedClassifierCV).

Public API
----------
calibrate_model(base_model, X_val, y_val, method)  → _PrefitCalibrated
brier_long_class(y_true_int, y_proba, long_class_idx)  → float
calibration_gain(base_brier, calibrated_brier)  → float
get_calibration_curve(...)  → dict
compare_calibration(...)  → dict
"""

from __future__ import annotations

from typing import Any, Dict, List, Union

import numpy as np
from sklearn.calibration import calibration_curve
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss


# ── Prefit calibration wrapper ─────────────────────────────────────────────────


class _PrefitCalibrated:
    """
    Wraps a pre-fitted base model with a Platt or isotonic calibration layer.

    Compatible with sklearn >= 1.2 where cv='prefit' was removed from
    CalibratedClassifierCV.

    For "sigmoid" (Platt): a multinomial LogisticRegression is fitted on the
    base model's output probabilities from the val set.

    For "isotonic": one IsotonicRegression per class (one-vs-rest), with
    row-wise normalisation of the outputs.
    """

    def __init__(
        self,
        base_model: Any,
        calibrator: Union[LogisticRegression, List[IsotonicRegression]],
        method: str = "sigmoid",
    ) -> None:
        self.base_model = base_model
        self.calibrator = calibrator
        self.method     = method

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        base_proba = self.base_model.predict_proba(np.asarray(X, dtype=float))

        if self.method == "sigmoid":
            return self.calibrator.predict_proba(base_proba)

        # Isotonic: apply per-class calibrator, then row-normalise
        out = np.zeros_like(base_proba, dtype=float)
        for i, ir in enumerate(self.calibrator):
            out[:, i] = ir.predict(base_proba[:, i])
        out      = np.clip(out, 0.0, 1.0)
        row_sums = out.sum(axis=1, keepdims=True)
        row_sums = np.where(row_sums > 0, row_sums, 1.0)
        return out / row_sums

    def predict(self, X: np.ndarray) -> np.ndarray:
        return self.predict_proba(X).argmax(axis=1)

    def __sklearn_is_fitted__(self) -> bool:
        return True


# ── Public API ─────────────────────────────────────────────────────────────────


def calibrate_model(
    base_model: Any,
    X_val: np.ndarray,
    y_val: np.ndarray,
    method: str = "sigmoid",
) -> _PrefitCalibrated:
    """
    Calibrate a pre-fitted model using only the validation set.

    No training data is used in the calibration fit — ensures zero temporal
    leakage from train to calibration layer.

    Compatible with sklearn >= 1.2 (cv='prefit' removed in that version).

    Parameters
    ----------
    base_model : Pre-fitted estimator with predict_proba(X) → (n, n_classes).
    X_val      : Validation features (n_samples, n_features).
    y_val      : Integer class labels (0=SHORT, 1=NEUTRAL, 2=LONG).
    method     : "sigmoid" (Platt) or "isotonic".  Sigmoid is preferred when
                 the validation set is small (< 500 rows) as isotonic can
                 overfit.

    Returns
    -------
    _PrefitCalibrated wrapping base_model with the fitted calibration layer.
    """
    base_proba = base_model.predict_proba(np.asarray(X_val, dtype=float))
    y_val_arr  = np.asarray(y_val)

    if method == "sigmoid":
        cal: Union[LogisticRegression, List[IsotonicRegression]] = LogisticRegression(
            C=1.0, max_iter=1000, random_state=0,
        )
        cal.fit(base_proba, y_val_arr)

    elif method == "isotonic":
        n_classes = base_proba.shape[1]
        cal = []
        for i in range(n_classes):
            y_bin = (y_val_arr == i).astype(int)
            ir    = IsotonicRegression(out_of_bounds="clip")
            ir.fit(base_proba[:, i], y_bin)
            cal.append(ir)

    else:
        raise ValueError(
            f"Unknown calibration method {method!r}. "
            "Choose 'sigmoid' or 'isotonic'."
        )

    return _PrefitCalibrated(base_model, cal, method=method)


def brier_long_class(
    y_true_int: np.ndarray,
    y_proba: np.ndarray,
    long_class_idx: int = 2,
) -> float:
    """
    Brier score for the LONG class (one-vs-rest).

    Parameters
    ----------
    y_true_int     : Integer class labels (0, 1, 2).
    y_proba        : (n_samples, n_classes) probability matrix.
    long_class_idx : Column index of the LONG class (default 2).

    Returns
    -------
    Brier score in [0, 1].  Lower is better.
    """
    y_bin       = (np.asarray(y_true_int) == long_class_idx).astype(int)
    proba_long  = np.asarray(y_proba)[:, long_class_idx]
    return float(brier_score_loss(y_bin, proba_long))


def calibration_gain(base_brier: float, calibrated_brier: float) -> float:
    """
    Relative Brier score improvement (positive = calibration helped).

    gain = (base - calibrated) / base
    """
    if base_brier == 0.0:
        return 0.0
    return round((base_brier - calibrated_brier) / base_brier, 6)


def get_calibration_curve(
    y_true_int: np.ndarray,
    y_proba_class: np.ndarray,
    class_name: str,
    class_idx: int,
    n_bins: int = 10,
) -> Dict:
    """
    Compute a reliability (calibration) curve for one class.

    Returns a dict with keys: class, prob_true (list), prob_pred (list).
    Returns empty lists on failure (e.g. too few samples).
    """
    y_bin = (np.asarray(y_true_int) == class_idx).astype(int)
    n_samples = len(y_bin)
    n_bins_actual = min(n_bins, max(2, n_samples // 20))

    try:
        prob_true, prob_pred = calibration_curve(
            y_bin,
            np.asarray(y_proba_class),
            n_bins=n_bins_actual,
            strategy="uniform",
        )
        return {
            "class":     class_name,
            "prob_true": prob_true.tolist(),
            "prob_pred": prob_pred.tolist(),
        }
    except ValueError:
        return {"class": class_name, "prob_true": [], "prob_pred": []}


def compare_calibration(
    y_true_int: np.ndarray,
    y_proba_base: np.ndarray,
    y_proba_cal: np.ndarray,
    long_class_idx: int = 2,
) -> Dict:
    """
    Compare Brier scores before and after calibration for the LONG class.

    Returns
    -------
    Dict with keys: brier_before, brier_after, gain, improved (bool).
    """
    base_brier = brier_long_class(y_true_int, y_proba_base, long_class_idx)
    cal_brier  = brier_long_class(y_true_int, y_proba_cal,  long_class_idx)
    gain       = calibration_gain(base_brier, cal_brier)
    return {
        "brier_before": round(base_brier, 6),
        "brier_after":  round(cal_brier,  6),
        "gain":         gain,
        "improved":     bool(cal_brier < base_brier),
    }
