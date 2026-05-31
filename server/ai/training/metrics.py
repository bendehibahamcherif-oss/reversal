"""
Evaluation metrics for multiclass ML Signal Engine.

All functions return plain Python dicts (JSON-serialisable after applying
the numpy default encoder from dataset_utils._json_default).
"""

from typing import Dict, List, Optional

import numpy as np
from sklearn.calibration import calibration_curve
from sklearn.metrics import (
    brier_score_loss,
    confusion_matrix,
    f1_score,
    roc_auc_score,
)


# ── Main evaluation function ───────────────────────────────────────────────────

def evaluate_classification_metrics(
    y_true,
    y_pred,
    y_proba: np.ndarray,
    model_name: str = "",
    class_labels: Optional[List[str]] = None,
    calibration_class: Optional[str] = None,
) -> Dict:
    """
    Compute ROC AUC, F1-macro, Brier score, confusion matrix and calibration
    curve for a multiclass classifier.

    Parameters
    ----------
    y_true          : 1-D array-like of ground-truth string labels.
    y_pred          : 1-D array-like of predicted string labels.
    y_proba         : 2-D array of shape (n_samples, n_classes) — predict_proba output.
    model_name      : Human-readable name for logging.
    class_labels    : Ordered list of class names matching y_proba columns.
                      If None, derived from sorted(unique(y_true)).
    calibration_class: Which class to use for the calibration curve.
                      Defaults to the last class (e.g. "UP").

    Returns
    -------
    dict with keys: roc_auc, f1_macro, brier_score, confusion_matrix,
                    calibration_curve, class_labels, n_samples, model_name.
    """
    y_true  = np.asarray(y_true)
    y_pred  = np.asarray(y_pred)
    y_proba = np.asarray(y_proba, dtype=float)

    if class_labels is None:
        class_labels = sorted(set(y_true.tolist()))

    n_classes = len(class_labels)
    n_samples = len(y_true)

    # ── ROC AUC ────────────────────────────────────────────────────────────────
    roc_auc = None
    try:
        if n_classes == 2:
            roc_auc = float(roc_auc_score(y_true, y_proba[:, 1]))
        else:
            roc_auc = float(
                roc_auc_score(y_true, y_proba, multi_class="ovr", average="macro",
                              labels=class_labels)
            )
    except (ValueError, IndexError):
        roc_auc = None

    # ── F1 macro ───────────────────────────────────────────────────────────────
    f1 = float(f1_score(y_true, y_pred, average="macro", zero_division=0))

    # ── Brier score (one-vs-rest for the reference class) ─────────────────────
    ref_cls  = calibration_class or class_labels[-1]
    ref_idx  = class_labels.index(ref_cls) if ref_cls in class_labels else -1
    brier    = None
    if 0 <= ref_idx < y_proba.shape[1]:
        y_bin  = (y_true == ref_cls).astype(int)
        brier  = float(brier_score_loss(y_bin, y_proba[:, ref_idx]))

    # ── Confusion matrix ───────────────────────────────────────────────────────
    cm = confusion_matrix(y_true, y_pred, labels=class_labels)

    # ── Calibration curve for the reference class ──────────────────────────────
    cal_curve = None
    if 0 <= ref_idx < y_proba.shape[1] and n_samples >= 20:
        try:
            y_bin = (y_true == ref_cls).astype(int)
            n_bins = min(10, max(2, n_samples // 20))
            prob_true, prob_pred = calibration_curve(y_bin, y_proba[:, ref_idx],
                                                     n_bins=n_bins)
            cal_curve = {
                "prob_true":  prob_true.tolist(),
                "prob_pred":  prob_pred.tolist(),
                "class":      ref_cls,
            }
        except ValueError:
            cal_curve = None

    # ── Per-class precision / recall ───────────────────────────────────────────
    per_class = _per_class_metrics(y_true, y_pred, class_labels)

    return {
        "model_name":       model_name,
        "n_samples":        n_samples,
        "class_labels":     class_labels,
        "roc_auc":          roc_auc,
        "f1_macro":         f1,
        "brier_score":      brier,
        "confusion_matrix": cm.tolist(),
        "per_class":        per_class,
        "calibration_curve": cal_curve,
    }


# ── Per-class helpers ──────────────────────────────────────────────────────────

def _per_class_metrics(y_true, y_pred, class_labels: List[str]) -> Dict:
    result = {}
    for cls in class_labels:
        tp = int(np.sum((y_true == cls) & (y_pred == cls)))
        fp = int(np.sum((y_true != cls) & (y_pred == cls)))
        fn = int(np.sum((y_true == cls) & (y_pred != cls)))
        prec  = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        rec   = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1_c  = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0
        result[cls] = {"precision": round(prec, 4), "recall": round(rec, 4), "f1": round(f1_c, 4),
                       "support": int(np.sum(y_true == cls))}
    return result


def format_metrics_summary(metrics: Dict) -> str:
    """One-line summary suitable for logging."""
    auc  = f"{metrics['roc_auc']:.4f}" if metrics.get("roc_auc") is not None else "N/A"
    f1   = f"{metrics['f1_macro']:.4f}" if metrics.get("f1_macro") is not None else "N/A"
    bs   = f"{metrics['brier_score']:.4f}" if metrics.get("brier_score") is not None else "N/A"
    name = metrics.get("model_name", "")
    return f"[{name}] AUC={auc} | F1-macro={f1} | Brier={bs} | n={metrics.get('n_samples', '?')}"
