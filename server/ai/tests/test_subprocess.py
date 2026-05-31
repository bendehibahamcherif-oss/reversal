"""
Integration tests for the infer_worker.py persistent subprocess.

A minimal LogisticRegression model is trained and written to a temp directory
so the worker can load it without real training artifacts.

Tests cover:
  - Startup handshake (ready line)
  - Valid inference requests
  - Input validation (missing fields, invalid JSON, non-finite values)
  - Multiple sequential requests (worker reuse)
  - Clean exit on stdin close
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import pytest
from sklearn.linear_model import LogisticRegression

_HERE = Path(__file__).parent
_WORKER_SCRIPT = _HERE.parent / "inference" / "infer_worker.py"

_INV_LABEL_MAP = {"0": "SHORT", "1": "NEUTRAL", "2": "LONG"}
_FEATURE_NAMES = ["f1", "f2", "f3", "f4", "f5"]


# ── Fixtures ───────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def mock_models_dir(tmp_path_factory):
    """
    Minimal models dir: a trivial 3-class logistic regression + metadata.json.
    Created once per module for speed.
    """
    models_dir = tmp_path_factory.mktemp("infer_models")

    rng = np.random.default_rng(42)
    X   = rng.standard_normal((180, 5))
    y   = np.array([0, 1, 2] * 60)
    lr  = LogisticRegression(max_iter=300, random_state=42)
    lr.fit(X, y)
    joblib.dump(lr, models_dir / "logistic_baseline.pkl")

    metadata = {
        "best_model":      "logistic",
        "feature_version": "test_v1",
        "feature_names":   _FEATURE_NAMES,
        "inv_label_map":   _INV_LABEL_MAP,
    }
    (models_dir / "model_metadata.json").write_text(
        json.dumps(metadata), encoding="utf-8"
    )
    return str(models_dir)


def _spawn(models_dir: str) -> subprocess.Popen:
    """Launch infer_worker.py with a temp models dir."""
    env = {**os.environ, "ML_MODELS_DIR": models_dir}
    return subprocess.Popen(
        [sys.executable, str(_WORKER_SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
        bufsize=1,  # line-buffered
    )


def _send(proc: subprocess.Popen, payload: dict) -> None:
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()


def _recv(proc: subprocess.Popen) -> dict:
    return json.loads(proc.stdout.readline().strip())


def _ready_payload() -> dict:
    return {
        "request_id":    "r0",
        "features":      {"f1": 0.1, "f2": 0.2, "f3": 0.3, "f4": 0.4, "f5": 0.5},
        "feature_names": _FEATURE_NAMES,
        "inv_label_map": _INV_LABEL_MAP,
    }


# ── TestWorkerStartup ──────────────────────────────────────────────────────────


class TestWorkerStartup:
    def test_emits_ready_true(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            msg = _recv(proc)
            assert msg.get("ready") is True
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_ready_contains_model_version(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            msg = _recv(proc)
            assert "model_version" in msg
            assert isinstance(msg["model_version"], str)
            assert len(msg["model_version"]) > 0
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_ready_contains_loaded_at(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            msg = _recv(proc)
            assert "loaded_at" in msg
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_missing_models_dir_emits_ready_false(self, tmp_path):
        """If models dir doesn't exist, worker should emit ready:false and exit."""
        proc = _spawn(str(tmp_path / "nonexistent"))
        try:
            msg = _recv(proc)
            assert msg.get("ready") is False
            assert "error" in msg
        finally:
            proc.stdin.close()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


# ── TestWorkerInference ────────────────────────────────────────────────────────


