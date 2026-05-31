"""
Model registry helpers for the training pipeline.

This module is the Python-side counterpart of server/ai/registry/modelRegistryService.js.
It reads/writes the same model_metadata.json format that the Node.js service understands.
"""

import json
import os
from typing import Optional, Tuple

import joblib


# ── Paths ──────────────────────────────────────────────────────────────────────

_MODEL_FILENAME_MAP = {
    "logistic": "logistic_baseline.pkl",
    "xgb":      "xgb_champion.json",
    "lgb":      "lgb_challenger.txt",
}


def get_artifact_path(model_dir: str, model_name: str) -> str:
    filename = _MODEL_FILENAME_MAP.get(model_name, f"{model_name}.pkl")
    return os.path.join(model_dir, filename)


# ── Loading ────────────────────────────────────────────────────────────────────

def load_metadata(model_dir: str) -> Optional[dict]:
    """Read model_metadata.json from *model_dir*, return None if absent."""
    path = os.path.join(model_dir, "model_metadata.json")
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        return json.load(fh)


def load_champion(model_dir: str) -> Tuple[object, dict]:
    """
    Load the champion model and its metadata from *model_dir*.

    Returns
    -------
    (model, metadata)  where model supports predict_proba(X).

    Raises
    ------
    FileNotFoundError if metadata or the champion artifact is missing.
    """
    metadata = load_metadata(model_dir)
    if metadata is None:
        raise FileNotFoundError(f"model_metadata.json not found in {model_dir!r}")

    best_model_name = metadata.get("best_model", "xgb")
    artifact_path   = get_artifact_path(model_dir, best_model_name)

    if not os.path.exists(artifact_path):
        raise FileNotFoundError(f"Champion artifact not found: {artifact_path!r}")

    model = _load_artifact(artifact_path, best_model_name)
    return model, metadata


def load_all_models(model_dir: str) -> dict:
    """Load every model artifact present in *model_dir*."""
    models = {}
    for name, filename in _MODEL_FILENAME_MAP.items():
        path = os.path.join(model_dir, filename)
        if os.path.exists(path):
            models[name] = _load_artifact(path, name)
    return models


# ── Artifact serialisation as base64 ─────────────────────────────────────────
# Used by Node.js inferenceWorker.js to embed models in subprocess stdin payload.

def artifact_to_base64(artifact_path: str) -> str:
    """Read a model file and return its content as a base64 string."""
    import base64
    with open(artifact_path, "rb") as fh:
        return base64.b64encode(fh.read()).decode("ascii")


# ── Internal helpers ───────────────────────────────────────────────────────────

def _load_artifact(path: str, name: str):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".json":
        import xgboost as xgb
        booster = xgb.Booster()
        booster.load_model(path)
        return _XGBWrapper(booster)
    if ext == ".txt":
        import lightgbm as lgb
        booster = lgb.Booster(model_file=path)
        return _LGBWrapper(booster)
    return joblib.load(path)


class _XGBWrapper:
    """Thin sklearn-compatible wrapper around XGBoost Booster."""

    def __init__(self, booster):
        self._booster = booster

    def predict_proba(self, X):
        import xgboost as xgb
        import numpy as np
        dm = xgb.DMatrix(X)
        proba = self._booster.predict(dm)
        if proba.ndim == 1:
            # Binary or single-class — expand to 2-column
            proba = np.column_stack([1 - proba, proba])
        return proba

    def predict(self, X):
        proba = self.predict_proba(X)
        return proba.argmax(axis=1)


class _LGBWrapper:
    """Thin sklearn-compatible wrapper around LightGBM Booster."""

    def __init__(self, booster):
        self._booster = booster

    def predict_proba(self, X):
        import numpy as np
        proba = self._booster.predict(X)
        if proba.ndim == 1:
            proba = np.column_stack([1 - proba, proba])
        return proba

    def predict(self, X):
        proba = self.predict_proba(X)
        return proba.argmax(axis=1)
