#!/usr/bin/env python3
"""
ML Signal Engine - Inference Script
Reads a JSON payload from stdin, loads a serialized model from base64,
runs inference on the provided feature vector, and returns results as JSON to stdout.
"""

import sys
import json
import base64
import pickle
import numpy as np


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Failed to parse input JSON: {e}"}))
        sys.stdout.flush()
        return

    try:
        model_b64 = payload["model_b64"]
        features_raw = payload["features"]
        feature_names = payload.get("feature_names", [])
        inv_label_map = payload.get("inv_label_map", {"1": "positive", "0": "negative", "2": "neutral"})
    except KeyError as e:
        print(json.dumps({"ok": False, "error": f"Missing required field: {e}"}))
        sys.stdout.flush()
        return

    # Deserialize model
    try:
        model_bytes = base64.b64decode(model_b64)
        model = pickle.loads(model_bytes)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Failed to deserialize model: {e}"}))
        sys.stdout.flush()
        return

    # Determine expected feature count from model
    expected_len = None
    try:
        # XGBoost exposes n_features_in_; sklearn estimators also expose this
        expected_len = model.n_features_in_
    except AttributeError:
        pass

    # Build feature vector, padding or truncating as needed
    features = list(features_raw)
    if expected_len is not None and len(features) != expected_len:
        print(
            f"Warning: feature vector length {len(features)} != expected {expected_len}. "
            f"{'Padding with zeros' if len(features) < expected_len else 'Truncating'}.",
            file=sys.stderr,
        )
        if len(features) < expected_len:
            features = features + [0.0] * (expected_len - len(features))
        else:
            features = features[:expected_len]

    try:
        X = np.array(features, dtype=float).reshape(1, -1)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Failed to build feature array: {e}"}))
        sys.stdout.flush()
        return

    # Run inference
    try:
        pred_int = int(model.predict(X)[0])
        proba = model.predict_proba(X)[0]
        classes = model.classes_
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Inference failed: {e}"}))
        sys.stdout.flush()
        return

    # Map predicted integer class back to label string
    prediction_label = inv_label_map.get(str(pred_int), str(pred_int))

    # Build per-class probability dict using inv_label_map
    probabilities = {}
    for cls_int, prob in zip(classes, proba):
        label = inv_label_map.get(str(int(cls_int)), str(int(cls_int)))
        probabilities[label] = round(float(prob), 6)

    # Confidence = probability of the predicted class
    confidence = probabilities.get(prediction_label, float(np.max(proba)))

    result = {
        "ok": True,
        "prediction": prediction_label,
        "confidence": round(confidence, 6),
        "probabilities": probabilities,
        "feature_names": feature_names,
    }

    print(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
