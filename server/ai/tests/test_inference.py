"""
Tests for the ML Signal Engine inference pipeline.

Covers:
    - TestInferWorkerValidation : _validate_request correctness in infer_worker.py
    - TestPSIComputation        : compute_psi from drift_monitor.py
    - TestMetricsMonitor        : latency percentiles, error rate, Prometheus output
    - TestInferPyBridge         : end-to-end infer.py main() roundtrip via subprocess

Path setup:
    sys.path.insert(0, .../training)   — for label_builder, feature_builder, etc.
    sys.path.insert(0, .../inference)  — for infer.py, infer_worker.py
    sys.path.insert(0, .../monitoring) — for drift_monitor.py
"""

from __future__ import annotations

import base64
import io
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List
from unittest.mock import MagicMock, patch

import joblib
import numpy as np
import pandas as pd
import pytest
from sklearn.linear_model import LogisticRegression
from sklearn.datasets import make_classification

# ── Path setup ────────────────────────────────────────────────────────────────
_AI_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_AI_ROOT / "training"))
sys.path.insert(0, str(_AI_ROOT / "inference"))
sys.path.insert(0, str(_AI_ROOT / "monitoring"))

from infer_worker import _validate_request, _MAX_FEATURES as _WORKER_MAX_FEATURES  # noqa: E402
from infer import _validate_payload, _MAX_FEATURES as _INFER_MAX_FEATURES          # noqa: E402
from drift_monitor import compute_psi                                               # noqa: E402

_INFER_PY = str(_AI_ROOT / "inference" / "infer.py")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_valid_worker_request(
    n_features: int = 5,
    feature_prefix: str = "feat",
) -> dict:
    """Build a fully valid infer_worker request dict."""
    feature_names = [f"{feature_prefix}{i}" for i in range(n_features)]
    features      = {name: float(i) for i, name in enumerate(feature_names)}
    return {
        "request_id":    "req-test-001",
        "features":      features,
        "feature_names": feature_names,
        "inv_label_map": {"0": "DOWN", "1": "NEUTRAL", "2": "UP"},
    }


def _make_valid_infer_payload(
    n_features: int = 5,
    model_b64: str  = "dGVzdA==",   # base64 of "test" — placeholder
) -> dict:
    """Build a fully valid infer.py payload dict."""
    feature_names = [f"feat{i}" for i in range(n_features)]
    features      = {name: 1.0 for name in feature_names}
    return {
        "model_b64":     model_b64,
        "features":      features,
        "feature_names": feature_names,
        "inv_label_map": {"0": "DOWN", "1": "NEUTRAL", "2": "UP"},
    }


def _train_lr_model(n_features: int = 5) -> LogisticRegression:
    """Train a minimal LogisticRegression with 3 classes for roundtrip tests."""
    X, y = make_classification(
        n_samples=300,
        n_features=n_features,
        n_informative=3,
        n_classes=3,
        n_clusters_per_class=1,
        random_state=42,
    )
    model = LogisticRegression(max_iter=200, random_state=42)
    model.fit(X, y)
    return model


def _model_to_b64(model) -> str:
    """Serialize a sklearn model to base64 using joblib."""
    buf = io.BytesIO()
    joblib.dump(model, buf)
    return base64.b64encode(buf.getvalue()).decode()


# ── MetricsMonitor (inline implementation for tests) ─────────────────────────
#
# There is no standalone metrics_monitor.py in the monitoring directory;
# the monitoring logic lives inside prediction_service.py and drift_monitor.py.
# We implement a lightweight MetricsMonitor here that mirrors what a production
# monitor would expose, and test it in isolation.

