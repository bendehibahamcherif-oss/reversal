"""
Champion model loader — Python-side utility for loading the current champion
model from the models directory.  Used by batch inference and evaluation scripts.
For the real-time Node.js subprocess path, see infer.py.
"""

import json
import os
import sys
from pathlib import Path
from typing import Optional, Tuple

# Allow running from repo root
sys.path.insert(0, str(Path(__file__).parent.parent / "training"))

from model_registry import load_champion, load_metadata  # noqa: E402


# ── Default paths ──────────────────────────────────────────────────────────────

_DEFAULT_MODEL_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "models"
)


def get_champion(model_dir: Optional[str] = None) -> Tuple[object, dict]:
    """
    Load the champion model from *model_dir* (defaults to server/ai/models).

    Returns
    -------
    (model, metadata)

    The model exposes predict_proba(X) → np.ndarray of shape (n_samples, n_classes).
    """
    directory = model_dir or _DEFAULT_MODEL_DIR
    directory = os.path.realpath(directory)
    return load_champion(directory)


def describe_champion(model_dir: Optional[str] = None) -> dict:
    """Return metadata-only without loading the heavyweight model binary."""
    directory = model_dir or _DEFAULT_MODEL_DIR
    directory = os.path.realpath(directory)
    meta = load_metadata(directory)
    if meta is None:
        return {"ok": False, "error": "model_metadata.json not found", "model_dir": directory}
    return {
        "ok":                  True,
        "model_dir":           directory,
        "best_model":          meta.get("best_model"),
        "feature_version":     meta.get("feature_version"),
        "label_spec_version":  meta.get("label_spec_version"),
        "feature_names":       meta.get("feature_names", []),
        "label_definition":    meta.get("label_definition", {}),
        "test_metrics":        meta.get("test_metrics", {}),
        "git_sha":             meta.get("git_sha"),
        "dataset_hash":        meta.get("dataset_hash"),
        "feature_schema_hash": meta.get("feature_schema_hash"),
    }


# ── CLI ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="Describe or validate the champion model")
    p.add_argument("--model-dir", default=None)
    p.add_argument("--json",  action="store_true", help="Output raw JSON")
    args = p.parse_args()

    info = describe_champion(args.model_dir)
    if args.json:
        print(json.dumps(info, indent=2))
    else:
        if not info["ok"]:
            print(f"ERROR: {info['error']}")
            sys.exit(1)
        print(f"Champion : {info['best_model']}")
        print(f"Version  : {info['feature_version']} / {info['label_spec_version']}")
        meta = info.get("label_definition", {})
        print(f"Labels   : {meta.get('classes')}")
        print(f"Horizon  : {meta.get('horizon')} bars")
        tm = info.get("test_metrics", {})
        print(f"Test AUC : {tm.get('roc_auc')}")
        print(f"Test F1  : {tm.get('f1_macro')}")
        print(f"Features : {len(info['feature_names'])} ({', '.join(info['feature_names'][:5])}...)")
