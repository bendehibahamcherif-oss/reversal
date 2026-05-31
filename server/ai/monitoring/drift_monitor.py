"""
drift_monitor.py — PSI-based feature and prediction drift monitor.

Population Stability Index (PSI) measures how much a distribution has shifted
between a reference period (training) and a current production window.

Thresholds (industry standard):
    PSI < 0.10  → stable      (negligible shift)
    PSI < 0.20  → moderate    (some shift, worth monitoring)
    PSI >= 0.20 → critical    (significant shift, consider retraining)
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# ── Thresholds ────────────────────────────────────────────────────────────────

PSI_THRESHOLDS: dict[str, float] = {
    "stable":   0.10,
    "moderate": 0.20,
}  # > 0.20 → critical


def _psi_status(psi: float) -> str:
    """Map a PSI value to a human-readable status string."""
    if psi < PSI_THRESHOLDS["stable"]:
        return "stable"
    if psi < PSI_THRESHOLDS["moderate"]:
        return "moderate"
    return "critical"


# ── Core PSI computation ──────────────────────────────────────────────────────

def compute_psi(
    expected: np.ndarray,
    actual: np.ndarray,
    n_bins: int = 10,
) -> float:
    """
    Population Stability Index between two distributions.

    Parameters
    ----------
    expected : 1-D array — reference distribution (e.g. training data column).
    actual   : 1-D array — current distribution (e.g. live data column).
    n_bins   : Number of equal-frequency bins derived from *expected*.

    Returns
    -------
    float — PSI value (0 = identical distributions).

    Notes
    -----
    Bins are determined entirely from the expected distribution to avoid
    data-snooping.  An epsilon of 1e-4 is added to every bin count before
    normalisation to prevent log(0).
    """
    expected = np.asarray(expected, dtype=float)
    actual   = np.asarray(actual,   dtype=float)

    # Drop NaN / inf from both arrays before binning
    expected = expected[np.isfinite(expected)]
    actual   = actual[np.isfinite(actual)]

    if len(expected) == 0 or len(actual) == 0:
        logger.warning("compute_psi: empty array after filtering — returning 0.0")
        return 0.0

    n_bins = max(2, min(n_bins, len(expected)))

    # Build equal-frequency bins from the expected distribution
    quantiles = np.linspace(0, 100, n_bins + 1)
    breakpoints = np.percentile(expected, quantiles)

    # Deduplicate breakpoints to handle constant/near-constant features
    breakpoints = np.unique(breakpoints)
    if len(breakpoints) < 2:
        # Constant feature — no drift possible
        return 0.0

    # Force the outermost edges to ±inf so every value lands in a bin
    breakpoints[0]  = -np.inf
    breakpoints[-1] =  np.inf

    n_effective_bins = len(breakpoints) - 1

    eps = 1e-4

    # Fraction of values in each bin
    expected_counts = np.histogram(expected, bins=breakpoints)[0].astype(float)
    actual_counts   = np.histogram(actual,   bins=breakpoints)[0].astype(float)

    expected_pct = (expected_counts + eps) / (expected_counts.sum() + eps * n_effective_bins)
    actual_pct   = (actual_counts   + eps) / (actual_counts.sum()   + eps * n_effective_bins)

    psi = float(np.sum((actual_pct - expected_pct) * np.log(actual_pct / expected_pct)))
    return round(max(psi, 0.0), 6)


# ── Feature drift ─────────────────────────────────────────────────────────────

def monitor_feature_drift(
    reference_X: pd.DataFrame,
    current_X: pd.DataFrame,
    feature_names: list,
) -> dict:
    """
    Compute per-feature PSI and an overall summary.

    Parameters
    ----------
    reference_X   : DataFrame — reference feature matrix (training window).
    current_X     : DataFrame — current feature matrix (production window).
    feature_names : Features to evaluate (must be columns in both DataFrames).

    Returns
    -------
    dict with structure::

        {
            "feature_name": {"psi": float, "status": "stable"|"moderate"|"critical"},
            ...,
            "overall": {
                "max_psi":          float,
                "drifted_features": list[str],   # status != "stable"
                "critical_features": list[str],
                "status":           str,
            },
        }
    """
    results: dict[str, dict] = {}
    drifted: list[str]  = []
    critical: list[str] = []
    max_psi = 0.0

    for feat in feature_names:
        if feat not in reference_X.columns or feat not in current_X.columns:
            logger.warning("monitor_feature_drift: feature %r not in both DataFrames — skipped", feat)
            continue

        psi    = compute_psi(reference_X[feat].to_numpy(), current_X[feat].to_numpy())
        status = _psi_status(psi)

        results[feat] = {"psi": psi, "status": status}

        if psi > max_psi:
            max_psi = psi
        if status != "stable":
            drifted.append(feat)
        if status == "critical":
            critical.append(feat)

    overall_status = _psi_status(max_psi)

    results["overall"] = {
        "max_psi":           round(max_psi, 6),
        "drifted_features":  drifted,
        "critical_features": critical,
        "status":            overall_status,
    }

    return results


# ── Prediction drift ──────────────────────────────────────────────────────────

def monitor_prediction_drift(
    reference_preds: np.ndarray,
    current_preds: np.ndarray,
    class_labels: Optional[list] = None,
) -> dict:
    """
    Compare prediction class distributions using PSI.

    Parameters
    ----------
    reference_preds : 1-D array of predicted class labels or integer indices
                      from the reference (training / baseline) window.
    current_preds   : 1-D array of predicted class labels from the current window.
    class_labels    : Ordered list of class names.  If None, derived from the
                      union of values found in both arrays.

    Returns
    -------
    dict::

        {
            "psi":            float,
            "status":         str,
            "reference_dist": {label: fraction, ...},
            "current_dist":   {label: fraction, ...},
        }
    """
    reference_preds = np.asarray(reference_preds)
    current_preds   = np.asarray(current_preds)

    if class_labels is None:
        class_labels = sorted(
            set(reference_preds.tolist()) | set(current_preds.tolist()),
            key=str,
        )

    eps = 1e-4
    n_classes = len(class_labels)

    def _dist(preds: np.ndarray) -> np.ndarray:
        counts = np.array(
            [np.sum(preds == cls) for cls in class_labels],
            dtype=float,
        )
        counts = counts + eps
        return counts / counts.sum()

    ref_dist = _dist(reference_preds)
    cur_dist = _dist(current_preds)

    psi = float(np.sum((cur_dist - ref_dist) * np.log(cur_dist / ref_dist)))
    psi = round(max(psi, 0.0), 6)

    return {
        "psi":    psi,
        "status": _psi_status(psi),
        "reference_dist": {
            str(cls): round(float(ref_dist[i]), 6)
            for i, cls in enumerate(class_labels)
        },
        "current_dist": {
            str(cls): round(float(cur_dist[i]), 6)
            for i, cls in enumerate(class_labels)
        },
    }


# ── DriftMonitor class ────────────────────────────────────────────────────────

class DriftMonitor:
    """
    Stateful drift monitor that accumulates a history of drift checks.

    Typical usage::

        monitor = DriftMonitor(reference_X=X_train, reference_preds=y_train_preds)

        # Later in production:
        result = monitor.check(current_X=X_live, current_preds=y_live_preds)
        if result["feature_drift"]["overall"]["status"] == "critical":
            alert(...)
    """

    def __init__(
        self,
        reference_X: Optional[pd.DataFrame]  = None,
        reference_preds: Optional[np.ndarray] = None,
        max_history: int = 100,
    ) -> None:
        self.reference_X     = reference_X
        self.reference_preds = (
            np.asarray(reference_preds) if reference_preds is not None else None
        )
        self._history: list[dict] = []
        self._max_history = max_history

    # ── Configuration ──────────────────────────────────────────────────────────

    def set_reference(
        self,
        X: pd.DataFrame,
        preds: np.ndarray,
    ) -> None:
        """Replace the reference distributions used for subsequent checks."""
        self.reference_X     = X
        self.reference_preds = np.asarray(preds)
        logger.info(
            "[DriftMonitor] Reference updated — X.shape=%s preds=%d",
            X.shape,
            len(preds),
        )

    # ── Drift check ────────────────────────────────────────────────────────────

    def check(
        self,
        current_X: pd.DataFrame,
        current_preds: np.ndarray,
        feature_names: Optional[list] = None,
    ) -> dict:
        """
        Run both feature and prediction drift checks and append the result to
        internal history.

        Parameters
        ----------
        current_X     : Current-window feature DataFrame.
        current_preds : Current-window predictions (class labels or integers).
        feature_names : Features to evaluate; defaults to reference_X columns.

        Returns
        -------
        Full drift result dict::

            {
                "timestamp":        str (ISO-8601 UTC),
                "feature_drift":    dict (from monitor_feature_drift),
                "prediction_drift": dict (from monitor_prediction_drift),
                "overall_status":   "stable"|"moderate"|"critical",
            }

        Raises
        ------
        RuntimeError if set_reference() has not been called.
        """
        if self.reference_X is None or self.reference_preds is None:
            raise RuntimeError(
                "DriftMonitor.check() called before set_reference() — "
                "provide reference_X and reference_preds first."
            )

        current_preds = np.asarray(current_preds)

        feat_names = feature_names or list(self.reference_X.columns)

        feature_drift    = monitor_feature_drift(
            self.reference_X, current_X, feat_names
        )
        prediction_drift = monitor_prediction_drift(
            self.reference_preds, current_preds
        )

        # Roll up to an overall status (worst of the two)
        feat_status = feature_drift["overall"]["status"]
        pred_status = prediction_drift["status"]
        _rank = {"stable": 0, "moderate": 1, "critical": 2}
        overall_status = (
            feat_status
            if _rank.get(feat_status, 0) >= _rank.get(pred_status, 0)
            else pred_status
        )

        result = {
            "timestamp":        datetime.now(timezone.utc).isoformat(),
            "feature_drift":    feature_drift,
            "prediction_drift": prediction_drift,
            "overall_status":   overall_status,
        }

        self._history.append(result)
        # Keep history bounded
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history :]

        if overall_status == "critical":
            logger.warning(
                "[DriftMonitor] CRITICAL drift detected — feature_max_psi=%.4f "
                "prediction_psi=%.4f",
                feature_drift["overall"]["max_psi"],
                prediction_drift["psi"],
            )
        elif overall_status == "moderate":
            logger.info(
                "[DriftMonitor] Moderate drift — feature_max_psi=%.4f "
                "prediction_psi=%.4f",
                feature_drift["overall"]["max_psi"],
                prediction_drift["psi"],
            )

        return result

    # ── History summary ────────────────────────────────────────────────────────

    def summary(self, last_n: int = 10) -> dict:
        """
        Return a summary of the most recent drift checks.

        Parameters
        ----------
        last_n : Number of most recent checks to include.

        Returns
        -------
        dict::

            {
                "total_checks":     int,
                "recent_checks":    list[dict],   # last_n entries
                "status_counts":    {"stable": int, "moderate": int, "critical": int},
                "latest_status":    str | None,
                "latest_timestamp": str | None,
            }
        """
        recent   = self._history[-last_n:] if self._history else []
        counts: dict[str, int] = {"stable": 0, "moderate": 0, "critical": 0}
        for entry in self._history:
            s = entry.get("overall_status", "stable")
            counts[s] = counts.get(s, 0) + 1

        latest = self._history[-1] if self._history else None

        return {
            "total_checks":     len(self._history),
            "recent_checks":    recent,
            "status_counts":    counts,
            "latest_status":    latest["overall_status"] if latest else None,
            "latest_timestamp": latest["timestamp"]      if latest else None,
        }