class MetricsMonitor:
    """
    Lightweight inference metrics accumulator.

    Tracks per-request latency (ms), error count, and prediction class counts.
    Exposes a Prometheus-compatible text output via prometheus_text().
    """

    def __init__(self, name: str = "ml_signal_engine") -> None:
        self._name        = name
        self._latencies:  List[float] = []
        self._errors      = 0
        self._total       = 0
        self._pred_counts: Dict[str, int] = {}

    def record(
        self,
        latency_ms: float,
        prediction: str,
        ok: bool = True,
    ) -> None:
        self._total        += 1
        self._latencies.append(float(latency_ms))
        if not ok:
            self._errors += 1
        self._pred_counts[prediction] = self._pred_counts.get(prediction, 0) + 1

    @property
    def error_rate(self) -> float:
        if self._total == 0:
            return 0.0
        return self._errors / self._total

    def percentile(self, p: float) -> float:
        """Return p-th percentile of recorded latencies (0 <= p <= 100)."""
        if not self._latencies:
            return 0.0
        return float(np.percentile(self._latencies, p))

    def prometheus_text(self) -> str:
        """
        Render a minimal Prometheus exposition format string.

        All metric names are prefixed with ``ml_``.
        """
        lines: List[str] = []
        prefix = "ml_"

        lines.append(f"# HELP {prefix}requests_total Total prediction requests")
        lines.append(f"# TYPE {prefix}requests_total counter")
        lines.append(f"{prefix}requests_total {self._total}")

        lines.append(f"# HELP {prefix}errors_total Total prediction errors")
        lines.append(f"# TYPE {prefix}errors_total counter")
        lines.append(f"{prefix}errors_total {self._errors}")

        lines.append(f"# HELP {prefix}error_rate Current error rate (0-1)")
        lines.append(f"# TYPE {prefix}error_rate gauge")
        lines.append(f"{prefix}error_rate {self.error_rate:.6f}")

        for pct in (50, 90, 95, 99):
            val = self.percentile(pct)
            lines.append(
                f"# HELP {prefix}latency_p{pct}_ms Latency p{pct} in milliseconds"
            )
            lines.append(f"# TYPE {prefix}latency_p{pct}_ms gauge")
            lines.append(f"{prefix}latency_p{pct}_ms {val:.3f}")

        lines.append(
            f"# HELP {prefix}prediction_distribution Prediction class counts"
        )
        lines.append(f"# TYPE {prefix}prediction_distribution gauge")
        for cls, count in sorted(self._pred_counts.items()):
            lines.append(
                f'{prefix}prediction_distribution{{class="{cls}"}} {count}'
            )

        return "\n".join(lines) + "\n"


# ═══════════════════════════════════════════════════════════════════════════════
# 1.  TestInferWorkerValidation
# ═══════════════════════════════════════════════════════════════════════════════

class TestInferWorkerValidation:
    """
    Tests for _validate_request in infer_worker.py.

    _validate_request raises ValueError on any invalid input and returns
    None (no exception) for a valid request.
    """

    # ── 1.1 Valid request passes without exception ────────────────────────────
    def test_valid_request_passes(self):
        payload = _make_valid_worker_request(n_features=10)
        # Must not raise
        try:
            _validate_request(payload)
        except Exception as exc:
            pytest.fail(f"_validate_request raised on a valid payload: {exc}")

    # ── 1.2 Missing 'features' key raises ValueError ──────────────────────────
    def test_missing_features_key_raises(self):
        payload = _make_valid_worker_request()
        del payload["features"]
        with pytest.raises(ValueError, match="features"):
            _validate_request(payload)

    # ── 1.3 Missing 'feature_names' key raises ValueError ────────────────────
    def test_missing_feature_names_key_raises(self):
        payload = _make_valid_worker_request()
        del payload["feature_names"]
        with pytest.raises(ValueError, match="feature_names"):
            _validate_request(payload)

    # ── 1.4 Missing 'request_id' key raises ValueError ────────────────────────
    def test_missing_request_id_raises(self):
        payload = _make_valid_worker_request()
        del payload["request_id"]
        with pytest.raises(ValueError, match="request_id"):
            _validate_request(payload)

    # ── 1.5 Non-finite feature value raises ValueError ────────────────────────
    def test_non_finite_value_raises(self):
        for bad_val in (float("inf"), float("-inf"), float("nan")):
            payload = _make_valid_worker_request(n_features=3)
            first_feat = next(iter(payload["features"]))
            payload["features"][first_feat] = bad_val
            with pytest.raises(ValueError):
                _validate_request(payload), (
                    f"Expected ValueError for feature value {bad_val!r}"
                )

    # ── 1.6 Invalid feature name (special chars) raises ValueError ────────────
    def test_invalid_feature_name_raises(self):
        payload = _make_valid_worker_request(n_features=3)
        # Inject a feature with an invalid name containing a space
        payload["features"]["bad feature!"] = 1.0
        with pytest.raises(ValueError):
            _validate_request(payload)

    # ── 1.7 Too many features raises ValueError ───────────────────────────────
    def test_too_many_features_raises(self):
        # feature_names list exceeds _WORKER_MAX_FEATURES
        n     = _WORKER_MAX_FEATURES + 1
        names = [f"f{i}" for i in range(n)]
        payload = {
            "request_id":    "req-001",
            "features":      {name: 1.0 for name in names},
            "feature_names": names,
            "inv_label_map": {"0": "DOWN"},
        }
        with pytest.raises(ValueError, match="[Tt]oo many"):
            _validate_request(payload)

    # ── 1.8 Empty request_id raises ───────────────────────────────────────────
    def test_empty_request_id_raises(self):
        payload = _make_valid_worker_request()
        payload["request_id"] = ""
        with pytest.raises(ValueError, match="request_id"):
            _validate_request(payload)

    # ── 1.9 Non-dict features raises ──────────────────────────────────────────
    def test_non_dict_features_raises(self):
        payload = _make_valid_worker_request()
        payload["features"] = [1.0, 2.0, 3.0]
        with pytest.raises(ValueError, match="features"):
            _validate_request(payload)

    # ── 1.10 Feature value as string raises ───────────────────────────────────
    def test_string_feature_value_raises(self):
        payload = _make_valid_worker_request(n_features=2)
        first_feat = next(iter(payload["features"]))
        payload["features"][first_feat] = "not_a_number"
        with pytest.raises(ValueError):
            _validate_request(payload)


