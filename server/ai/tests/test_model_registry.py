"""
Tests for the SQLite ModelRegistry in server/ai/registry/registry.py.

Suites
------
TestModelRegistryInit    — initialization and table creation
TestRegisterModel        — register_model behaviour
TestPromoteChampion      — promote_champion / get_champion behaviour
TestTrainRun             — log_train_run / list_models behaviour
TestDatasetAndCard       — record_dataset_version / model card behaviour
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------

_AI_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_AI_ROOT / "registry"))
sys.path.insert(0, str(_AI_ROOT / "training"))

from registry import ModelRegistry  # noqa: E402


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _make_model_id(reg: ModelRegistry) -> str:
    """Register a minimal model and return the new model_id."""
    return reg.register_model(
        model_type="xgb",
        symbol="BTC",
        artifact_path="/tmp/m.json",
        feature_names=["f1", "f2"],
        feature_schema_hash="abc",
        dataset_hash="def",
        git_sha="sha1",
        metrics={},
        label_definition={},
    )


# ---------------------------------------------------------------------------
# TestModelRegistryInit
# ---------------------------------------------------------------------------

class TestModelRegistryInit:

    def test_initialize_creates_tables(self, tmp_path):
        db_path = str(tmp_path / "test.db")
        reg = ModelRegistry(db_path=db_path)
        reg.initialize()

        conn = sqlite3.connect(db_path)
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        conn.close()

        expected = {"MODEL_VERSION", "TRAIN_RUN", "FEATURE_SCHEMA", "DATASET_VERSION", "MODEL_CARD"}
        assert expected.issubset(tables), f"Missing tables: {expected - tables}"

    def test_initialize_idempotent(self, tmp_path):
        db_path = str(tmp_path / "test.db")
        reg = ModelRegistry(db_path=db_path)
        # Must not raise on second call
        reg.initialize()
        reg.initialize()

    def test_custom_db_path(self, tmp_path):
        custom_path = str(tmp_path / "custom_reg.db")
        reg = ModelRegistry(db_path=custom_path)
        reg.initialize()

        assert Path(custom_path).exists(), "DB file was not created at the custom path"
        assert reg.db_path == custom_path


# ---------------------------------------------------------------------------
# TestRegisterModel
# ---------------------------------------------------------------------------

class TestRegisterModel:

    def test_register_returns_uuid(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        model_id = _make_model_id(reg)
        assert isinstance(model_id, str) and len(model_id) > 0

    def test_register_creates_row(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        model_id = _make_model_id(reg)

        row = reg.get_model(model_id)
        assert row is not None
        assert row["model_type"] == "xgb"
        assert row["symbol"] == "BTC"
        assert row["status"] == "registered"

    def test_register_default_status_registered(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        model_id = _make_model_id(reg)

        row = reg.get_model(model_id)
        assert row["status"] == "registered"

    def test_register_stores_feature_schema(self, tmp_path):
        db_path = str(tmp_path / "test.db")
        reg = ModelRegistry(db_path=db_path)
        reg.register_model(
            model_type="xgb",
            symbol="BTC",
            artifact_path="/tmp/m.json",
            feature_names=["f1", "f2"],
            feature_schema_hash="unique_hash_xyz",
            dataset_hash="def",
            git_sha="sha1",
            metrics={},
            label_definition={},
        )

        conn = sqlite3.connect(db_path)
        rows = conn.execute(
            "SELECT hash FROM FEATURE_SCHEMA WHERE hash = ?", ("unique_hash_xyz",)
        ).fetchall()
        conn.close()

        assert len(rows) == 1

    def test_register_invalid_model_type(self, tmp_path):
        """Any string is accepted as model_type — no validation at registry level."""
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        model_id = reg.register_model(
            model_type="totally_custom_type",
            symbol="BTC",
            artifact_path="/tmp/m.json",
            feature_names=["f1"],
            feature_schema_hash="h1",
            dataset_hash="h2",
            git_sha="sha1",
            metrics={},
            label_definition={},
        )
        row = reg.get_model(model_id)
        assert row["model_type"] == "totally_custom_type"


# ---------------------------------------------------------------------------
# TestPromoteChampion
# ---------------------------------------------------------------------------

class TestPromoteChampion:

    def test_promote_sets_champion_status(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        model_id = _make_model_id(reg)
        reg.promote_champion(model_id)

        row = reg.get_model(model_id)
        assert row["status"] == "champion"

    def test_promote_demotes_previous_champion(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        model_id_1 = _make_model_id(reg)
        model_id_2 = reg.register_model(
            model_type="xgb",
            symbol="BTC",
            artifact_path="/tmp/m2.json",
            feature_names=["f1", "f2"],
            feature_schema_hash="abc2",
            dataset_hash="def2",
            git_sha="sha2",
            metrics={},
            label_definition={},
        )

        reg.promote_champion(model_id_1)
        assert reg.get_model(model_id_1)["status"] == "champion"

        reg.promote_champion(model_id_2)
        assert reg.get_model(model_id_2)["status"] == "champion"
        # First champion must be demoted
        assert reg.get_model(model_id_1)["status"] == "challenger"

    def test_promote_nonexistent_raises(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        reg.initialize()
        with pytest.raises((ValueError, KeyError)):
            reg.promote_champion("nonexistent-uuid")

    def test_get_champion_returns_correct(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        model_id = _make_model_id(reg)
        reg.promote_champion(model_id)

        champion = reg.get_champion()
        assert champion is not None
        assert champion["id"] == model_id

    def test_get_champion_none_when_empty(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        reg.initialize()
        assert reg.get_champion() is None


# ---------------------------------------------------------------------------
# TestTrainRun
# ---------------------------------------------------------------------------

class TestTrainRun:

    def test_log_train_run_returns_uuid(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        model_id = _make_model_id(reg)
        run_id = reg.log_train_run(model_id, config={}, metrics={})
        assert isinstance(run_id, str) and len(run_id) > 0

    def test_log_train_run_creates_row(self, tmp_path):
        db_path = str(tmp_path / "test.db")
        reg = ModelRegistry(db_path=db_path)
        model_id = _make_model_id(reg)
        reg.log_train_run(model_id, config={}, metrics={})

        conn = sqlite3.connect(db_path)
        rows = conn.execute(
            "SELECT id FROM TRAIN_RUN WHERE model_version_id = ?", (model_id,)
        ).fetchall()
        conn.close()

        assert len(rows) == 1

    def test_log_train_run_invalid_model_id_raises(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        reg.initialize()
        with pytest.raises((ValueError, KeyError, Exception)):
            reg.log_train_run("nonexistent-model-id", config={}, metrics={})

    def test_list_models_returns_all(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        _make_model_id(reg)
        _make_model_id(reg)
        _make_model_id(reg)

        models = reg.list_models()
        assert len(models) >= 3


# ---------------------------------------------------------------------------
# TestDatasetAndCard
# ---------------------------------------------------------------------------

class TestDatasetAndCard:

    def test_record_dataset_version(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        dset_id = reg.record_dataset_version(
            symbol="BTC",
            timeframe="1m",
            dataset_hash="abc123",
            parquet_path="",
            row_count=100,
            feature_count=30,
        )
        assert isinstance(dset_id, str) and len(dset_id) > 0

    def test_write_model_card(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        model_id = _make_model_id(reg)
        reg.write_model_card(model_id, "# Test Card")
        assert reg.get_model_card(model_id) == "# Test Card"

    def test_get_model_card_none_if_absent(self, tmp_path):
        reg = ModelRegistry(db_path=str(tmp_path / "test.db"))
        reg.initialize()
        # Must return None, not raise
        result = reg.get_model_card("nonexistent")
        assert result is None
