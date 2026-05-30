#!/usr/bin/env python3
"""
ML Signal Engine - Training Script
Reads a JSON payload from stdin, trains an XGBoost or RandomForest classifier,
and returns results as JSON to stdout.
"""

import sys
import json
import base64
import pickle
import numpy as np
from collections import Counter

LABEL_MAP = {"positive": 1, "negative": 0, "neutral": 2}
INV_LABEL_MAP = {1: "positive", 0: "negative", 2: "neutral"}


def encode_labels(labels):
    return [LABEL_MAP[l] for l in labels]


def compute_metrics(y_true, y_pred, class_names):
    """Compute accuracy, weighted precision/recall/f1, confusion matrix."""
    from sklearn.metrics import accuracy_score, precision_recall_fscore_support, confusion_matrix

    accuracy = float(accuracy_score(y_true, y_pred))
    precision, recall, f1, support = precision_recall_fscore_support(
        y_true, y_pred, average="weighted", zero_division=0
    )
    total_support = int(np.sum(support)) if support is not None else len(y_true)

    # Build confusion matrix as a nested dict keyed by label names
    labels_present = sorted(set(list(y_true) + list(y_pred)))
    cm = confusion_matrix(y_true, y_pred, labels=labels_present)

    cm_dict = {}
    for i, actual_int in enumerate(labels_present):
        actual_name = INV_LABEL_MAP.get(actual_int, str(actual_int))
        cm_dict[actual_name] = {}
        for j, pred_int in enumerate(labels_present):
            pred_name = INV_LABEL_MAP.get(pred_int, str(pred_int))
            cm_dict[actual_name][pred_name] = int(cm[i][j])

    return {
        "accuracy": round(accuracy, 6),
        "precision": round(float(precision), 6),
        "recall": round(float(recall), 6),
        "f1": round(float(f1), 6),
        "support": total_support,
        "confusion_matrix": cm_dict,
    }


def baseline_accuracy(y_test):
    """Majority-class classifier accuracy on test set."""
    if len(y_test) == 0:
        return 0.0
    counts = Counter(y_test)
    majority_count = counts.most_common(1)[0][1]
    return round(majority_count / len(y_test), 6)


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Failed to parse input JSON: {e}"}))
        sys.stdout.flush()
        return

    try:
        train_features = np.array(payload["train_features"], dtype=float)
        train_labels_raw = payload["train_labels"]
        val_features = np.array(payload["val_features"], dtype=float)
        val_labels_raw = payload["val_labels"]
        test_features = np.array(payload["test_features"], dtype=float)
        test_labels_raw = payload["test_labels"]
        feature_names = payload.get("feature_names", [])
        model_type = payload.get("model_type", "XGBoost")
        horizon = payload.get("horizon", 5)
        params = payload.get("params", {})
    except KeyError as e:
        print(json.dumps({"ok": False, "error": f"Missing required field: {e}"}))
        sys.stdout.flush()
        return
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Failed to process input data: {e}"}))
        sys.stdout.flush()
        return

    try:
        train_labels = encode_labels(train_labels_raw)
        val_labels = encode_labels(val_labels_raw)
        test_labels = encode_labels(test_labels_raw)
    except KeyError as e:
        print(json.dumps({"ok": False, "error": f"Unknown label value: {e}. Expected positive/negative/neutral."}))
        sys.stdout.flush()
        return

    try:
        if model_type == "XGBoost":
            from xgboost import XGBClassifier

            xgb_params = dict(
                n_estimators=200,
                max_depth=4,
                learning_rate=0.1,
                subsample=0.8,
                use_label_encoder=False,
                eval_metric="mlogloss",
                verbosity=0,
            )
            # Override with any caller-supplied params
            xgb_params.update(params)
            model = XGBClassifier(**xgb_params)
        else:
            # RandomForest (also used as fallback for LightGBM / unknown types)
            from sklearn.ensemble import RandomForestClassifier

            rf_params = dict(n_estimators=200, max_depth=6, random_state=42)
            rf_params.update(params)
            model = RandomForestClassifier(**rf_params)
            model_type = "RandomForest"

        print(f"Training {model_type} on {len(train_labels)} samples...", file=sys.stderr)
        model.fit(train_features, train_labels)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Model training failed: {e}"}))
        sys.stdout.flush()
        return

    try:
        val_pred = model.predict(val_features)
        test_pred = model.predict(test_features)

        val_metrics = compute_metrics(val_labels, val_pred.tolist(), list(LABEL_MAP.keys()))
        test_metrics = compute_metrics(test_labels, test_pred.tolist(), list(LABEL_MAP.keys()))

        base_acc = baseline_accuracy(test_labels)
        beats_baseline = test_metrics["accuracy"] > base_acc
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Evaluation failed: {e}"}))
        sys.stdout.flush()
        return

    try:
        importances = model.feature_importances_
        if feature_names and len(feature_names) == len(importances):
            feature_importance = {
                name: round(float(imp), 6)
                for name, imp in zip(feature_names, importances)
            }
        else:
            feature_importance = {
                f"feature_{i}": round(float(imp), 6)
                for i, imp in enumerate(importances)
            }
    except Exception as e:
        print(f"Warning: could not extract feature importance: {e}", file=sys.stderr)
        feature_importance = {}

    try:
        model_bytes = pickle.dumps(model)
        model_b64 = base64.b64encode(model_bytes).decode("utf-8")
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Model serialization failed: {e}"}))
        sys.stdout.flush()
        return

    result = {
        "ok": True,
        "model_b64": model_b64,
        "model_type": model_type,
        "feature_names": feature_names,
        "label_map": LABEL_MAP,
        "inv_label_map": {str(v): k for k, v in LABEL_MAP.items()},
        "val_metrics": val_metrics,
        "test_metrics": test_metrics,
        "baseline_accuracy": base_acc,
        "beats_baseline": beats_baseline,
        "feature_importance": feature_importance,
        "train_samples": len(train_labels),
        "val_samples": len(val_labels),
        "test_samples": len(test_labels),
        "horizon": horizon,
    }

    print(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