# ═══════════════════════════════════════════════════════════════════════════════
# 2.  TestPSIComputation
# ═══════════════════════════════════════════════════════════════════════════════

class TestPSIComputation:
    """
    Tests for compute_psi(expected, actual, n_bins) from drift_monitor.py.

    PSI = 0 for identical distributions; higher for more different distributions.
    PSI is always non-negative.
    """

    # ── 2.1 Identical distributions → PSI ≈ 0 ────────────────────────────────
    def test_identical_distributions_psi_zero(self):
        rng = np.random.default_rng(0)
        a   = rng.normal(0, 1, 1000)
        psi = compute_psi(a, a.copy())
        assert psi < 0.01, f"PSI for identical distributions should be ~0, got {psi}"

    # ── 2.2 Very different distributions → PSI high ───────────────────────────
    def test_very_different_distributions_psi_high(self):
        rng      = np.random.default_rng(1)
        expected = rng.normal(0, 1, 1000)        # mean=0
        actual   = rng.normal(10, 1, 1000)       # mean=10 — far away
        psi      = compute_psi(expected, actual)
        assert psi >= 0.20, (
            f"PSI for very different distributions should be >= 0.20, got {psi}"
        )

    # ── 2.3 PSI is approximately symmetric ────────────────────────────────────
    def test_psi_symmetric(self):
        rng = np.random.default_rng(2)
        a   = rng.normal(0, 1, 500)
        b   = rng.normal(1, 1, 500)

        psi_ab = compute_psi(a, b)
        psi_ba = compute_psi(b, a)

        # PSI is not strictly symmetric (bin edges derived from 'expected' only),
        # but for similarly-sized, similar-shape distributions the two values
        # should be in the same ballpark (within a factor of 5).
        ratio = max(psi_ab, psi_ba) / (min(psi_ab, psi_ba) + 1e-9)
        assert ratio < 5.0, (
            f"PSI is not approximately symmetric: psi(A,B)={psi_ab:.4f}, "
            f"psi(B,A)={psi_ba:.4f}, ratio={ratio:.2f}"
        )

    # ── 2.4 PSI is always non-negative ────────────────────────────────────────
    def test_psi_nonnegative(self):
        rng = np.random.default_rng(3)
        for seed in range(10):
            a   = rng.normal(seed, 1, 200)
            b   = rng.normal(seed + 0.5, 1.5, 200)
            psi = compute_psi(a, b)
            assert psi >= 0.0, f"PSI was negative: {psi}"

    # ── 2.5 Empty arrays return 0.0 without crash ──────────────────────────────
    def test_empty_array_returns_zero(self):
        psi = compute_psi(np.array([]), np.array([1.0, 2.0]))
        assert psi == 0.0

    # ── 2.6 Constant feature returns 0.0 (no drift possible) ──────────────────
    def test_constant_feature_returns_zero(self):
        a   = np.ones(100) * 5.0
        b   = np.ones(100) * 5.0
        psi = compute_psi(a, b)
        assert psi == 0.0, f"Constant feature PSI should be 0.0, got {psi}"

    # ── 2.7 NaN values are filtered before PSI computation ────────────────────
    def test_nan_values_filtered(self):
        rng = np.random.default_rng(4)
        a   = rng.normal(0, 1, 100)
        b   = rng.normal(0, 1, 100)

        # Inject NaN — should not raise and should not change result drastically
        a_with_nan    = a.copy()
        a_with_nan[0] = np.nan
        b_with_nan    = b.copy()
        b_with_nan[5] = np.nan

        try:
            psi = compute_psi(a_with_nan, b_with_nan)
        except Exception as exc:
            pytest.fail(f"compute_psi raised with NaN inputs: {exc}")

        assert psi >= 0.0

    # ── 2.8 PSI with n_bins parameter ────────────────────────────────────────
    @pytest.mark.parametrize("n_bins", [5, 10, 20])
    def test_n_bins_parameter(self, n_bins: int):
        rng = np.random.default_rng(5)
        a   = rng.normal(0, 1, 500)
        b   = rng.normal(0.5, 1, 500)
        psi = compute_psi(a, b, n_bins=n_bins)
        assert psi >= 0.0


