"""
SQLite-based model registry for the ML Signal Engine.

The database file is resolved in this priority order:
    1. ``db_path`` argument passed to ``ModelRegistry.__init__``
    2. ``ML_REGISTRY_DB`` environment variable
    3. ``<repo_root>/server/ai/registry/registry.db``  (default)

where ``repo_root`` is the directory containing this file's grandparent
package (``reversal/server/ai/registry`` → ``reversal``).

Tables
------
MODEL_VERSION     — one row per registered model artifact.
TRAIN_RUN         — one row per training run associated with a model version.
FEATURE_SCHEMA    — content-addressed store of feature name lists.
DATASET_VERSION   — one row per dataset snapshot (keyed by hash).
MODEL_CARD        — Markdown documentation keyed by model_version_id.

All JSON columns (``*_json`` suffix) are automatically decoded to Python
objects by the internal ``_row_to_dict`` helper, so callers receive plain
dicts/lists rather than raw JSON strings.

Public API
----------
ModelRegistry          — class with all registry operations.
registry               — module-level singleton using the default DB path.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Generator, List, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------

_THIS_DIR = Path(__file__).parent


def _default_db_path() -> Path:
    """
    Return the default path for the registry SQLite database.

    Resolution order:
        1. ``ML_REGISTRY_DB`` environment variable (if set and non-empty).
        2. ``<this_dir>/registry.db``  (server/ai/registry/registry.db).
    """
    env_val = os.environ.get("ML_REGISTRY_DB", "").strip()
    if env_val:
        return Path(env_val)
    return _THIS_DIR / "registry.db"


# ---------------------------------------------------------------------------
# DDL — all tables created with IF NOT EXISTS
# ---------------------------------------------------------------------------

_DDL: str = """
CREATE TABLE IF NOT EXISTS MODEL_VERSION (
    id                    TEXT    PRIMARY KEY,
    model_type            TEXT    NOT NULL,
    symbol                TEXT    NOT NULL,
    status                TEXT    NOT NULL DEFAULT 'registered',
    artifact_path         TEXT    NOT NULL DEFAULT '',
    metrics_json          TEXT    NOT NULL DEFAULT '{}',
    feature_schema_hash   TEXT    NOT NULL DEFAULT '',
    dataset_hash          TEXT    NOT NULL DEFAULT '',
    git_sha               TEXT    NOT NULL DEFAULT '',
    feature_names_json    TEXT    NOT NULL DEFAULT '[]',
    label_definition_json TEXT    NOT NULL DEFAULT '{}',
    notes                 TEXT    NOT NULL DEFAULT '',
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS TRAIN_RUN (
    id               TEXT    PRIMARY KEY,
    model_version_id TEXT    NOT NULL REFERENCES MODEL_VERSION(id),
    status           TEXT    NOT NULL DEFAULT 'completed',
    config_json      TEXT    NOT NULL DEFAULT '{}',
    metrics_json     TEXT    NOT NULL DEFAULT '{}',
    started_at       TEXT    NOT NULL,
    completed_at     TEXT
);

CREATE TABLE IF NOT EXISTS FEATURE_SCHEMA (
    hash               TEXT PRIMARY KEY,
    feature_names_json TEXT NOT NULL DEFAULT '[]',
    created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS DATASET_VERSION (
    id            TEXT    PRIMARY KEY,
    symbol        TEXT    NOT NULL,
    timeframe     TEXT    NOT NULL DEFAULT '1m',
    dataset_hash  TEXT    NOT NULL UNIQUE,
    parquet_path  TEXT    NOT NULL DEFAULT '',
    row_count     INTEGER NOT NULL DEFAULT 0,
    feature_count INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS MODEL_CARD (
    model_version_id TEXT PRIMARY KEY REFERENCES MODEL_VERSION(id),
    card_markdown    TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL
);
"""

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    """Return the current UTC timestamp as an ISO-8601 string (with Z suffix)."""
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def _new_id(prefix: str = "model") -> str:
    """Return a prefixed short UUID string (prefix + _ + 12-char hex)."""
    return f"{prefix}_{uuid4().hex[:12]}"


def _json_dumps(obj) -> str:
    """
    JSON-serialise *obj*.

    Handles numpy scalars / arrays when numpy is installed; otherwise falls
    back to the standard TypeError for truly un-serialisable types.
    """
    def _default(o):
        try:
            import numpy as np  # noqa: PLC0415
            if isinstance(o, (np.integer,)):
                return int(o)
            if isinstance(o, (np.floating,)):
                return float(o)
            if isinstance(o, np.ndarray):
                return o.tolist()
        except ImportError:
            pass
        raise TypeError(f"Object of type {type(o).__name__} is not JSON serialisable")

    return json.dumps(obj, default=_default)


def _row_to_dict(row: sqlite3.Row) -> dict:
    """
    Convert a ``sqlite3.Row`` to a plain dict.

    Any column whose name ends with ``_json`` is parsed from JSON so
    callers receive Python objects (dicts/lists) instead of raw strings.
    Parsed values are stored under the key *without* the ``_json`` suffix,
    keeping the original ``_json`` key as well for backward compatibility.
    """
    d = dict(row)
    for key in list(d.keys()):
        if key.endswith("_json") and isinstance(d[key], str):
            try:
                parsed = json.loads(d[key])
                d[key] = parsed
                # Also expose under the short name (e.g. "metrics" alongside "metrics_json")
                short_key = key[: -len("_json")]
                if short_key not in d:
                    d[short_key] = parsed
            except (json.JSONDecodeError, TypeError):
                pass
    return d


# ---------------------------------------------------------------------------
# ModelRegistry
# ---------------------------------------------------------------------------

class ModelRegistry:
    """
    SQLite-backed model registry for the ML Signal Engine.

    All public methods are safe to call before :meth:`initialize` — they
    call it implicitly on first use.  The connection is opened, used, and
    closed for every operation so multi-threaded callers do not share
    SQLite state.

    Parameters
    ----------
    db_path : str, optional
        Explicit path to the SQLite database file.  When *None* the path
        is determined by :func:`_default_db_path` (env var or canonical
        repo location).
    """

    def __init__(self, db_path: Optional[str] = None) -> None:
        resolved = Path(db_path) if db_path is not None else _default_db_path()
        self.db_path: str = str(resolved)
        self._initialised: bool = False

    # ------------------------------------------------------------------
    # Internal connection management
    # ------------------------------------------------------------------

    @contextmanager
    def _conn(self) -> Generator[sqlite3.Connection, None, None]:
        """
        Context manager that opens a SQLite connection, yields it, commits
        on clean exit, rolls back on exception, and always closes.
        """
        os.makedirs(os.path.dirname(os.path.abspath(self.db_path)), exist_ok=True)
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Schema initialisation
    # ------------------------------------------------------------------

    def initialize(self) -> None:
        """
        Create all registry tables if they do not already exist.

        This method is idempotent — safe to call at application start-up
        every time.  All DDL runs in a single transaction so the schema is
        either fully applied or not at all.
        """
        with self._conn() as conn:
            conn.executescript(_DDL)
        self._initialised = True
        logger.debug("[registry] Initialised database at %s", self.db_path)

    def _ensure_init(self) -> None:
        """Call :meth:`initialize` if not yet done this process lifetime."""
        if not self._initialised:
            self.initialize()

    # ------------------------------------------------------------------
    # Model registration
    # ------------------------------------------------------------------

    def register_model(
        self,
        model_type: str,
        symbol: str,
        artifact_path: str,
        metrics: dict,
        feature_schema_hash: str,
        dataset_hash: str,
        git_sha: str,
        feature_names: list,
        label_definition: dict,
        notes: str = "",
    ) -> str:
        """
        Register a new model version in the registry.

        Also upserts the feature schema into FEATURE_SCHEMA (no-op if the
        hash is already known).

        Parameters
        ----------
        model_type          : Classifier family string (e.g. ``"xgb"``).
        symbol              : Instrument ticker (e.g. ``"AAPL"``).
        artifact_path       : Path to the saved model artifact.
        metrics             : Evaluation metrics dict (accuracy, f1, …).
        feature_schema_hash : MD5 of the sorted feature name list.
        dataset_hash        : SHA-256 of the training dataset Parquet bytes.
        git_sha             : Git commit SHA used to produce this model.
        feature_names       : Ordered list of feature column names.
        label_definition    : Dict describing label construction parameters.
        notes               : Free-text notes (default ``""``).

        Returns
        -------
        str — the new model_id (``"model_" + 12-char UUID hex``).
        """
        self._ensure_init()

        model_id = _new_id("model")
        now = _now_iso()

        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO MODEL_VERSION
                    (id, model_type, symbol, status, artifact_path,
                     metrics_json, feature_schema_hash, dataset_hash, git_sha,
                     feature_names_json, label_definition_json, notes,
                     created_at, updated_at)
                VALUES (?,?,?,'registered',?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    model_id,
                    model_type,
                    symbol,
                    artifact_path,
                    _json_dumps(metrics),
                    feature_schema_hash,
                    dataset_hash,
                    git_sha,
                    _json_dumps(feature_names),
                    _json_dumps(label_definition),
                    notes,
                    now,
                    now,
                ),
            )
            # Upsert feature schema — silently skip duplicate hashes
            conn.execute(
                """
                INSERT OR IGNORE INTO FEATURE_SCHEMA
                    (hash, feature_names_json, created_at)
                VALUES (?,?,?)
                """,
                (feature_schema_hash, _json_dumps(feature_names), now),
            )

        logger.info(
            "[registry] Registered model %s  type=%s  symbol=%s",
            model_id,
            model_type,
            symbol,
        )
        return model_id

    # ------------------------------------------------------------------
    # Champion / challenger promotion
    # ------------------------------------------------------------------

    def promote_champion(self, model_id: str) -> None:
        """
        Promote *model_id* to ``champion`` status.

        Any existing champion for the same symbol is atomically demoted to
        ``challenger``.  The targeted model must already exist.

        Parameters
        ----------
        model_id : str — UUID of the model to promote.

        Raises
        ------
        ValueError
            If *model_id* does not exist in the registry.
        """
        self._ensure_init()

        model = self.get_model(model_id)
        if model is None:
            raise ValueError(f"Model not found: {model_id!r}")

        symbol = model["symbol"]
        now = _now_iso()

        with self._conn() as conn:
            conn.execute(
                """
                UPDATE MODEL_VERSION
                SET    status = 'challenger', updated_at = ?
                WHERE  symbol = ? AND status = 'champion'
                """,
                (now, symbol),
            )
            conn.execute(
                """
                UPDATE MODEL_VERSION
                SET    status = 'champion', updated_at = ?
                WHERE  id = ?
                """,
                (now, model_id),
            )

        logger.info(
            "[registry] Promoted %s to champion for symbol %s", model_id, symbol
        )

    def get_champion(self, symbol: Optional[str] = None) -> Optional[dict]:
        """
        Return the current champion model record, or *None* if none exists.

        Parameters
        ----------
        symbol : str, optional
            Filter by instrument symbol.  When *None* the most recently
            updated champion across all symbols is returned.

        Returns
        -------
        dict or None — model record with all ``*_json`` columns decoded.
        """
        self._ensure_init()

        with self._conn() as conn:
            if symbol is not None:
                row = conn.execute(
                    """
                    SELECT * FROM MODEL_VERSION
                    WHERE  status = 'champion' AND symbol = ?
                    ORDER  BY updated_at DESC
                    LIMIT  1
                    """,
                    (symbol,),
                ).fetchone()
            else:
                row = conn.execute(
                    """
                    SELECT * FROM MODEL_VERSION
                    WHERE  status = 'champion'
                    ORDER  BY updated_at DESC
                    LIMIT  1
                    """
                ).fetchone()

        return _row_to_dict(row) if row else None

    # ------------------------------------------------------------------
    # Querying
    # ------------------------------------------------------------------

    def list_models(
        self,
        symbol: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[dict]:
        """
        Return a list of model records, newest first.

        Parameters
        ----------
        symbol : str, optional — filter by instrument symbol.
        status : str, optional — filter by status string
                 (e.g. ``"registered"``, ``"champion"``, ``"challenger"``).

        Returns
        -------
        List[dict] — each dict is one MODEL_VERSION row with decoded JSON.
        """
        self._ensure_init()

        clauses: List[str] = []
        params: List = []

        if symbol is not None:
            clauses.append("symbol = ?")
            params.append(symbol)
        if status is not None:
            clauses.append("status = ?")
            params.append(status)

        where_clause = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"SELECT * FROM MODEL_VERSION {where_clause} ORDER BY created_at DESC"

        with self._conn() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()

        return [_row_to_dict(r) for r in rows]

    def get_model(self, model_id: str) -> Optional[dict]:
        """
        Fetch a single model record by its id.

        Parameters
        ----------
        model_id : str — the value returned by :meth:`register_model`.

        Returns
        -------
        dict or None.
        """
        self._ensure_init()

        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM MODEL_VERSION WHERE id = ?", (model_id,)
            ).fetchone()

        return _row_to_dict(row) if row else None

    # ------------------------------------------------------------------
    # Training run logging
    # ------------------------------------------------------------------

    def log_train_run(
        self,
        model_id: str,
        config: dict,
        metrics: dict,
        status: str = "completed",
    ) -> str:
        """
        Record a training run associated with *model_id*.

        Parameters
        ----------
        model_id : str  — FK to MODEL_VERSION.id.
        config   : dict — hyperparameters / pipeline configuration used.
        metrics  : dict — train/val/test metrics captured at run end.
        status   : str  — ``"completed"``, ``"failed"``, or ``"running"``.

        Returns
        -------
        str — the new run_id (``"run_" + 12-char UUID hex``).

        Raises
        ------
        ValueError
            If *model_id* does not exist in the registry.
        """
        self._ensure_init()

        if self.get_model(model_id) is None:
            raise ValueError(
                f"Cannot log training run for unknown model_id: {model_id!r}"
            )

        run_id = _new_id("run")
        now = _now_iso()
        completed_at = now if status != "running" else None

        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO TRAIN_RUN
                    (id, model_version_id, status, config_json,
                     metrics_json, started_at, completed_at)
                VALUES (?,?,?,?,?,?,?)
                """,
                (
                    run_id,
                    model_id,
                    status,
                    _json_dumps(config),
                    _json_dumps(metrics),
                    now,
                    completed_at,
                ),
            )

        logger.info(
            "[registry] Logged train run %s for model %s (status=%s)",
            run_id,
            model_id,
            status,
        )
        return run_id

    # ------------------------------------------------------------------
    # Dataset versioning
    # ------------------------------------------------------------------

    def record_dataset_version(
        self,
        symbol: str,
        timeframe: str,
        dataset_hash: str,
        parquet_path: str,
        row_count: int,
        feature_count: int,
    ) -> str:
        """
        Register a dataset snapshot in DATASET_VERSION.

        The ``dataset_hash`` column has a ``UNIQUE`` constraint.  If a
        record with the same hash already exists the existing row's id is
        returned without inserting a duplicate (idempotent).

        Parameters
        ----------
        symbol        : Instrument ticker.
        timeframe     : Bar resolution (e.g. ``"1m"``).
        dataset_hash  : SHA-256 of the dataset Parquet bytes.
        parquet_path  : Path to the saved Parquet file.
        row_count     : Number of sample rows in the dataset.
        feature_count : Number of feature columns (excluding the label col).

        Returns
        -------
        str — id of the inserted or pre-existing DATASET_VERSION row.
        """
        self._ensure_init()

        # Return existing id if this hash was already recorded
        with self._conn() as conn:
            existing = conn.execute(
                "SELECT id FROM DATASET_VERSION WHERE dataset_hash = ?",
                (dataset_hash,),
            ).fetchone()

        if existing is not None:
            logger.debug(
                "[registry] Dataset hash %s already recorded (id=%s).",
                dataset_hash,
                existing["id"],
            )
            return existing["id"]

        dset_id = _new_id("dset")
        now = _now_iso()

        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO DATASET_VERSION
                    (id, symbol, timeframe, dataset_hash, parquet_path,
                     row_count, feature_count, created_at)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                (
                    dset_id,
                    symbol,
                    timeframe,
                    dataset_hash,
                    parquet_path,
                    row_count,
                    feature_count,
                    now,
                ),
            )

        logger.info(
            "[registry] Recorded dataset %s  symbol=%s  rows=%d",
            dset_id,
            symbol,
            row_count,
        )
        return dset_id

    # ------------------------------------------------------------------
    # Model cards
    # ------------------------------------------------------------------

    def write_model_card(self, model_id: str, card_md: str) -> None:
        """
        Write (or overwrite) the Markdown model card for *model_id*.

        The card is stored in the MODEL_CARD table keyed by
        ``model_version_id``.  An existing card is replaced atomically.

        Parameters
        ----------
        model_id : str — UUID of the model.
        card_md  : str — Markdown text of the model card.

        Raises
        ------
        ValueError
            If *model_id* does not exist in the registry.
        """
        self._ensure_init()

        if self.get_model(model_id) is None:
            raise ValueError(
                f"Cannot write model card for unknown model_id: {model_id!r}"
            )

        now = _now_iso()

        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO MODEL_CARD (model_version_id, card_markdown, created_at)
                VALUES (?,?,?)
                ON CONFLICT(model_version_id) DO UPDATE
                    SET card_markdown = excluded.card_markdown,
                        created_at    = excluded.created_at
                """,
                (model_id, card_md, now),
            )

        logger.debug("[registry] Wrote model card for model %s.", model_id)

    def get_model_card(self, model_id: str) -> Optional[str]:
        """
        Retrieve the Markdown model card for *model_id*.

        Parameters
        ----------
        model_id : str — UUID of the model.

        Returns
        -------
        str — Markdown text, or *None* if no card has been written yet.
        """
        self._ensure_init()

        with self._conn() as conn:
            row = conn.execute(
                "SELECT card_markdown FROM MODEL_CARD WHERE model_version_id = ?",
                (model_id,),
            ).fetchone()

        return row["card_markdown"] if row else None


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

registry = ModelRegistry()
"""
Module-level :class:`ModelRegistry` singleton.

Uses the default database path (``ML_REGISTRY_DB`` environment variable,
or ``server/ai/registry/registry.db`` relative to the repo root).

Usage::

    from server.ai.registry.registry import registry

    registry.initialize()
    model_id = registry.register_model(
        model_type="xgb",
        symbol="AAPL",
        artifact_path="/models/xgb_v1.json",
        metrics={"accuracy": 0.62, "f1_macro": 0.58},
        feature_schema_hash="abc123...",
        dataset_hash="def456...",
        git_sha="a1b2c3d",
        feature_names=["ret_1", "ret_5", ...],
        label_definition={"horizon": 5, "tau_up": 0.003, "tau_down": -0.003},
    )
    registry.promote_champion(model_id)
    champion = registry.get_champion(symbol="AAPL")
"""
