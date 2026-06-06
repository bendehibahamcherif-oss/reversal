import csv
import importlib.util
import math
import pathlib
import sys
import types
from types import SimpleNamespace

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("minimal_train_pipeline", ROOT / "train_pipeline.py")
train_pipeline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(train_pipeline)


def test_chronological_split_gap_and_no_shuffle():
    split = train_pipeline.chronological_split_indices(100, horizon=20)
    assert split["shuffle"] is False
    assert split["gap"] == 20
    assert split["val"][0] - split["train"][1] >= 20
    assert split["test"][0] - split["val"][1] >= 20


def test_label_constants_have_three_classes():
    assert train_pipeline.LABEL_MAP == {0: "SHORT", 1: "NEUTRAL", 2: "LONG"}


def _require_ml_deps():
    pytest.importorskip("numpy")
    pytest.importorskip("pandas")
    pytest.importorskip("sklearn")
    pytest.importorskip("joblib")


def _write_synthetic_csv(path, rows=360):
    price = 100.0
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["timestamp", "symbol", "open", "high", "low", "close", "volume"])
        for i in range(rows):
            drift = 0.15 * math.sin(i / 5.0)
            open_ = price
            close = open_ + drift
            high = max(open_, close) + 0.10
            low = min(open_, close) - 0.10
            writer.writerow([
                f"2026-01-01T00:{i % 60:02d}:00Z",
                "SPY",
                f"{open_:.6f}",
                f"{high:.6f}",
                f"{low:.6f}",
                f"{close:.6f}",
                1000 + (i % 20),
            ])
            price = close


def _args(dataset, output_dir, model_type):
    return SimpleNamespace(
        dataset=str(dataset),
        symbol="SPY",
        timeframe="1m",
        horizon=5,
        cost_bps=0.0,
        tau_up=0.0001,
        tau_dn=0.0001,
        output_dir=str(output_dir),
        model_type=model_type,
    )


def test_make_logistic_regression_instantiates_without_multi_class(monkeypatch):
    captured_kwargs = {}

    class FakeLogisticRegression:
        def __init__(self, **kwargs):
            captured_kwargs.update(kwargs)

    fake_sklearn = types.ModuleType("sklearn")
    fake_linear_model = types.ModuleType("sklearn.linear_model")
    fake_linear_model.LogisticRegression = FakeLogisticRegression
    monkeypatch.setitem(sys.modules, "sklearn", fake_sklearn)
    monkeypatch.setitem(sys.modules, "sklearn.linear_model", fake_linear_model)

    train_pipeline.make_logistic_regression()

    assert "multi_class" not in captured_kwargs
    assert captured_kwargs == {
        "max_iter": 1000,
        "solver": "lbfgs",
        "class_weight": "balanced",
    }


@pytest.mark.parametrize("model_type", ["LogisticRegression", "XGBoost", "HistGradientBoosting", "LightGBM"])
def test_train_pipeline_model_types_do_not_throw_multi_class_error(tmp_path, model_type):
    _require_ml_deps()
    dataset = tmp_path / "features_snapshot.csv"
    _write_synthetic_csv(dataset)

    result = train_pipeline.train(_args(dataset, tmp_path / "artifacts", model_type))

    assert "multi_class" not in str(result)
    assert result["status"] in {"trained", "not_enough_data", "training_failed"}
    if result["status"] == "training_failed":
        assert not any("multi_class" in error.get("message", "") for error in result.get("errors", []))


def test_baseline_failure_does_not_block_selected_model_training(tmp_path, monkeypatch):
    _require_ml_deps()
    dataset = tmp_path / "features_snapshot.csv"
    _write_synthetic_csv(dataset)

    class BrokenLogisticRegression:
        def fit(self, *_args, **_kwargs):
            raise TypeError("synthetic baseline constructor or fit failure")

    monkeypatch.setattr(train_pipeline, "make_logistic_regression", lambda: BrokenLogisticRegression())

    result = train_pipeline.train(_args(dataset, tmp_path / "artifacts", "HistGradientBoosting"))

    assert result["ok"] is True
    assert result["status"] == "trained"
    assert "baseline_failed" in result.get("warnings", [])
    assert "multi_class" not in str(result)


def test_all_models_failed_error_output_includes_model_type_and_stage(tmp_path, monkeypatch):
    _require_ml_deps()
    dataset = tmp_path / "features_snapshot.csv"
    _write_synthetic_csv(dataset)

    class BrokenLogisticRegression:
        def fit(self, *_args, **_kwargs):
            raise TypeError("synthetic logistic failure")

    monkeypatch.setattr(train_pipeline, "make_logistic_regression", lambda: BrokenLogisticRegression())

    result = train_pipeline.train(_args(dataset, tmp_path / "artifacts", "LogisticRegression"))

    assert result["ok"] is False
    assert result["status"] == "training_failed"
    assert result["stage"] == "model_fit"
    assert result["errors"][0]["modelType"] == "logistic_regression"
    assert result["errors"][0]["errorType"] == "TypeError"
