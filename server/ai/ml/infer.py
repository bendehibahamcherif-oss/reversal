#!/usr/bin/env python3
"""
ML Signal Engine - Inference Script

Reads a JSON payload from stdin:
  {
    "model_path":    str,          # absolute path to model artifact (validated)
    "features":      list[float],  # feature vector (aligned to featureSet order)
    "feature_names": list[str],    # optional, echoed back in response
    "inv_label_map": dict          # {"0": "SHORT", "1": "NEUTRAL", "2": "LONG"}
  }

Returns JSON to stdout:
  {"ok": true, "prediction": str, "confidence": float, "probabilities": {...}}
  {"ok": false, "error": str}

Security: model_path is validated to be within ML_MODELS_DIR before loading.
Models are loaded by file extension (no pickle of untrusted data).
"""

import sys
import json
import os
import numpy as np


def _resolve_models_dir():
    env = os.environ.get("ML_MODELS_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.abspath(os.path.join(os.getcwd(), "server", "ai", "models"))


def _load_model(model_path: str):
    """Load model by file extension. Raises on unknown extension."""
    ext = os.path.splitext(model_path)[1].lower()

    if ext == ".json":
        import xgboost as xgb
        booster = xgb.Booster()
        booster.load_model(model_path)
        return "xgb", booster

    if ext == ".txt":
        import lightgbm as lgb
        booster = lgb.Booster(model_file=model_path)
        return "lgb", booster

    # Fallback: joblib (LogisticRegression, sklearn pipelines)
    import joblib
    return "sklearn", joblib.load(model_path)


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Failed to parse input JSON: {e}"}))
        sys.stdout.flush()
        return

    try:
        model_path     = payload["model_path"]
        features_raw   = payload["features"]
        feature_names  = payload.get("feature_names", [])
        inv_label_map  = payload.get("inv_label_map", {"0": "SHORT", "1": "NEUTRAL", "2": "LONG"})
    except KeyError as e:
        print(json.dumps({"ok": False, "error": f"Missing required field: {e}"}))
        sys.stdout.flush()
        return

    # Validate model_path is within the allowed models directory
    allowed_dir = _resolve_models_dir()
    abs_path    = os.path.abspath(model_path)
    if not abs_path.startswith(allowed_dir + os.sep) and abs_path != allowed_dir:
        print(json.dumps({
            "ok":    False,
            "error": f"model_path is outside the allowed models directory: {model_path!r}",
        }))
        sys.stdout.flush()
        return

    if not os.path.isfile(abs_path):
        print(json.dumps({"ok": False, "error": f"Model artifact not found: {model_path!r}"}))
        sys.stdout.flush()
        return

    # Load model safely by file extension
    try:
        model_type, model = _load_model(abs_path)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Failed to load model: {e}"}))
        sys.stdout.flush()
        return

    # Determine expected feature count
    expected_len = getattr(model, "n_features_in_", None)

    features = list(features_raw)
    if expected_len is not None and len(features) != expected_len:
        print(
            f"Warning: feature vector length {len(features)} != expected {expected_len}.",
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
        if model_type == "xgb":
            import xgboost as xgb
            dm     = xgb.DMatrix(X)
            proba  = model.predict(dm)
            proba  = proba[0] if proba.ndim == 2 else proba
            pred_idx = int(np.argmax(proba))
            classes  = list(range(len(proba)))
        elif model_type == "lgb":
            proba    = model.predict(X)
            proba    = proba[0] if proba.ndim == 2 else proba
            pred_idx = int(np.argmax(proba))
            classes  = list(range(len(proba)))
        else:
            proba    = model.predict_proba(X)[0]
            pred_idx = int(model.predict(X)[0])
            classes  = list(model.classes_)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Inference failed: {e}"}))
        sys.stdout.flush()
        return

    prediction_label = inv_label_map.get(str(pred_idx), str(pred_idx))

    probabilities = {}
    for cls_int, prob in zip(classes, proba):
        label = inv_label_map.get(str(int(cls_int)), str(int(cls_int)))
        probabilities[label] = round(float(prob), 6)

    confidence = probabilities.get(prediction_label, float(np.max(proba)))

    result = {
        "ok":            True,
        "prediction":    prediction_label,
        "confidence":    round(confidence, 6),
        "probabilities": probabilities,
        "feature_names": feature_names,
    }

    print(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
