"""
Tests for the infer.py subprocess bridge — payload validation and output schema.
These tests call main() directly (no subprocess spawn) using monkeypatching.
"""

import base64
import json
import sys
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "server" / "ai" / "inference"))

from infer import _validate_payload, main


# ── _validate_payload unit tests ──────────────────────────────────────────────

class TestValidatePayload:
    def _valid(self):
        return {
            "model_b64":     "dGVzdA==",
            "features":      {"rsi_14": 0.5, "volume_ratio": 1.2},
            "feature_names": ["rsi_14", "volume_ratio"],
            "inv_label_map": {"0": "DOWN", "1": "NEUTRAL", "2": "UP"},
        }

    def test_valid_payload_passes(self):
        _validate_payload(self._valid())   # must not raise

    def test_missing_model_b64_raises(self):
        p = self._valid()
        del p["model_b64"]
        with pytest.raises(ValueError, match="model_b64"):
            _validate_payload(p)

    def test_missing_features_raises(self):
        p = self._valid()
        del p["features"]
        with pytest.raises(ValueError, match="features"):
            _validate_payload(p)

    def test_missing_feature_names_raises(self):
        p = self._valid()
        del p["feature_names"]
        with pytest.raises(ValueError, match="feature_names"):
            _validate_payload(p)

    def test_missing_inv_label_map_raises(self):
        p = self._valid()
        del p["inv_label_map"]
        with pytest.raises(ValueError, match="inv_label_map"):
            _validate_payload(p)

    def test_non_dict_payload_raises(self):
        with pytest.raises(ValueError, match="JSON object"):
            _validate_payload("not a dict")

    def test_features_as_list_raises(self):
        p = self._valid()
        p["features"] = [0.5, 1.2]
        with pytest.raises(ValueError, match="features"):
            _validate_payload(p)

    def test_non_finite_feature_value_raises(self):
        p = self._valid()
        p["features"]["rsi_14"] = float("inf")
        with pytest.raises(ValueError, match="finite"):
            _validate_payload(p)

    def test_nan_feature_value_raises(self):
        p = self._valid()
        p["features"]["rsi_14"] = float("nan")
        with pytest.raises(ValueError, match="finite"):
            _validate_payload(p)

    def test_invalid_feature_name_raises(self):
        p = self._valid()
        p["features"]["bad name!"] = 1.0
        with pytest.raises(ValueError, match="Invalid feature name"):
            _validate_payload(p)

    def test_too_many_features_raises(self):
        p = self._valid()
        p["features"] = {f"f{i}": float(i) for i in range(600)}
        with pytest.raises(ValueError, match="Too many features"):
            _validate_payload(p)


# ── main() integration — uses a tiny real sklearn model ───────────────────────

def _build_lr_b64(feature_names):
    """Train a tiny LogisticRegression and return its joblib bytes as base64."""
    import io
    import joblib
    from sklearn.linear_model import LogisticRegression

    n = 60
    rng = np.random.default_rng(7)
    X   = rng.normal(size=(n, len(feature_names)))
    y   = np.tile(["DOWN", "NEUTRAL", "UP"], n // 3 + 1)[:n]

    lr  = LogisticRegression(max_iter=200, random_state=0)
    lr.fit(X, y)

    buf = io.BytesIO()
    joblib.dump(lr, buf)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _run_main_with(payload_dict: dict):
    """Inject payload via monkeypatched stdin, capture stdout."""
    stdin_text  = json.dumps(payload_dict) + "\n"
    stdout_buf  = StringIO()

    with patch("sys.stdin",  StringIO(stdin_text)), \
         patch("sys.stdout", stdout_buf):
        rc = main()

    output = stdout_buf.getvalue().strip()
    return rc, json.loads(output) if output else {}


class TestMainIntegration:
    _FEATURES = ["rsi_14", "volume_ratio", "momentum_1"]

    def _payload(self):
        return {
            "model_b64":     _build_lr_b64(self._FEATURES),
            "features":      {"rsi_14": 0.55, "volume_ratio": 1.1, "momentum_1": 0.002},
            "feature_names": self._FEATURES,
            "inv_label_map": {"0": "DOWN", "1": "NEUTRAL", "2": "UP"},
        }

    def test_successful_inference_returns_ok_true(self):
        rc, out = _run_main_with(self._payload())
        assert rc == 0
        assert out.get("ok") is True

    def test_prediction_is_valid_class(self):
        _, out = _run_main_with(self._payload())
        assert out["prediction"] in ("DOWN", "NEUTRAL", "UP")

    def test_confidence_in_0_1(self):
        _, out = _run_main_with(self._payload())
        assert 0.0 <= out["confidence"] <= 1.0

    def test_probabilities_sum_to_1(self):
        _, out = _run_main_with(self._payload())
        total = sum(out["probabilities"].values())
        assert abs(total - 1.0) < 1e-4

    def test_probabilities_keys_match_inv_label_map(self):
        _, out = _run_main_with(self._payload())
        assert set(out["probabilities"].keys()) == {"DOWN", "NEUTRAL", "UP"}

    def test_latency_ms_present_and_positive(self):
        _, out = _run_main_with(self._payload())
        assert "latencyMs" in out
        assert out["latencyMs"] >= 0

    def test_empty_stdin_returns_error(self):
        stdout_buf = StringIO()
        with patch("sys.stdin",  StringIO("\n")), \
             patch("sys.stdout", stdout_buf):
            rc = main()
        out = json.loads(stdout_buf.getvalue())
        assert rc == 1
        assert out.get("ok") is False

    def test_invalid_payload_returns_error_json(self):
        bad = {"model_b64": "x", "features": {}, "feature_names": [], "inv_label_map": {}}
        rc, out = _run_main_with(bad)
        assert rc == 1
        assert out.get("ok") is False
        assert "error" in out

    def test_missing_feature_defaults_to_zero(self):
        """A feature present in feature_names but absent in features → 0.0, no crash."""
        p = self._payload()
        del p["features"]["rsi_14"]  # intentionally omit
        rc, out = _run_main_with(p)
        assert rc == 0
        assert out.get("ok") is True