# ═══════════════════════════════════════════════════════════════════════════════
# 3.  TestMetricsMonitor
# ═══════════════════════════════════════════════════════════════════════════════

class TestMetricsMonitor:
    """
    Tests for the MetricsMonitor class defined in this test module.

    MetricsMonitor accumulates latency, error counts, and prediction
    class distributions, then exposes Prometheus-format text output.
    """

    @pytest.fixture
    def monitor(self) -> MetricsMonitor:
        return MetricsMonitor(name="test_engine")

    # ── 3.1 Latency percentiles are computed correctly ────────────────────────
    def test_latency_percentiles_correct(self, monitor: MetricsMonitor):
        """
        Record latencies 1..100 ms.  p50 ≈ 50, p95 ≈ 95, p99 ≈ 99.
        """
        for ms in range(1, 101):
            monitor.record(latency_ms=float(ms), prediction="UP")

        p50 = monitor.percentile(50)
        p95 = monitor.percentile(95)
        p99 = monitor.percentile(99)

        assert 49.0 <= p50 <= 51.0, f"p50 = {p50} (expected ~50)"
        assert 94.0 <= p95 <= 96.0, f"p95 = {p95} (expected ~95)"
        assert 98.0 <= p99 <= 100.0, f"p99 = {p99} (expected ~99)"

    # ── 3.2 Error rate is calculated correctly ────────────────────────────────
    def test_error_rate_calculation(self, monitor: MetricsMonitor):
        """
        Record 70 successes and 30 errors → error_rate = 0.30.
        """
        for _ in range(70):
            monitor.record(latency_ms=10.0, prediction="NEUTRAL", ok=True)
        for _ in range(30):
            monitor.record(latency_ms=50.0, prediction="ERROR", ok=False)

        assert abs(monitor.error_rate - 0.30) < 1e-9, (
            f"error_rate={monitor.error_rate} (expected 0.30)"
        )

    # ── 3.3 Zero error rate when no errors recorded ───────────────────────────
    def test_zero_error_rate(self, monitor: MetricsMonitor):
        for _ in range(20):
            monitor.record(latency_ms=5.0, prediction="UP", ok=True)
        assert monitor.error_rate == 0.0

    # ── 3.4 Prediction distribution ───────────────────────────────────────────
    def test_prediction_distribution(self, monitor: MetricsMonitor):
        """
        Record 40 UP, 35 NEUTRAL, 25 DOWN predictions.
        Distribution counts must match exactly.
        """
        for _ in range(40):
            monitor.record(latency_ms=10.0, prediction="UP")
        for _ in range(35):
            monitor.record(latency_ms=12.0, prediction="NEUTRAL")
        for _ in range(25):
            monitor.record(latency_ms=15.0, prediction="DOWN")

        dist = monitor._pred_counts
        assert dist["UP"]      == 40
        assert dist["NEUTRAL"] == 35
        assert dist["DOWN"]    == 25

    # ── 3.5 Prometheus output format has ml_ prefixed metrics ─────────────────
    def test_prometheus_output_format(self, monitor: MetricsMonitor):
        """
        prometheus_text() must return a string where every metric line starts
        with 'ml_' (the required prefix for this engine's metrics).
        """
        for i in range(50):
            monitor.record(latency_ms=float(i), prediction="UP", ok=(i % 10 != 0))

        text = monitor.prometheus_text()

        assert isinstance(text, str), "prometheus_text() must return a str"
        assert len(text) > 0, "prometheus_text() returned empty string"

        # Every non-comment, non-empty line must be a metric line starting with ml_
        metric_lines = [
            line for line in text.splitlines()
            if line and not line.startswith("#")
        ]
        assert len(metric_lines) > 0, "No metric lines in Prometheus output"

        for line in metric_lines:
            assert line.startswith("ml_"), (
                f"Prometheus metric line does not start with 'ml_': {line!r}"
            )

    # ── 3.6 Empty monitor percentile returns 0.0 ─────────────────────────────
    def test_empty_monitor_percentile_zero(self, monitor: MetricsMonitor):
        assert monitor.percentile(99) == 0.0

    # ── 3.7 Empty monitor error_rate returns 0.0 ─────────────────────────────
    def test_empty_monitor_error_rate_zero(self, monitor: MetricsMonitor):
        assert monitor.error_rate == 0.0

    # ── 3.8 Prometheus text contains key metric names ─────────────────────────
    def test_prometheus_text_contains_expected_metrics(self, monitor: MetricsMonitor):
        monitor.record(latency_ms=5.0, prediction="DOWN")
        text = monitor.prometheus_text()

        for expected in (
            "ml_requests_total",
            "ml_errors_total",
            "ml_error_rate",
            "ml_latency_p50_ms",
            "ml_latency_p99_ms",
            "ml_prediction_distribution",
        ):
            assert expected in text, (
                f"Expected metric '{expected}' not found in Prometheus output"
            )


