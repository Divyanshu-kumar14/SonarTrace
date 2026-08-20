"""SonarTrace — real-time execution telemetry for audio sonification."""

from .serialization import dumps_frame, frame_from_dict, frame_to_dict, loads_frame
from .tracer import Tracer
from .types import EventType, TelemetryFrame

__all__ = [
    "EventType",
    "TelemetryFrame",
    "Tracer",
    "dumps_frame",
    "frame_from_dict",
    "frame_to_dict",
    "loads_frame",
]

__version__ = "0.1.0"