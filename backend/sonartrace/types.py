"""Shared telemetry types for SonarTrace.

The schema mirrors PRD §5.1 (``TelemetryFrame`` / ``EventType``) exactly so the
JSON payloads emitted by the tracer are wire-compatible with the WebSocket
protocol implemented in Phase 2 and consumed by the frontend synthesizer.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass


class EventType(str, enum.Enum):
    """Execution lifecycle events (PRD §5.1)."""

    CALL = "CALL"
    RETURN = "RETURN"
    AWAIT = "AWAIT"
    RESUME = "RESUME"
    LOOP_BURST = "LOOP_BURST"
    STALL = "STALL"
    EXCEPTION = "EXCEPTION"


@dataclass(slots=True)
class TelemetryFrame:
    """One atomic execution telemetry record (PRD §5.1).

    ``depth`` is the *observed* call depth for the task at the time of the
    event; it is not clamped to the 1..32 sonification range — clamping is the
    frontend's responsibility so no information is lost upstream.
    """

    id: int
    timestamp_ms: int
    type: EventType
    fn_name: str
    module: str
    depth: int
    task_id: str
    loop_iterations: int | None = None
    stall_duration_ms: int | None = None
    error_type: str | None = None