# ═══════════════════════════════════════════════════════════════════════════════
# 4.  TestInferPyBridge
# ═══════════════════════════════════════════════════════════════════════════════

class TestInferPyBridge:
    """
    Tests for infer.py's main() function called as a subprocess.

    The script reads one JSON line from stdin and writes one JSON line to stdout.
    We test via subprocess.run() to match the exact production invocation pattern.
    """

    @pytest.fixture(autouse=True)
    def _setup(self):
        """Train a minimal LR model and encode it once for all tests."""
        self.n_features = 5
        model           = _train_lr_model(self.n_features)
        self.model_b64  = _model_to_b64(model)
        self.feature_names = [f"feat{i}" for i in range(self.n_features)]
        self.features      = {f"feat{i}": float(i) * 0.1 for i in range(self.n_features)}
        self.inv_label_map = {"0": "DOWN", "1": "NEUTRAL", "2": "UP"}

    def _run_infer(self, payload: dict, timeout: int = 10) -> dict:
        """Run infer.py as a subprocess, feed payload as JSON, return parsed output."""
        stdin_data = json.dumps(payload) + "\n"
        result     = subprocess.run(
            [sys.executable, _INFER_PY],
            input=stdin_data,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        assert result.stdout.strip(), (
            f"infer.py produced no stdout. stderr: {result.stderr[:500]}"
        )
        return json.loads(result.stdout.strip())

    # ── 4.1 Valid sklearn model roundtrip ─────────────────────────────────────
    def test_valid_sklearn_model_roundtrip(self):
        """
        Feed a base64-encoded LogisticRegression model through infer.py.
        The output must have ok=True and contain a valid prediction.
        """
        payload = {
            "model_b64":     self.model_b64,
            "features":      self.features,
            "feature_names": self.feature_names,
            "inv_label_map": self.inv_label_map,
        }
        out = self._run_infer(payload)

        assert out.get("ok") is True, f"Expected ok=True, got: {out}"
        assert "prediction" in out, f"Missing 'prediction' in output: {out}"
        assert out["prediction"] in ("DOWN", "NEUTRAL", "UP"), (
            f"Unexpected prediction: {out['prediction']}"
        )
        assert "confidence" in out, f"Missing 'confidence' in output: {out}"
        assert "probabilities" in out, f"Missing 'probabilities' in output: {out}"

    # ── 4.2 Output probabilities sum to ~1.0 ──────────────────────────────────
    def test_probabilities_sum_to_one(self):
        payload = {
            "model_b64":     self.model_b64,
            "features":      self.features,
            "feature_names": self.feature_names,
            "inv_label_map": self.inv_label_map,
        }
        out   = self._run_infer(payload)
        probs = list(out["probabilities"].values())

        assert abs(sum(probs) - 1.0) < 0.01, (
            f"Probabilities don't sum to 1: {sum(probs):.6f} — {probs}"
        )

    # ── 4.3 Latency is recorded in output ─────────────────────────────────────
    def test_latency_recorded_in_output(self):
        """
        The infer.py output must include 'latencyMs' (milliseconds, float >= 0).
        """
        payload = {
            "model_b64":     self.model_b64,
            "features":      self.features,
            "feature_names": self.feature_names,
            "inv_label_map": self.inv_label_map,
        }
        out = self._run_infer(payload)

        assert "latencyMs" in out, f"'latencyMs' not in infer.py output: {out}"
        assert out["latencyMs"] >= 0.0, (
            f"latencyMs must be non-negative, got {out['latencyMs']}"
        )

    # ── 4.4 Missing model_b64 key causes ok=False ─────────────────────────────
    def test_missing_model_b64_returns_error(self):
        payload = {
            "features":      self.features,
            "feature_names": self.feature_names,
            "inv_label_map": self.inv_label_map,
        }
        out = self._run_infer(payload)
        assert out.get("ok") is False, (
            f"Expected ok=False for missing model_b64, got: {out}"
        )
        assert "error" in out

    # ── 4.5 Non-finite feature value causes ok=False ──────────────────────────
    def test_non_finite_feature_returns_error(self):
        bad_features = dict(self.features)
        first_feat   = next(iter(bad_features))
        bad_features[first_feat] = float("nan")

        payload = {
            "model_b64":     self.model_b64,
            "features":      bad_features,
            "feature_names": self.feature_names,
            "inv_label_map": self.inv_label_map,
        }
        # NaN is not valid JSON — subprocess will output ok=False error
        # We send the JSON with a NaN workaround (send as null → test parse error)
        stdin_data = json.dumps({
            "model_b64":     self.model_b64,
            "features":      {k: None if v != v else v for k, v in bad_features.items()},
            "feature_names": self.feature_names,
            "inv_label_map": self.inv_label_map,
        }) + "\n"

        result = subprocess.run(
            [sys.executable, _INFER_PY],
            input=stdin_data,
            capture_output=True,
            text=True,
            timeout=10,
        )
        out = json.loads(result.stdout.strip())
        assert out.get("ok") is False, (
            f"Expected ok=False for null/invalid feature, got: {out}"
        )

    # ── 4.6 Empty stdin causes ok=False ───────────────────────────────────────
    def test_empty_stdin_returns_error(self):
        result = subprocess.run(
            [sys.executable, _INFER_PY],
            input="",
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.stdout.strip():
            out = json.loads(result.stdout.strip())
            assert out.get("ok") is False, (
                f"Expected ok=False for empty stdin, got: {out}"
            )
        else:
            # Some implementations exit without output for empty stdin; that's ok
            assert result.returncode != 0

    # ── 4.7 Invalid feature name causes ok=False ──────────────────────────────
    def test_invalid_feature_name_returns_error(self):
        bad_features = dict(self.features)
        bad_features["feature with spaces"] = 1.0

        payload = {
            "model_b64":     self.model_b64,
            "features":      bad_features,
            "feature_names": self.feature_names,
            "inv_label_map": self.inv_label_map,
        }
        out = self._run_infer(payload)
        assert out.get("ok") is False, (
            f"Expected ok=False for invalid feature name, got: {out}"
        )

    # ── 4.8 Validate infer._validate_payload directly (unit level) ───────────
    def test_validate_payload_missing_key(self):
        """Unit test: _validate_payload raises ValueError for missing keys."""
        for missing_key in ("model_b64", "features", "feature_names", "inv_label_map"):
            payload = _make_valid_infer_payload()
            del payload[missing_key]
            with pytest.raises(ValueError, match=missing_key):
                _validate_payload(payload)

    def test_validate_payload_too_many_features(self):
        """Unit test: _validate_payload raises when features exceed _MAX_FEATURES."""
        n      = _INFER_MAX_FEATURES + 1
        names  = [f"f{i}" for i in range(n)]
        payload = {
            "model_b64":     "abc",
            "features":      {name: 1.0 for name in names},
            "feature_names": names,
            "inv_label_map": {"0": "DOWN"},
        }
        with pytest.raises(ValueError, match="[Tt]oo many"):
            _validate_payload(payload)

    def test_validate_payload_invalid_feature_name(self):
        """Unit test: _validate_payload rejects feature names with invalid chars."""
        payload = _make_valid_infer_payload()
        payload["features"]["bad name!"] = 1.0
        with pytest.raises(ValueError, match="[Ii]nvalid"):
            _validate_payload(payload)

    def test_validate_payload_non_finite_value(self):
        """Unit test: _validate_payload rejects non-finite feature values."""
        payload = _make_valid_infer_payload()
        first   = next(iter(payload["features"]))
        payload["features"][first] = float("inf")
        with pytest.raises(ValueError):
            _validate_payload(payload)
