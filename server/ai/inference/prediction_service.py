"""
PredictionService — manages a persistent infer_worker.py subprocess and
exposes a synchronous predict() interface suitable for Node.js IPC.

Architecture
------------
  - A background Thread reads the worker's stdout line-by-line and routes
    each JSON response back to the waiting caller via a threading.Event +
    result slot stored in a dict keyed by request_id.
  - predict() enqueues the request via stdin, then blocks (with timeout)
    waiting for its specific response.
  - A watchdog thread monitors the worker process and triggers auto-restart
    on unexpected exit.
  - All public methods are thread-safe.
"""

from __future__ import annotations

import collections
import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


# ── Internal pending-request slot ─────────────────────────────────────────────

@dataclass
class _PendingRequest:
    event:  threading.Event = field(default_factory=threading.Event)
    result: Optional[dict]  = None


# ── Service ────────────────────────────────────────────────────────────────────

class PredictionService:
    """
    Higher-level wrapper around the infer_worker.py subprocess.

    Parameters
    ----------
    worker_script : str, optional
        Absolute or relative path to infer_worker.py.
        Defaults to the sibling infer_worker.py in this package.
    models_dir : str, optional
        Path passed to the worker as ML_MODELS_DIR env var.
    timeout_ms : int
        Maximum milliseconds to wait for a single prediction response.
    """

    def __init__(
        self,
        worker_script: Optional[str] = None,
        models_dir: Optional[str]    = None,
        timeout_ms: int              = 400,
    ) -> None:
        if worker_script is None:
            worker_script = str(Path(__file__).parent / "infer_worker.py")
        self._worker_script = worker_script
        self._models_dir    = models_dir
        self._timeout_s     = timeout_ms / 1000.0

        # State
        self._process:       Optional[subprocess.Popen] = None
        self._reader_thread: Optional[threading.Thread] = None
        self._watchdog_thread: Optional[threading.Thread] = None
        self._ready_event    = threading.Event()
        self._model_version: Optional[str] = None

        # Pending-request registry: request_id → _PendingRequest
        self._pending: dict[str, _PendingRequest] = {}
        self._pending_lock = threading.Lock()

        # Statistics
        self._total_requests = 0
        self._total_errors   = 0
        self._latencies: collections.deque[float] = collections.deque(maxlen=500)
        self._stats_lock = threading.Lock()

        # Lifecycle flags
        self._running    = False
        self._stop_event = threading.Event()

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def start(self) -> None:
        """
        Spawn the worker subprocess and block until it emits {"ready": true}
        on stdout (or raises RuntimeError on timeout / failure).
        """
        if self._running:
            logger.warning("[PredictionService] start() called while already running")
            return

        self._stop_event.clear()
        self._ready_event.clear()
        self._spawn_worker()
        self._running = True

        # Wait for readiness (up to 30 s — model loading can be slow)
        if not self._ready_event.wait(timeout=30.0):
            self.stop()
            raise RuntimeError(
                "infer_worker.py did not emit {ready: true} within 30 seconds"
            )
        logger.info(
            "[PredictionService] Worker ready — model_version=%s",
            self._model_version,
        )

    def stop(self) -> None:
        """Gracefully terminate the worker subprocess and reader threads."""
        self._running = False
        self._stop_event.set()

        if self._process and self._process.poll() is None:
            try:
                self._process.stdin.close()
            except Exception:
                pass
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                logger.warning("[PredictionService] Worker did not exit cleanly — killing")
                self._process.kill()
                self._process.wait()

        # Unblock any pending callers
        with self._pending_lock:
            for slot in self._pending.values():
                slot.result = {
                    "ok":    False,
                    "error": "PredictionService stopped",
                    "code":  "ServiceStopped",
                }
                slot.event.set()
            self._pending.clear()

        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=3)

        logger.info("[PredictionService] Stopped.")

    def restart(self) -> None:
        """Stop then start the worker again."""
        logger.info("[PredictionService] Restarting worker …")
        self.stop()
        self.start()

    # ── Prediction ─────────────────────────────────────────────────────────────

    def predict(self, request: dict) -> dict:
        """
        Send *request* to the worker and return the response dict.

        Required keys in *request*:
            features      : dict[str, float]
            feature_names : list[str]
            inv_label_map : dict[str, str]

        Returns the worker's output dict (always contains "ok" key).
        Raises TimeoutError if no response arrives within timeout_ms.
        """
        if not self._running or self._process is None or self._process.poll() is not None:
            # Attempt transparent restart if the worker died
            logger.warning("[PredictionService] Worker not alive — restarting before predict()")
            self.restart()

        request_id = str(uuid.uuid4())
        payload    = {
            "request_id":    request_id,
            "features":      request.get("features", {}),
            "feature_names": request.get("feature_names", []),
            "inv_label_map": request.get("inv_label_map", {}),
        }

        slot = _PendingRequest()
        with self._pending_lock:
            self._pending[request_id] = slot

        with self._stats_lock:
            self._total_requests += 1

        t0 = time.monotonic()
        try:
            line = json.dumps(payload, separators=(",", ":")) + "\n"
            self._process.stdin.write(line)
            self._process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            with self._stats_lock:
                self._total_errors += 1
            raise RuntimeError(f"Failed to write to worker stdin: {exc}") from exc

        if not slot.event.wait(timeout=self._timeout_s):
            with self._pending_lock:
                self._pending.pop(request_id, None)
            with self._stats_lock:
                self._total_errors += 1
            elapsed_ms = round((time.monotonic() - t0) * 1000, 1)
            raise TimeoutError(
                f"predict() timed out after {elapsed_ms} ms "
                f"(limit={self._timeout_s * 1000:.0f} ms)"
            )

        response = slot.result  # type: ignore[assignment]
        elapsed_ms = round((time.monotonic() - t0) * 1000, 3)

        with self._stats_lock:
            self._latencies.append(elapsed_ms)
            if response and not response.get("ok", True):
                self._total_errors += 1

        return response  # type: ignore[return-value]

    # ── Health ─────────────────────────────────────────────────────────────────

    def health(self) -> dict:
        """
        Return a health snapshot.

        Keys: ok, worker_alive, model_version, total_requests, errors,
              avg_latency_ms, pending_requests.
        """
        worker_alive = (
            self._process is not None and self._process.poll() is None
        )
        with self._stats_lock:
            total     = self._total_requests
            errors    = self._total_errors
            latencies = list(self._latencies)

        avg_latency = round(sum(latencies) / len(latencies), 3) if latencies else 0.0

        return {
            "ok":               self._running and worker_alive,
            "worker_alive":     worker_alive,
            "model_version":    self._model_version,
            "total_requests":   total,
            "errors":           errors,
            "avg_latency_ms":   avg_latency,
            "pending_requests": len(self._pending),
        }

    # ── Internal helpers ───────────────────────────────────────────────────────

    def _spawn_worker(self) -> None:
        """Fork the worker process and start the background reader thread."""
        env = os.environ.copy()
        if self._models_dir:
            env["ML_MODELS_DIR"] = self._models_dir

        self._process = subprocess.Popen(
            [sys.executable, self._worker_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,   # inherit parent stderr so logs appear in the console
            text=True,
            bufsize=1,     # line-buffered
            env=env,
        )
        logger.info(
            "[PredictionService] Spawned worker PID=%d from %s",
            self._process.pid,
            self._worker_script,
        )

        self._reader_thread = threading.Thread(
            target=self._stdout_reader,
            name="infer-worker-reader",
            daemon=True,
        )
        self._reader_thread.start()

        self._watchdog_thread = threading.Thread(
            target=self._watchdog,
            name="infer-worker-watchdog",
            daemon=True,
        )
        self._watchdog_thread.start()

    def _stdout_reader(self) -> None:
        """
        Background thread: read stdout lines from the worker and dispatch
        responses to waiting predict() callers.
        """
        try:
            for raw in self._process.stdout:  # type: ignore[union-attr]
                raw = raw.strip()
                if not raw:
                    continue

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("[PredictionService] Non-JSON from worker: %r", raw[:200])
                    continue

                # Startup readiness signal
                if msg.get("ready") is True:
                    self._model_version = msg.get("model_version", "unknown")
                    self._ready_event.set()
                    continue

                # Fatal startup failure
                if msg.get("ready") is False:
                    logger.error(
                        "[PredictionService] Worker startup failed: %s", msg.get("error")
                    )
                    self._ready_event.set()   # unblock start() so it can raise
                    continue

                # Prediction response — route to the waiting caller
                request_id = msg.get("request_id")
                if request_id:
                    with self._pending_lock:
                        slot = self._pending.pop(request_id, None)
                    if slot:
                        slot.result = msg
                        slot.event.set()
                    else:
                        logger.debug(
                            "[PredictionService] Received response for unknown/expired request_id=%s",
                            request_id,
                        )

        except Exception as exc:
            logger.error("[PredictionService] stdout reader crashed: %s", exc)
        finally:
            # Unblock any remaining pending callers after the pipe closes
            with self._pending_lock:
                for slot in self._pending.values():
                    if slot.result is None:
                        slot.result = {
                            "ok":    False,
                            "error": "Worker stdout closed unexpectedly",
                            "code":  "WorkerDied",
                        }
                    slot.event.set()

    def _watchdog(self) -> None:
        """
        Background thread: watch for unexpected worker death and trigger
        auto-restart when it happens (but only if the service is still meant
        to be running).
        """
        while not self._stop_event.is_set():
            self._stop_event.wait(timeout=2.0)
            if self._stop_event.is_set():
                break
            if self._process and self._process.poll() is not None:
                exit_code = self._process.returncode
                if self._running:
                    logger.error(
                        "[PredictionService] Worker exited unexpectedly "
                        "(exit_code=%d) — scheduling restart",
                        exit_code,
                    )
                    try:
                        self._ready_event.clear()
                        self._spawn_worker()
                        if not self._ready_event.wait(timeout=30.0):
                            logger.error(
                                "[PredictionService] Restarted worker did not "
                                "become ready within 30 s"
                            )
                    except Exception as exc:
                        logger.error(
                            "[PredictionService] Auto-restart failed: %s", exc
                        )
                break
