"""
metrics_monitor.py — Latency, error-rate, and prediction-distribution monitor
with Prometheus text-exposition output.

Designed for use as a module-level singleton (``metrics_monitor``) that
Node.js's inference bridge can import or drive via a thin Python shim.

Thread-safe: all public methods acquire a reentrant lock before touching the
ring buffer so the object can be shared across threads in the prediction
service without external synchronisation.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# ── Data record ───────────────────────────────────────────────────────────────


@dataclass
class InferenceRecord:
    """A single inference event captured for monitoring purposes."""

    request_id: str
    symbol: str
    signal: str          # e.g. "LONG", "NEUTRAL", "SHORT"
    latency_ms: float
    error: bool
    timestamp: float = field(default_factory=time.time)


# ── Monitor class ─────────────────────────────────────────────────────────────


class MetricsMonitor:
    """
    Sliding-window monitor for inference latency, error rate, and signal
    distribution.

    Parameters
    ----------
    window : int
        Maximum number of recent ``InferenceRecord`` objects to retain.
        Older entries are evicted automatically (ring buffer via deque).
    """

    # Canonical signal labels expected in a 3-class setup.  Records with other
    # labels are still tracked under their actual label name.
    _CANONICAL_SIGNALS = ("LONG", "NEUTRAL", "SHORT")

    def __init__(self, window: int = 1000) -> None:
        self._window  = max(1, window)
        self._buffer: deque[InferenceRecord] = deque(maxlen=self._window)
        self._lock    = threading.RLock()

        # Monotonically increasing counters (never reset, survive window eviction)
        self._total_records = 0
        self._total_errors  = 0

    # ── Recording ──────────────────────────────────────────────────────────────

    def record(self, record: InferenceRecord) -> None:
        """
        Append an ``InferenceRecord`` to the ring buffer.

        Also increments the all-time counters (they do not wrap with the window).
        """
        with self._lock:
            self._buffer.append(record)
            self._total_records += 1
            if record.error:
                self._total_errors += 1

    # ── Latency percentiles ────────────────────────────────────────────────────

    def latency_percentiles(self) -> dict:
        """
        Return latency statistics over the current window.

        Returns
        -------
        dict with keys ``p50``, ``p95``, ``p99``, ``mean`` (all float, in ms).
        Returns zeros when the buffer is empty.
        """
        with self._lock:
            latencies = [r.latency_ms for r in self._buffer if not r.error]

        if not latencies:
            return {"p50": 0.0, "p95": 0.0, "p99": 0.0, "mean": 0.0}

        sorted_lat = sorted(latencies)
        n          = len(sorted_lat)

        def _percentile(p: float) -> float:
            # Nearest-rank method
            idx = max(0, math.ceil(p / 100.0 * n) - 1)
            return round(sorted_lat[idx], 3)

        mean_lat = round(sum(sorted_lat) / n, 3)

        return {
            "p50":  _percentile(50),
            "p95":  _percentile(95),
            "p99":  _percentile(99),
            "mean": mean_lat,
        }

    # ── Error rate ─────────────────────────────────────────────────────────────

    def error_rate(self) -> float:
        """
        Fraction of requests in the current window that resulted in an error.

        Returns 0.0 if the window is empty.
        """
        with self._lock:
            buf = list(self._buffer)

        if not buf:
            return 0.0

        n_errors = sum(1 for r in buf if r.error)
        return round(n_errors / len(buf), 6)

    # ── Prediction distribution ────────────────────────────────────────────────

    def prediction_distribution(self) -> dict:
        """
        Fraction of each signal label among *successful* predictions in the
        current window.

        Returns
        -------
        dict — at minimum contains keys ``"LONG"``, ``"NEUTRAL"``, ``"SHORT"``
        (always present, even if 0.0).  Additional labels from non-standard
        models are included when encountered.
        """
        with self._lock:
            successful = [r for r in self._buffer if not r.error]

        counts: dict[str, int] = {s: 0 for s in self._CANONICAL_SIGNALS}
        for r in successful:
            counts[r.signal] = counts.get(r.signal, 0) + 1

        total = len(successful)
        if total == 0:
            return {s: 0.0 for s in self._CANONICAL_SIGNALS}

        return {label: round(count / total, 6) for label, count in counts.items()}

    # ── Prometheus exposition ──────────────────────────────────────────────────

    def prometheus_text(self) -> str:
        """
        Return metrics in the Prometheus text exposition format (version 0.0.4).

        Metrics exposed
        ---------------
        ml_inference_latency_ms{quantile="0.5|0.95|0.99"}   gauge
        ml_inference_latency_ms_mean                         gauge
        ml_inference_error_rate                              gauge
        ml_inference_requests_total                          counter
        ml_inference_errors_total                            counter
        ml_prediction_distribution{signal="LONG|..."}       gauge
        ml_inference_window_size                             gauge
        """
        lat  = self.latency_percentiles()
        err  = self.error_rate()
        dist = self.prediction_distribution()

        with self._lock:
            total_req = self._total_records
            total_err = self._total_errors
            window_n  = len(self._buffer)

        lines: list[str] = []

        # ── Latency ────────────────────────────────────────────────────────────
        lines.append("# HELP ml_inference_latency_ms Inference latency in milliseconds")
        lines.append("# TYPE ml_inference_latency_ms gauge")
        lines.append(f'ml_inference_latency_ms{{quantile="0.5"}} {lat["p50"]}')
        lines.append(f'ml_inference_latency_ms{{quantile="0.95"}} {lat["p95"]}')
        lines.append(f'ml_inference_latency_ms{{quantile="0.99"}} {lat["p99"]}')

        lines.append("# HELP ml_inference_latency_ms_mean Mean inference latency in milliseconds")
        lines.append("# TYPE ml_inference_latency_ms_mean gauge")
        lines.append(f'ml_inference_latency_ms_mean {lat["mean"]}')

        # ── Error rate ─────────────────────────────────────────────────────────
        lines.append("# HELP ml_inference_error_rate Fraction of requests that errored (window)")
        lines.append("# TYPE ml_inference_error_rate gauge")
        lines.append(f"ml_inference_error_rate {err}")

        # ── All-time counters ──────────────────────────────────────────────────
        lines.append("# HELP ml_inference_requests_total Total inference requests since startup")
        lines.append("# TYPE ml_inference_requests_total counter")
        lines.append(f"ml_inference_requests_total {total_req}")

        lines.append("# HELP ml_inference_errors_total Total inference errors since startup")
        lines.append("# TYPE ml_inference_errors_total counter")
        lines.append(f"ml_inference_errors_total {total_err}")

        # ── Prediction distribution ────────────────────────────────────────────
        lines.append("# HELP ml_prediction_distribution Fraction of each signal in the window")
        lines.append("# TYPE ml_prediction_distribution gauge")
        for signal, fraction in dist.items():
            lines.append(f'ml_prediction_distribution{{signal="{signal}"}} {fraction}')

        # ── Window size ────────────────────────────────────────────────────────
        lines.append("# HELP ml_inference_window_size Current number of records in the ring buffer")
        lines.append("# TYPE ml_inference_window_size gauge")
        lines.append(f"ml_inference_window_size {window_n}")

        lines.append("")  # trailing newline required by Prometheus spec
        return "\n".join(lines)

    # ── Full snapshot ──────────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        """
        Full snapshot suitable for a ``/api/ml/health`` JSON endpoint.

        Returns
        -------
        dict with keys: ``latency``, ``error_rate``, ``prediction_distribution``,
        ``total_requests``, ``total_errors``, ``window``, ``window_used``.
        """
        with self._lock:
            total_req  = self._total_records
            total_err  = self._total_errors
            window_n   = len(self._buffer)
            window_max = self._window

        return {
            "latency":                 self.latency_percentiles(),
            "error_rate":              self.error_rate(),
            "prediction_distribution": self.prediction_distribution(),
            "total_requests":          total_req,
            "total_errors":            total_err,
            "window":                  window_max,
            "window_used":             window_n,
        }

    # ── Convenience ────────────────────────────────────────────────────────────

    def reset_window(self) -> None:
        """
        Clear the ring buffer without resetting the all-time counters.

        Useful in tests or when switching reference windows.
        """
        with self._lock:
            self._buffer.clear()


# ── Module-level singleton ────────────────────────────────────────────────────

#: Shared singleton used by the inference layer.  Import and call
#: ``metrics_monitor.record(...)`` from any module without instantiating a
#: new object.
metrics_monitor = MetricsMonitor()
