"""WebSocket protocol definitions for SonarTrace.

Defines the message types exchanged over the two WebSocket endpoints:

* ``/ws/ingress`` — Internal: tracer → server (receives TelemetryFrame JSON)
* ``/ws/client``  — Public:  server → browser (broadcasts TelemetryFrame JSON)

Both use the same JSON frame format (PRD §5.1) for simplicity.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

__all__ = ["IngressMessage", "ClientMessage", "MessageType"]


class MessageType(str, Enum):
    """WebSocket message type discriminators."""

    # Ingress (tracer -> server)
    FRAME = "frame"  # TelemetryFrame payload
    HEARTBEAT = "heartbeat"  # Tracer health ping

    # Client (server -> browser)
    FRAME_BATCH = "frame_batch"  # Array of TelemetryFrame payloads
    WELCOME = "welcome"  # Initial connection info
    CONFIG = "config"  # Server configuration update


# Type aliases for clarity; both directions use the same TelemetryFrame JSON
IngressMessage = dict  # {"type": "frame" | "heartbeat", "payload": {...}}
ClientMessage = dict  # {"type": "frame_batch" | "welcome" | "config", "payload": {...}}


def make_ingress_frame(frame_json: str) -> IngressMessage:
    """Wrap a TelemetryFrame JSON string as an ingress message."""
    return {"type": MessageType.FRAME.value, "payload": frame_json}


def make_client_frame_batch(frames_json: list[str]) -> ClientMessage:
    """Wrap a list of TelemetryFrame JSON strings as a client broadcast."""
    return {"type": MessageType.FRAME_BATCH.value, "payload": frames_json}


def make_welcome(client_id: str, config: dict) -> ClientMessage:
    """Create welcome message for a newly connected browser client."""
    return {"type": MessageType.WELCOME.value, "payload": {"client_id": client_id, **config}}


def make_config(config: dict) -> ClientMessage:
    """Create configuration update message."""
    return {"type": MessageType.CONFIG.value, "payload": config}