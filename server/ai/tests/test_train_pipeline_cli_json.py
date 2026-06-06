import csv
import json
import math
import pathlib
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "train_pipeline.py"
REPO_ROOT = ROOT.parents[1]


def _run(args):
    return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=REPO_ROOT, text=True, capture_output=True, timeout=120)


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
                f"2026-01-01T00:{i % 60:02d}:00Z", "SPY", f"{open_:.6f}", f"{high:.6f}", f"{low:.6f}", f"{close:.6f}", 1000 + (i % 20),
            ])
            price = close


def test_cli_missing_dataset_returns_single_json_object():
    proc = _run(["--dataset", "missing.csv", "--symbol", "SPY", "--horizon", "10"])
    payload = json.loads(proc.stdout)

    assert proc.returncode == 1
    assert payload["ok"] is False
    assert payload["status"] == "dataset_missing"
    assert proc.stdout.strip().startswith("{")


def test_cli_argparse_error_returns_json_not_empty_stdout():
    proc = _run(["--symbol", "SPY", "--horizon", "10"])
    payload = json.loads(proc.stdout)

    assert proc.returncode == 2
    assert payload["ok"] is False
    assert payload["status"] == "invalid_request"
    assert payload["stage"] == "argparse"
    assert payload["errorType"] == "JsonArgparseError"


def test_cli_success_or_structured_small_data_returns_valid_json(tmp_path):
    pytest.importorskip("numpy")
    pytest.importorskip("pandas")
    pytest.importorskip("sklearn")
    pytest.importorskip("joblib")
    dataset = tmp_path / "features_snapshot.csv"
    _write_synthetic_csv(dataset)
    proc = _run(["--dataset", str(dataset), "--symbol", "SPY", "--timeframe", "1m", "--horizon", "5", "--output-dir", str(tmp_path / "artifacts"), "--model-type", "HistGradientBoosting"])
    payload = json.loads(proc.stdout)

    assert proc.returncode in {0, 1}
    assert payload["ok"] in {True, False}
    assert payload["status"] in {"trained", "not_enough_data", "training_failed"}
    assert "NaN" not in proc.stdout
    assert "Infinity" not in proc.stdout
