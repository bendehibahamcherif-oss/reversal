"""
Python inference bridge — called as a subprocess by Node.js inferenceWorker.js.

Protocol (one request per process invocation):
  stdin  : single JSON line with keys:
               model_b64       str   Base64-encoded model artifact bytes
               features        dict  { featureName: number }
               feature_names   list  Ordered feature names the model expects
               inv_label_map   dict  { "0": "DOWN", "1": "NEUTRAL", "2": "UP" }

  stdout : single JSON line:
               ok              bool
               prediction      str   e.g. "UP"
               confidence      float Probability of the predicted class
               probabilities   dict  { "DOWN": float, "NEUTRAL": float, "UP": float }

  stderr : error messages only (never written on success)

Exit codes: 0 success, 1 schema/runtime error.

Security: feature names are validated against a strict allowlist pattern to
prevent injection.  No shell commands are executed.
"""

import base64
import io
import json
import os
import re
import sys
import time

import numpy as np

# ── Validation ─────────────────────────────────────────────────────────────────

_FEATURE_NAME_RE = re.compile(r"^[a-zA-Z0-9_]{1,64}$")
_SYMBOL_RE       = re.compile(r"^[A-Z0-9.^/=-]{1,20}$")
_MAX_FEATURES    = 512


def _validate_payload(payload: dict) -> None:
    if not isinstance(payload, dict):
        raise ValueError("Payload must be a JSON object")
    for required in ("model_b64", "features", "feature_names", "inv_label_map"):
        if required not in payload:
            raise ValueError(f"Missing required key: {required!r}")
    if not isinstance(payload["features"], dict):
        raise ValueError("'features' must be a JSON object")
    if not isinstance(payload["feature_names"], list):
        raise ValueError("'feature_names' must be a JSON array")
    if not isinstance(payload["inv_label_map"], dict):
        raise ValueError("'inv_label_map' must be a JSON object")
    if len(payload["features"]) > _MAX_FEATURES:
        raise ValueError(f"Too many features (max {_MAX_FEATURES})")
    for name in payload["features"]:
        if not _FEATURE_NAME_RE.match(str(name)):
            raise ValueError(f"Invalid feature name: {name!r}")
    for v in payload["features"].values():
        if not isinstance(v, (int, float)) or not np.isfinite(float(v)):
            raise ValueError(f"Feature values must be finite numbers, got: {v!r}")


# ── Model loading from base64 ──────────────────────────────────────────────────

def _load_model_from_b64(model_b64: str):
    """
    Detect model format from the decoded bytes and load accordingly:
        XGBoost JSON  → starts with "{"
        LightGBM text → starts with "tree"
        joblib pickle → everything else
    """
    raw = base64.b64decode(model_b64)

    # Peek at the first bytes to detect format
    magic = raw[:4]

    if raw[:1] == b"{":
        # XGBoost native JSON
        import xgboost as xgb
        booster = xgb.Booster()
        booster.load_model(bytearray(raw))
        return ("xgb", booster)

    if raw[:4] == b"tree":
        # LightGBM text format
        import lightgbm as lgb
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        try:
            booster = lgb.Booster(model_file=tmp_path)
        finally:
            os.unlink(tmp_path)
        return ("lgb", booster)

    # Fallback: joblib pickle (sklearn LogisticRegression etc.)
    import joblib
    model = joblib.load(io.BytesIO(raw))
    return ("sklearn", model)


# ── Inference ──────────────────────────────────────────────────────────────────

def _run_inference(model_type: str, model, feature_vector: np.ndarray, inv_label_map: dict) -> dict:
    """Run predict_proba and build the output dict."""
    X = feature_vector.reshape(1, -1)

    if model_type == "xgb":
        import xgboost as xgb
        dm    = xgb.DMatrix(X)
        proba = model.predict(dm)[0]           # shape: (n_classes,)
    elif model_type == "lgb":
        proba = model.predict(X)[0]
    else:
        proba = model.predict_proba(X)[0]

    proba = np.asarray(proba, dtype=float)

    pred_idx    = int(np.argmax(proba))
    confidence  = float(proba[pred_idx])
    prediction  = inv_label_map.get(str(pred_idx), str(pred_idx))

    probabilities = {
        inv_label_map.get(str(i), str(i)): round(float(p), 6)
        for i, p in enumerate(proba)
    }

    return {
        "ok":            True,
        "prediction":    prediction,
        "confidence":    round(confidence, 6),
        "probabilities": probabilities,
    }


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> int:
    t0 = time.monotonic()
    try:
        raw_input = sys.stdin.readline()
        if not raw_input.strip():
            raise ValueError("Empty stdin — no payload received")

        payload = json.loads(raw_input)
        _validate_payload(payload)

        model_b64     = payload["model_b64"]
        features      = payload["features"]
        feature_names = payload["feature_names"]
        inv_label_map = payload["inv_label_map"]

        # Build feature vector aligned to model's expected column order
        feature_vector = np.array(
            [float(features.get(name, 0.0)) for name in feature_names],
            dtype=float,
        )

        model_type, model = _load_model_from_b64(model_b64)

        result = _run_inference(model_type, model, feature_vector, inv_label_map)
        result["latencyMs"] = round((time.monotonic() - t0) * 1000, 2)

        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()
        return 0

    except Exception as exc:
        error_payload = {
            "ok":    False,
            "error": str(exc),
            "code":  type(exc).__name__,
        }
        sys.stdout.write(json.dumps(error_payload) + "\n")
        sys.stdout.flush()
        print(f"[infer.py] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