class TestWorkerInference:
    def test_valid_request_returns_ok_true(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)  # consume ready
            _send(proc, _ready_payload())
            resp = _recv(proc)
            assert resp["ok"] is True
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_request_id_echoed_back(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            payload = {**_ready_payload(), "request_id": "unique-abc-123"}
            _send(proc, payload)
            resp = _recv(proc)
            assert resp["request_id"] == "unique-abc-123"
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_response_has_required_fields(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            _send(proc, _ready_payload())
            resp = _recv(proc)
            for field in ("ok", "signal", "probability", "confidence",
                          "probabilities", "latency_ms"):
                assert field in resp, f"Missing field: {field!r}"
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_signal_is_valid_class(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            _send(proc, _ready_payload())
            resp = _recv(proc)
            assert resp["signal"] in ("SHORT", "NEUTRAL", "LONG")
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_probability_in_range(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            _send(proc, _ready_payload())
            resp = _recv(proc)
            assert 0.0 <= resp["probability"] <= 1.0
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_probabilities_sum_to_one(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            _send(proc, _ready_payload())
            resp = _recv(proc)
            total = sum(resp["probabilities"].values())
            assert abs(total - 1.0) < 1e-4, f"Proba sum={total}"
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_missing_features_default_to_zero(self, mock_models_dir):
        """Worker fills missing features with 0.0 — should not crash."""
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            payload = {
                "request_id":    "sparse",
                "features":      {},          # all features missing
                "feature_names": _FEATURE_NAMES,
                "inv_label_map": _INV_LABEL_MAP,
            }
            _send(proc, payload)
            resp = _recv(proc)
            assert resp["ok"] is True
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_multiple_sequential_requests(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            for i in range(5):
                payload = {
                    **_ready_payload(),
                    "request_id":    f"seq-{i}",
                    "features":      {"f1": float(i * 0.1)},
                }
                _send(proc, payload)
                resp = _recv(proc)
                assert resp["ok"] is True
                assert resp["request_id"] == f"seq-{i}"
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_latency_ms_is_positive_number(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            _send(proc, _ready_payload())
            resp = _recv(proc)
            assert isinstance(resp["latency_ms"], (int, float))
            assert resp["latency_ms"] >= 0
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)


# ── TestWorkerValidation ───────────────────────────────────────────────────────


class TestWorkerValidation:
    def test_missing_request_id_returns_ok_false(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            payload = {
                "features":      {"f1": 0.5},
                "feature_names": _FEATURE_NAMES,
                "inv_label_map": _INV_LABEL_MAP,
            }
            _send(proc, payload)
            resp = _recv(proc)
            assert resp["ok"] is False
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_missing_feature_names_returns_ok_false(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            payload = {
                "request_id":    "bad",
                "features":      {"f1": 0.5},
                "inv_label_map": _INV_LABEL_MAP,
            }
            _send(proc, payload)
            resp = _recv(proc)
            assert resp["ok"] is False
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_invalid_json_returns_ok_false(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            proc.stdin.write("this is not valid json\n")
            proc.stdin.flush()
            resp = _recv(proc)
            assert resp["ok"] is False
            assert "error" in resp
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_blank_lines_ignored(self, mock_models_dir):
        """Blank lines must be silently skipped, not cause an error."""
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            proc.stdin.write("\n\n\n")
            proc.stdin.flush()
            # Now send a valid request — worker must still respond
            _send(proc, _ready_payload())
            resp = _recv(proc)
            assert resp["ok"] is True
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_empty_request_id_returns_ok_false(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            payload = {
                "request_id":    "",
                "features":      {"f1": 0.5},
                "feature_names": _FEATURE_NAMES,
                "inv_label_map": _INV_LABEL_MAP,
            }
            _send(proc, payload)
            resp = _recv(proc)
            assert resp["ok"] is False
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_invalid_feature_name_returns_ok_false(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            payload = {
                "request_id":    "inv-name",
                "features":      {"invalid feature!": 0.5},
                "feature_names": ["invalid feature!"],
                "inv_label_map": _INV_LABEL_MAP,
            }
            _send(proc, payload)
            resp = _recv(proc)
            assert resp["ok"] is False
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)


# ── TestWorkerLifecycle ────────────────────────────────────────────────────────


class TestWorkerLifecycle:
    def test_exits_cleanly_on_stdin_close(self, mock_models_dir):
        proc = _spawn(mock_models_dir)
        _recv(proc)  # ready
        proc.stdin.close()
        try:
            proc.wait(timeout=8)
            assert proc.returncode == 0, f"Non-zero exit: {proc.returncode}"
        except subprocess.TimeoutExpired:
            proc.kill()
            pytest.fail("Worker did not exit cleanly after stdin close")

    def test_worker_survives_after_validation_error(self, mock_models_dir):
        """Worker must continue serving after a bad request."""
        proc = _spawn(mock_models_dir)
        try:
            _recv(proc)
            # Send bad request
            proc.stdin.write("not json\n")
            proc.stdin.flush()
            bad_resp = _recv(proc)
            assert bad_resp["ok"] is False

            # Worker should still serve a good request
            _send(proc, _ready_payload())
            good_resp = _recv(proc)
            assert good_resp["ok"] is True
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)

    def test_model_version_format(self, mock_models_dir):
        """model_version in ready message should be a non-empty string."""
        proc = _spawn(mock_models_dir)
        try:
            msg = _recv(proc)
            version = msg.get("model_version", "")
            assert "@" in version, f"Expected 'model@version' format, got: {version!r}"
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)
