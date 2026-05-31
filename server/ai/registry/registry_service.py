"""
Higher-level service facade wrapping the SQLite ModelRegistry.

Provides a single object (``RegistryService``) whose methods map common
training-pipeline operations to the lower-level ``ModelRegistry`` calls,
handling ID plumbing, error normalisation, and log formatting.

A module-level singleton ``registry_service`` is exported so callers can
simply ``from registry_service import registry_service``.

Import path
-----------
This file lives under ``server/ai/registry/``.  The module inserts both the
``training/`` and ``registry/`` sub-directories into ``sys.path`` at import
time so that it can import ``registry`` without requiring the full package
hierarchy to be on ``PYTHONPATH``.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Dict, List, Optional

# ── Resolve sibling packages regardless of how the module is executed ─────────
_HERE = Path(__file__).parent
_AI_ROOT = _HERE.parent
sys.path.insert(0, str(_AI_ROOT / "training"))
sys.path.insert(0, str(_AI_ROOT / "registry"))

from registry import ModelRegistry, registry as _default_registry  # noqa: E402

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# RegistryService
# ---------------------------------------------------------------------------


class RegistryService:
    """
    Convenience façade over :class:`ModelRegistry`.

    Parameters
    ----------
    reg : ModelRegistry, optional
        The underlying registry instance to delegate to.  Defaults to the
        module-level singleton ``_default_registry``.
    """

    def __init__(self, reg: ModelRegistry = None) -> None:
        self._reg: ModelRegistry = reg if reg is not None else _default_registry

    # ------------------------------------------------------------------
    # Registration & promotion
    # ------------------------------------------------------------------

    def register_and_promote(
        self,
        model_type: str,
        symbol: str,
        artifact_path: str,
        metrics: dict,
        feature_names: List[str],
        feature_schema_hash: str,
        dataset_hash: str,
        git_sha: str,
        label_definition: dict,
        notes: str = "",
    ) -> str:
        """
        Register a new model version and immediately promote it as champion.

        Calls :meth:`ModelRegistry.register_model` then
        :meth:`ModelRegistry.promote_champion` in sequence.

        Parameters
        ----------
        model_type           : Classifier family (e.g. ``"xgb"``).
        symbol               : Instrument ticker (e.g. ``"ES"``).
        artifact_path        : Filesystem path to the saved model artifact.
        metrics              : Evaluation metrics dict (accuracy, f1, auc, …).
        feature_names        : Ordered feature name list.
        feature_schema_hash  : MD5 of the sorted feature name list.
        dataset_hash         : SHA-256 of the training dataset bytes.
        git_sha              : Git commit SHA of the training code.
        label_definition     : Dict describing label construction parameters.
        notes                : Free-text annotation (default ``""``).

        Returns
        -------
        str — the new ``model_id`` (``"model_" + 12-char UUID hex``).
        """
        model_id = self._reg.register_model(
            model_type=model_type,
            symbol=symbol,
            artifact_path=artifact_path,
            metrics=metrics,
            feature_schema_hash=feature_schema_hash,
            dataset_hash=dataset_hash,
            git_sha=git_sha,
            feature_names=feature_names,
            label_definition=label_definition,
            notes=notes,
        )
        self._reg.promote_champion(model_id)
        logger.info(
            "[registry_service] Registered and promoted model %s  type=%s  symbol=%s",
            model_id,
            model_type,
            symbol,
        )
        return model_id

    # ------------------------------------------------------------------
    # Training run logging
    # ------------------------------------------------------------------

    def log_training_run(
        self,
        model_id: str,
        config: dict,
        metrics: dict,
        status: str = "completed",
    ) -> str:
        """
        Log a completed training run associated with *model_id*.

        Parameters
        ----------
        model_id : str  — FK into MODEL_VERSION.
        config   : dict — hyperparameters / pipeline configuration.
        metrics  : dict — full metrics captured at run end.
        status   : str  — ``"completed"``, ``"failed"``, or ``"running"``.

        Returns
        -------
        str — the new ``run_id`` (``"run_" + 12-char UUID hex``).
        """
        run_id = self._reg.log_train_run(
            model_id=model_id,
            config=config,
            metrics=metrics,
            status=status,
        )
        logger.info(
            "[registry_service] Logged training run %s for model %s (status=%s)",
            run_id,
            model_id,
            status,
        )
        return run_id

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    def get_champion_info(self, symbol: str = None) -> Optional[dict]:
        """
        Return the current champion model's metadata dict, or *None*.

        Parameters
        ----------
        symbol : str, optional
            Filter by instrument symbol.  When *None* the most recently
            updated champion across all symbols is returned.

        Returns
        -------
        dict or None — all MODEL_VERSION columns with decoded JSON fields.
        """
        return self._reg.get_champion(symbol=symbol)

    def list_recent_runs(self, limit: int = 20) -> List[dict]:
        """
        List the most recently registered model versions.

        Parameters
        ----------
        limit : int
            Maximum number of records to return (default 20).

        Returns
        -------
        List[dict] — model records ordered newest first.
        """
        all_models = self._reg.list_models()
        return all_models[:limit]


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

registry_service = RegistryService()
"""
Module-level :class:`RegistryService` singleton.

Usage::

    from registry_service import registry_service

    model_id = registry_service.register_and_promote(
        model_type="xgb",
        symbol="ES",
        artifact_path="/models/xgb_champion.json",
        metrics={"accuracy": 0.62},
        feature_names=["ret_1", "ret_5", ...],
        feature_schema_hash="abc123",
        dataset_hash="def456",
        git_sha="a1b2c3d",
        label_definition={"horizon": 20, "tau_up": 0.005},
    )
"""
