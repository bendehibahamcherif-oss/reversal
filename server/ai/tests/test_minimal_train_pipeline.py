import importlib.util
import pathlib

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
