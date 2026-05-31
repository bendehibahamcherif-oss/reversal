"""
server.ai.monitoring — drift and metrics monitoring package.

Public API
----------
drift_monitor
    PSI-based feature and prediction distribution drift detection.

metrics_monitor
    Latency, error-rate, and signal-distribution monitoring with
    Prometheus text-exposition output.

Quick usage::

    from server.ai.monitoring import DriftMonitor, metrics_monitor, InferenceRecord

    # Record an inference event
    metrics_monitor.record(InferenceRecord(
        request_id="abc-123",
        symbol="BTCUSDT",
        signal="LONG",
        latency_ms=12.4,
        error=False,
    ))

    # Check for drift
    monitor = DriftMonitor(reference_X=X_train, reference_preds=y_train_preds)
    result  = monitor.check(current_X=X_live, current_preds=y_live_preds)
"""

from .drift_monitor import (
    DriftMonitor,
    PSI_THRESHOLDS,
    compute_psi,
    monitor_feature_drift,
    monitor_prediction_drift,
)
from .metrics_monitor import (
    InferenceRecord,
    MetricsMonitor,
    metrics_monitor,
)

__all__ = [
    # drift
    "DriftMonitor",
    "PSI_THRESHOLDS",
    "compute_psi",
    "monitor_feature_drift",
    "monitor_prediction_drift",
    # metrics
    "InferenceRecord",
    "MetricsMonitor",
    "metrics_monitor",
]
