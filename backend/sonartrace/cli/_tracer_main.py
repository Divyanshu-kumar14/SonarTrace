"""Internal tracer main module.

This module is executed as a subprocess by the CLI to run the target script
with SonarTrace profiling enabled. It reads configuration from environment
variables and streams telemetry frames to the WebSocket ingress endpoint.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import websockets

from sonartrace import TelemetryFrame, Tracer, dumps_frame
from sonartrace.aggregator import AggregatorConfig, LoopAggregator
from sonartrace.serialization import loads_frame
from sonartrace.ws_protocol import MessageType, make_ingress_frame

__all__ = ["main"]


async def _connect_with_retry(url: str, max_retries: int = 10, base_delay: float = 0.5) -> websockets.ClientConnection:
    """Connect to WebSocket with exponential backoff."""
    for attempt in range(max_retries):
        try:
            return await websockets.connect(url, max_size=10 * 1024 * 1024)
        except Exception:
            if attempt == max_retries - 1:
                raise
            await asyncio.sleep(base_delay * (2**attempt))
    raise RuntimeError("unreachable")


class _YieldingTracer(Tracer):
    """Tracer that yields to the event loop periodically during profiling.

    OPTIMIZATION: Instead of complex thread-safe queue machinery, this tracer
    runs in the main thread but yields control to the event loop every N calls.
    This allows the frame_sender task to run concurrently without deadlocks.
    """

    def __init__(self, queue, yield_interval: int = 500):
        super().__init__(queue=queue)
        self._yield_interval = yield_interval
        self._call_count = 0

    def _profile_hook(self, frame, event, arg):  # type: ignore[override]
        """Profile hook that yields to event loop periodically."""
        try:
            if not self._started or self._emitting:
                return
            code = frame.f_code
            filename = code.co_filename
            if filename.startswith(self._pkg_dir):
                return
            task_id = _current_task_id()
            if task_id == _HEARTBEAT_TASK_NAME:
                return
            if self._heartbeat_task is None:
                self._maybe_start_heartbeat()

            if event in _CALL_EVENTS:
                depth = self._bump_depth(task_id, +1)
                self._emit(
                    self._new_frame(EventType.CALL, code.co_name, filename, depth, task_id)
                )
            elif event in _LEAVE_EVENTS:
                depth = self._depths[task_id]
                self._bump_depth(task_id, -1)
                self._emit(
                    self._new_frame(EventType.RETURN, code.co_name, filename, depth, task_id)
                )

            # Yield to event loop periodically
            self._call_count += 1
            if self._call_count >= self._yield_interval:
                self._call_count = 0
                # Schedule a yield to the event loop
                import asyncio
                try:
                    loop = asyncio.get_running_loop()
                    loop.call_soon(asyncio.sleep, 0)
                except RuntimeError:
                    pass  # No running loop
        except BaseException:
            pass


async def _tracer_main() -> int:
    """Main async entry point for the tracer subprocess."""
    # Read configuration from environment
    ingress_url = os.environ.get("SONARTRACE_INGRESS_URL", "ws://127.0.0.1:8765/ws/ingress")
    window_ms = int(os.environ.get("SONARTRACE_AGG_WINDOW_MS", "50"))
    threshold = int(os.environ.get("SONARTRACE_AGG_THRESHOLD", "20"))

    if len(sys.argv) < 2:
        print("Usage: python -m sonartrace.cli._tracer_main <script.py> [args...]", file=sys.stderr)
        return 1

    script_path = sys.argv[1]
    script_args = sys.argv[2:]

    # Prepare aggregator
    agg_config = AggregatorConfig(window_ms=window_ms, threshold=threshold)
    aggregator = LoopAggregator(agg_config)

    # Connect to ingress WebSocket
    ws = await _connect_with_retry(ingress_url)

    # Set up yielding tracer
    frame_queue: asyncio.Queue[TelemetryFrame] = asyncio.Queue(maxsize=10_000)
    tracer = _YieldingTracer(queue=frame_queue, yield_interval=500)
    tracer.start()

    # Prepare script globals
    script_globals = {
        "__name__": "__main__",
        "__file__": script_path,
        "__package__": None,
        "sys": sys,
    }
    sys.argv = [script_path, *script_args]

    # Frame sender task
    async def frame_sender() -> None:
        try:
            while True:
                frame = await frame_queue.get()
                try:
                    # Process through aggregator
                    for result in aggregator.process_single(frame):
                        if result is not None:
                            json_frame = dumps_frame(result)
                            msg = make_ingress_frame(json_frame)
                            await ws.send(json.dumps(msg, separators=(",", ":")))
                finally:
                    frame_queue.task_done()
        except websockets.ConnectionClosed:
            pass
        except asyncio.CancelledError:
            # Drain remaining frames on cancellation
            while not frame_queue.empty():
                frame = frame_queue.get_nowait()
                try:
                    for result in aggregator.process_single(frame):
                        if result is not None:
                            json_frame = dumps_frame(result)
                            msg = make_ingress_frame(json_frame)
                            await ws.send(json.dumps(msg, separators=(",", ":")))
                finally:
                    frame_queue.task_done()
            raise
        except Exception:
            pass

    sender_task = asyncio.create_task(frame_sender(), name="frame_sender")

    # Heartbeat task
    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(5.0)
            try:
                msg = {"type": MessageType.HEARTBEAT.value}
                await ws.send(json.dumps(msg, separators=(",", ":")))
            except Exception:
                break

    heartbeat_task = asyncio.create_task(heartbeat(), name="heartbeat")

    # Prepare script globals
    script_globals = {
        "__name__": "__main__",
        "__file__": script_path,
        "__package__": None,
        "sys": sys,
    }
    sys.argv = [script_path, *script_args]

    # Execute the target script
    exit_code = 0
    try:
        with open(script_path, "rb") as f:
            code = compile(f.read(), script_path, "exec")
        exec(code, script_globals)
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else 1
    except Exception:
        exit_code = 1
    finally:
        # Cleanup: wait for frame queue to drain before cancelling sender
        tracer.stop()
        # Wait for frame queue to drain (with timeout)
        try:
            await asyncio.wait_for(frame_queue.join(), timeout=2.0)
        except asyncio.TimeoutError:
            pass
        sender_task.cancel()
        try:
            await sender_task
        except asyncio.CancelledError:
            pass
        await ws.close()

    return exit_code


def main() -> int:
    """Synchronous entry point."""
    return asyncio.run(_tracer_main())


if __name__ == "__main__":
    sys.exit(main())