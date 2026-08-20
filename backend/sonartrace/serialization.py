"""JSON serialization for :class:`~sonartrace.types.TelemetryFrame`.

The wire format is the PRD §5.1 payload: required fields are always present,
optional fields are omitted when ``None`` (compact, and cheap to parse on the
frontend). Decoding is strict — malformed payloads raise ``ValueError`` rather
than silently producing corrupt frames.
"""

from __future__ import annotations

import json
from typing import Any

from .types import EventType, TelemetryFrame

_REQUIRED_FIELDS = ("id", "timestamp_ms", "type", "fn_name", "module", "depth", "task_id")
# Tuple for faster iteration than list; order doesn't matter.
_OPTIONAL_FIELDS = ("loop_iterations", "stall_duration_ms", "error_type")


def frame_to_dict(frame: TelemetryFrame) -> dict[str, Any]:
    """Convert a frame to a JSON-ready dict, omitting ``None`` optionals.

    Unrolled loop for the 3 optional fields avoids tuple iteration overhead
    on the hot serialization path (called once per emitted frame).
    """
    # Pre-allocate dict with exact size (7 required + up to 3 optional).
    # Using literal syntax avoids repeated __setitem__ calls.
    data: dict[str, Any] = {
        "id": frame.id,
        "timestamp_ms": frame.timestamp_ms,
        "type": frame.type.value,
        "fn_name": frame.fn_name,
        "module": frame.module,
        "depth": frame.depth,
        "task_id": frame.task_id,
    }
    # Unrolled: 3 optional fields, each a direct attribute access + None check.
    li = frame.loop_iterations
    if li is not None:
        data["loop_iterations"] = li
    sd = frame.stall_duration_ms
    if sd is not None:
        data["stall_duration_ms"] = sd
    et = frame.error_type
    if et is not None:
        data["error_type"] = et
    return data


def dumps_frame(frame: TelemetryFrame) -> str:
    """Serialize a frame to compact JSON (no whitespace, ``None`` omitted)."""
    return json.dumps(frame_to_dict(frame), separators=(",", ":"), sort_keys=False)


def frame_from_dict(data: dict[str, Any]) -> TelemetryFrame:
    """Build a frame from a decoded JSON object, validating every field."""
    if not isinstance(data, dict):
        raise ValueError(f"expected a JSON object, got {type(data).__name__}")
    # Fast path: single set operation for all required fields.
    missing = [name for name in _REQUIRED_FIELDS if name not in data]
    if missing:
        raise ValueError(f"missing required field(s): {', '.join(missing)}")

    type_raw = data["type"]
    if not isinstance(type_raw, str):
        raise ValueError(f"'type' must be a string, got {type(type_raw).__name__}")
    try:
        etype = EventType(type_raw)
    except ValueError as exc:
        raise ValueError(f"unknown event type: {type_raw!r}") from exc

    # Inline validation: avoids function call overhead for 7 required + 3 optional fields.
    # Required fields:
    id_val = data["id"]
    if isinstance(id_val, bool) or not isinstance(id_val, int):
        raise ValueError(f"'id' must be an integer, got {type(id_val).__name__}")
    ts_val = data["timestamp_ms"]
    if isinstance(ts_val, bool) or not isinstance(ts_val, int):
        raise ValueError(f"'timestamp_ms' must be an integer, got {type(ts_val).__name__}")
    fn_val = data["fn_name"]
    if not isinstance(fn_val, str):
        raise ValueError(f"'fn_name' must be a string, got {type(fn_val).__name__}")
    mod_val = data["module"]
    if not isinstance(mod_val, str):
        raise ValueError(f"'module' must be a string, got {type(mod_val).__name__}")
    depth_val = data["depth"]
    if isinstance(depth_val, bool) or not isinstance(depth_val, int):
        raise ValueError(f"'depth' must be an integer, got {type(depth_val).__name__}")
    task_val = data["task_id"]
    if not isinstance(task_val, str):
        raise ValueError(f"'task_id' must be a string, got {type(task_val).__name__}")

    # Optional fields: only validate if present and not None.
    li_val = data.get("loop_iterations")
    if li_val is not None:
        if isinstance(li_val, bool) or not isinstance(li_val, int):
            raise ValueError(f"'loop_iterations' must be an integer, got {type(li_val).__name__}")
    else:
        li_val = None

    sd_val = data.get("stall_duration_ms")
    if sd_val is not None:
        if isinstance(sd_val, bool) or not isinstance(sd_val, int):
            raise ValueError(f"'stall_duration_ms' must be an integer, got {type(sd_val).__name__}")
    else:
        sd_val = None

    et_val = data.get("error_type")
    if et_val is not None:
        if not isinstance(et_val, str):
            raise ValueError(f"'error_type' must be a string, got {type(et_val).__name__}")
    else:
        et_val = None

    return TelemetryFrame(
        id=id_val,
        timestamp_ms=ts_val,
        type=etype,
        fn_name=fn_val,
        module=mod_val,
        depth=depth_val,
        task_id=task_val,
        loop_iterations=li_val,
        stall_duration_ms=sd_val,
        error_type=et_val,
    )


def loads_frame(raw: str) -> TelemetryFrame:
    """Deserialize a JSON string into a frame (raises ``ValueError`` on any malformed input)."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"malformed JSON: {exc}") from exc
    return frame_from_dict(data)