"""
Persistent inference worker — ML Signal Engine.

Protocol (JSON Lines over stdin/stdout):
  Startup (first stdout line):
      {"ready": true, "model_version": str, "loaded_at": str}

  Input line:
      {
          "request_id":   str,
          "features":     dict[str, float],
          "feature_names": list[str],
          "inv_label_map": dict[str, str]   e.g. {"0": "DOWN", "1": "NEUTRAL", "2": "UP"}
      }

  Output line (success):
      {
          "request_id":    str,
          "ok":            true,
          "signal":        str,
          "probability":   float,
          "confidence":    float,
          "probabilities": dict[str, float],
          "latency_ms":    float
      }

  Output line (error):
      {"request_id": str, "ok": false, "error": str, "code": str}

The process runs until stdin is closed (EOF).  All diagnostic output goes to
stderr so it never contaminates the JSON-Lines stream on stdout.
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np


# ── Resource limits ────────────────────────────────────────────────────────────


def _apply_resource_limits() -> None:
    """
    Optionally restrict CPU time and virtual address space for this process.

    Limits are opt-in via environment variables — nothing is applied unless
    the variables are explicitly set.  This avoids crashing Python import on
    systems where virtual address space is legitimately large (shared libs,
    memory-mapped files).

      ML_WORKER_CPU_LIMIT_S   — CPU-time soft+hard limit in seconds
                                (e.g. "60").  Not applied if unset.
      ML_WORKER_MEM_LIMIT_MB  — Virtual address space cap in MB
                                (e.g. "2048").  Not applied if unset.
                                Tip: set this to at least 2× the model size
                                plus Python overhead (~500 MB) to avoid
                                import failures.

    Linux / macOS only.  Silently skipped on Windows or when the resource
    module is unavailable (e.g. restricted containers).
    """
    try:
        import resource  # noqa: PLC0415  (Unix-only)

        cpu_env = os.environ.get("ML_WORKER_CPU_LIMIT_S")
        mem_env = os.environ.get("ML_WORKER_MEM_LIMIT_MB")

        if cpu_env is not None:
            cpu_s = int(cpu_env)
            # RLIMIT_CPU: SIGXCPU at soft limit, SIGKILL at hard limit
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s))
            print(f"[infer_worker] CPU limit set: {cpu_s}s", file=sys.stderr)

        if mem_env is not None:
            mem_b = int(mem_env) * 1024 * 1024
            # RLIMIT_AS: total virtual address space
            resource.setrlimit(resource.RLIMIT_AS, (mem_b, mem_b))
            print(f"[infer_worker] RAM limit set: {mem_env}MB", file=sys.stderr)

        if cpu_env is None and mem_env is None:
            print(
                "[infer_worker] Resource limits not configured "
                "(set ML_WORKER_CPU_LIMIT_S / ML_WORKER_MEM_LIMIT_MB to enable)",
                file=sys.stderr,
            )

    except (ImportError, AttributeError) as exc:
        # Windows or stripped environment — skip silently
        print(f"[infer_worker] resource module unavailable: {exc}", file=sys.stderr)
    except (ValueError, OSError) as exc:
        # Container already enforces tighter limits, or setrlimit denied
        print(f"[infer_worker] Resource limits not applied: {exc}", file=sys.stderr)


# ── Validation constants ───────────────────────────────────────────────────────

_FEATURE_NAME_RE = re.compile(r"^[a-zA-Z0-9_]{1,64}$")
_MAX_FEATURES    = 256


# ── Path resolution ────────────────────────────────────────────────────────────

def _models_dir() -> Path:
    env = os.environ.get("ML_MODELS_DIR")
    if env:
        return Path(env).resolve()
    # Default: server/ai/models relative to cwd
    return (Path.cwd() / "server" / "ai" / "models").resolve()


# ── Model loading ──────────────────────────────────────────────────────────────

def _load_artifact(artifact_path: str) -> tuple[str, Any]:
    """
    Detect format by file extension and return (model_type, model).

    .json  → XGBoost Booster   (model_type = "xgb")
    .txt   → LightGBM Booster  (model_type = "lgb")
    .pkl   → joblib object     (model_type = "sklearn")
    """
    ext = Path(artifact_path).suffix.lower()

    if ext == ".json":
        import xgboost as xgb  # noqa: PLC0415
        booster = xgb.Booster()
        booster.load_model(artifact_path)
        print(f"[infer_worker] Loaded XGBoost model from {artifact_path!r}", file=sys.stderr)
        return "xgb", booster

    if ext == ".txt":
        import lightgbm as lgb  # noqa: PLC0415
        booster = lgb.Booster(model_file=artifact_path)
        print(f"[infer_worker] Loaded LightGBM model from {artifact_path!r}", file=sys.stderr)
        return "lgb", booster

    # Fallback: joblib pickle (LogisticRegression, pipeline, etc.)
    import joblib  # noqa: PLC0415
    model = joblib.load(artifact_path)
    print(f"[infer_worker] Loaded joblib model from {artifact_path!r}", file=sys.stderr)
    return "sklearn", model


def _load_champion() -> tuple[Any, Any, dict]:
    """
    Read model_metadata.json, resolve the champion artifact, load it.

    Returns (model_type, model, metadata).
    """
    models_dir = _models_dir()
    meta_path  = models_dir / "model_metadata.json"

    if not meta_path.exists():
        raise FileNotFoundError(
            f"model_metadata.json not found in {models_dir!r}. "
            "Run the training pipeline first."
        )

    with open(meta_path) as fh:
        metadata = json.load(fh)

    best_model: str = metadata.get("best_model", "xgb")

    # Use the same filename map as model_registry.py
    _FILENAME_MAP = {
        "logistic": "logistic_baseline.pkl",
        "xgb":      "xgb_champion.json",
        "lgb":      "lgb_challenger.txt",
    }
    filename     = _FILENAME_MAP.get(best_model, f"{best_model}.pkl")
    artifact_path = str(models_dir / filename)

    if not Path(artifact_path).exists():
        raise FileNotFoundError(
            f"Champion artifact not found: {artifact_path!r}"
        )

    model_type, model = _load_artifact(artifact_path)
    return model_type, model, metadata


# ── Request validation ─────────────────────────────────────────────────────────

def _validate_request(payload: dict) -> None:
    """Raise ValueError with a descriptive message on any invalid input."""
    if not isinstance(payload, dict):
        raise ValueError("Request must be a JSON object")

    for key in ("request_id", "features", "feature_names", "inv_label_map"):
        if key not in payload:
            raise ValueError(f"Missing required key: {key!r}")

    if not isinstance(payload["request_id"], str) or not payload["request_id"]:
        raise ValueError("'request_id' must be a non-empty string")

    if not isinstance(payload["features"], dict):
        raise ValueError("'features' must be a JSON object")

    if not isinstance(payload["feature_names"], list):
        raise ValueError("'feature_names' must be a JSON array")

    if not isinstance(payload["inv_label_map"], dict):
        raise ValueError("'inv_label_map' must be a JSON object")

    if len(payload["feature_names"]) > _MAX_FEATURES:
        raise ValueError(
            f"Too many features: {len(payload['feature_names'])} > {_MAX_FEATURES}"
        )

    for name in payload["feature_names"]:
        if not isinstance(name, str) or not _FEATURE_NAME_RE.match(name):
            raise ValueError(
                f"Invalid feature name {name!r} — must match [a-zA-Z0-9_]{{1,64}}"
            )

    for name, val in payload["features"].items():
        if not isinstance(name, str) or not _FEATURE_NAME_RE.match(name):
            raise ValueError(f"Invalid feature key {name!r}")
        if not isinstance(val, (int, float)):
            raise ValueError(
                f"Feature {name!r} value must be a number, got {type(val).__name__}"
            )
        if not math.isfinite(float(val)):
            raise ValueError(f"Feature {name!r} value is not finite: {val!r}")


# ── Inference ──────────────────────────────────────────────────────────────────

def _run_inference(
    model_type: str,
    model: Any,
    feature_names: list[str],
    features: dict[str, float],
    inv_label_map: dict[str, str],
) -> tuple[str, float, float, dict[str, float]]:
    """
    Build the feature vector, run predict_proba, and return
    (signal, probability, confidence, probabilities).

    `probability` and `confidence` are both the max-class probability (kept
    for API symmetry with the existing single-shot infer.py output).
    """
    # Align feature values to model-expected column order; missing → 0.0
    vec = np.array(
        [float(features.get(name, 0.0)) for name in feature_names],
        dtype=np.float64,
    ).reshape(1, -1)

    if model_type == "xgb":
        import xgboost as xgb  # noqa: PLC0415
        dm    = xgb.DMatrix(vec)
        proba = np.asarray(model.predict(dm), dtype=float)
        if proba.ndim == 2:
            proba = proba[0]
    elif model_type == "lgb":
        proba = np.asarray(model.predict(vec), dtype=float)
        if proba.ndim == 2:
            proba = proba[0]
    else:
        # sklearn-compatible: predict_proba returns (n_samples, n_classes)
        proba = np.asarray(model.predict_proba(vec), dtype=float)[0]

    # Guard: if binary output from a wrapper was expanded, trust it; otherwise
    # fall back to a safe normalisation.
    if proba.ndim != 1 or len(proba) == 0:
        raise RuntimeError(f"Unexpected proba shape: {proba.shape}")

    # Normalise to sum=1 (guards against floating-point drift)
    proba_sum = float(proba.sum())
    if proba_sum > 0:
        proba = proba / proba_sum

    pred_idx   = int(np.argmax(proba))
    confidence = round(float(proba[pred_idx]), 6)
    signal     = inv_label_map.get(str(pred_idx), str(pred_idx))

    probabilities = {
        inv_label_map.get(str(i), str(i)): round(float(p), 6)
        for i, p in enumerate(proba)
    }

    return signal, confidence, confidence, probabilities


# ── Main loop ──────────────────────────────────────────────────────────────────

def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    print("[infer_worker] Starting up …", file=sys.stderr)

    # Apply OS-level resource limits before model load so they cover all allocations
    _apply_resource_limits()

    try:
        model_type, model, metadata = _load_champion()
    except Exception as exc:
        print(f"[infer_worker] FATAL — could not load champion model: {exc}", file=sys.stderr)
        # Emit a sentinel so the parent process knows startup failed
        _write({
            "ready":   False,
            "error":   str(exc),
            "code":    type(exc).__name__,
        })
        sys.exit(1)

    model_version = (
        metadata.get("best_model", "unknown")
        + "@"
        + (metadata.get("feature_version") or "unknown")
    )
    loaded_at = datetime.now(timezone.utc).isoformat()

    # Signal readiness to the parent process
    _write({
        "ready":         True,
        "model_version": model_version,
        "loaded_at":     loaded_at,
    })
    print(
        f"[infer_worker] Ready — model={model_version} loaded_at={loaded_at}",
        file=sys.stderr,
    )

    # ── Serve requests until stdin closes ─────────────────────────────────────
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue  # skip blank lines

        t0         = time.monotonic()
        request_id = "<unknown>"

        try:
            payload    = json.loads(raw_line)
            request_id = payload.get("request_id", "<unknown>")
            _validate_request(payload)

            signal, probability, confidence, probabilities = _run_inference(
                model_type      = model_type,
                model           = model,
                feature_names   = payload["feature_names"],
                features        = payload["features"],
                inv_label_map   = payload["inv_label_map"],
            )

            latency_ms = round((time.monotonic() - t0) * 1000, 3)

            _write({
                "request_id":    request_id,
                "ok":            True,
                "signal":        signal,
                "probability":   probability,
                "confidence":    confidence,
                "probabilities": probabilities,
                "latency_ms":    latency_ms,
            })

        except json.JSONDecodeError as exc:
            latency_ms = round((time.monotonic() - t0) * 1000, 3)
            print(f"[infer_worker] JSON parse error: {exc}", file=sys.stderr)
            _write({
                "request_id": request_id,
                "ok":         False,
                "error":      f"JSON parse error: {exc}",
                "code":       "JSONDecodeError",
            })

        except (ValueError, TypeError) as exc:
            latency_ms = round((time.monotonic() - t0) * 1000, 3)
            print(f"[infer_worker] Validation error for {request_id!r}: {exc}", file=sys.stderr)
            _write({
                "request_id": request_id,
                "ok":         False,
                "error":      str(exc),
                "code":       "ValidationError",
            })

        except Exception as exc:
            latency_ms = round((time.monotonic() - t0) * 1000, 3)
            print(
                f"[infer_worker] Inference error for {request_id!r}: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
            _write({
                "request_id": request_id,
                "ok":         False,
                "error":      str(exc),
                "code":       type(exc).__name__,
            })

    print("[infer_worker] stdin closed — exiting.", file=sys.stderr)


if __name__ == "__main__":
    main()
