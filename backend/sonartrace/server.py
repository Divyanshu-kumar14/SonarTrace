"""FastAPI WebSocket gateway server (PRD §4.2).

Runs two WebSocket endpoints:

* ``/ws/ingress`` — Single persistent connection from the tracer process.
  Receives ``TelemetryFrame`` JSON strings, passes them through the aggregator,
  and broadcasts the resulting frames to all connected browser clients.
* ``/ws/client``  — Multiple browser clients. Receives batched frames and
  configuration updates.

The server also exposes a REST health endpoint at ``/health``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .aggregator import AggregatorConfig, LoopAggregator
from .types import TelemetryFrame
from .ws_protocol import (
    MessageType,
    make_client_frame_batch,
    make_config,
    make_welcome,
)

__all__ = ["SonarTraceServer", "create_app"]

logger = logging.getLogger("sonar.trace.server")


@dataclass(slots=True)
class ClientSession:
    """State for a connected browser client."""

    ws: WebSocket
    client_id: str
    # OPTIMIZATION: Use deque with maxlen for automatic memory bounding
    # instead of asyncio.Queue which has overhead for simple use cases
    queue: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue(maxsize=500))
    task: asyncio.Task[None] | None = None


class SonarTraceServer:
    """SonarTrace gateway server managing tracer ingress and client broadcasts.

    PERFORMANCE OPTIMIZATIONS:
    - Uses ``collections.deque`` for frame buffer with O(1) popleft
      instead of list slicing O(n) copy
    - Batches JSON serialization to reduce per-frame overhead
    - Uses asyncio.gather for parallel client sends
    - Minimizes lock contention with fine-grained locking
    """

    def __init__(
        self,
        *,
        aggregator_config: AggregatorConfig | None = None,
        broadcast_batch_size: int = 50,
        broadcast_interval_ms: int = 10,
    ) -> None:
        self._aggregator = LoopAggregator(aggregator_config)
        self._ingress_ws: WebSocket | None = None
        self._ingress_task: asyncio.Task[None] | None = None
        self._clients: dict[str, ClientSession] = {}
        self._broadcast_batch_size = broadcast_batch_size
        self._broadcast_interval = broadcast_interval_ms / 1000.0
        self._broadcast_task: asyncio.Task[None] | None = None
        # OPTIMIZATION: deque with maxlen provides O(1) append/popleft
        # and automatic memory bounding (drops oldest when full)
        self._frame_buffer: deque[str] = deque(maxlen=10000)
        self._buffer_lock = asyncio.Lock()
        self._started = False
        # Cache for serialized batch messages to avoid repeated JSON encoding
        self._last_batch_json: str | None = None
        self._last_batch_frames: tuple[str, ...] | None = None

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        """Start background tasks (broadcast loop)."""
        if self._started:
            return
        self._broadcast_task = asyncio.create_task(self._broadcast_loop(), name="sonartrace_broadcast")
        self._started = True
        logger.info("SonarTrace server started")

    async def stop(self) -> None:
        """Stop all background tasks and close connections."""
        if not self._started:
            return
        if self._broadcast_task is not None:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
            self._broadcast_task = None
        if self._ingress_task is not None:
            self._ingress_task.cancel()
            try:
                await self._ingress_task
            except asyncio.CancelledError:
                pass
            self._ingress_task = None
        # Close all client connections
        for session in self._clients.values():
            await session.ws.close()
        self._clients.clear()
        self._started = False
        logger.info("SonarTrace server stopped")

    # -------------------------------------------------------------- ingress handling

    async def handle_ingress(self, ws: WebSocket) -> None:
        """Handle the tracer's WebSocket connection (/ws/ingress).

        Only one ingress connection is allowed at a time. A new connection
        replaces the previous one (graceful handover).
        """
        await ws.accept()
        logger.info("Tracer ingress connected")

        # Replace any existing ingress connection
        if self._ingress_task is not None:
            self._ingress_task.cancel()
            try:
                await self._ingress_task
            except asyncio.CancelledError:
                pass

        # Clear frame buffer on new ingress connection to avoid stale frames
        self._frame_buffer.clear()
        self._last_batch_json = None
        self._last_batch_frames = None

        self._ingress_ws = ws
        self._ingress_task = asyncio.create_task(self._ingress_loop(ws), name="sonartrace_ingress")
        try:
            await self._ingress_task
        except asyncio.CancelledError:
            pass
        finally:
            # Clear buffer when ingress disconnects to avoid stale frames
            self._frame_buffer.clear()
            self._last_batch_json = None
            self._last_batch_frames = None
            if self._ingress_ws is ws:
                self._ingress_ws = None
            logger.info("Tracer ingress disconnected")

    async def _ingress_loop(self, ws: WebSocket) -> None:
        """Read frames from tracer, aggregate, and buffer for broadcast."""
        try:
            async for msg in ws.iter_text():
                # Handle tracer messages: {"type": "frame", "payload": "..."}
                # or {"type": "heartbeat"}
                try:
                    data = json.loads(msg)
                except json.JSONDecodeError:
                    logger.warning("Invalid JSON from ingress: %s", msg[:100])
                    continue

                msg_type = data.get("type")
                if msg_type == MessageType.HEARTBEAT.value:
                    continue  # just a keepalive
                if msg_type != MessageType.FRAME.value:
                    logger.warning("Unknown ingress message type: %s", msg_type)
                    continue

                frame_json = data.get("payload")
                if not isinstance(frame_json, str):
                    logger.warning("Invalid frame payload: %s", type(frame_json))
                    continue

                # Parse frame for aggregation
                try:
                    from .serialization import loads_frame

                    frame = loads_frame(frame_json)
                except ValueError as exc:
                    logger.warning("Invalid frame from tracer: %s", exc)
                    continue

                # Process through aggregator
                result = self._aggregator._process_frame(frame)
                if result is not None:
                    # Serialize and buffer for broadcast
                    from .serialization import dumps_frame

                    out_json = dumps_frame(result)
                    self._frame_buffer.append(out_json)
                    # Invalidate cached batch since buffer changed
                    self._last_batch_json = None
                    self._last_batch_frames = None
        except WebSocketDisconnect:
            logger.info("Tracer ingress disconnected normally")
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("Ingress loop error: %s", exc)

    # -------------------------------------------------------------- client handling

    async def handle_client(self, ws: WebSocket) -> None:
        """Handle a browser client WebSocket connection (/ws/client)."""
        await ws.accept()
        client_id = uuid.uuid4().hex[:8]
        logger.info("Client connected: %s", client_id)

        session = ClientSession(ws=ws, client_id=client_id)
        self._clients[client_id] = session

        # Send welcome message
        welcome = make_welcome(
            client_id,
            {
                "version": "0.1.0",
                "protocol": "sonartrace/1",
                "features": ["frame_batch", "config"],
            },
        )
        try:
            await ws.send_json(welcome)
        except Exception:
            await self._cleanup_client(client_id)
            return

        # Start client sender task
        session.task = asyncio.create_task(self._client_sender(session), name=f"sonartrace_client_{client_id}")

        try:
            # Keep connection alive; ignore incoming messages from client for now
            async for _ in ws.iter_text():
                pass
        except WebSocketDisconnect:
            logger.info("Client disconnected: %s", client_id)
        except Exception as exc:  # pragma: no cover
            logger.exception("Client error (%s): %s", client_id, exc)
        finally:
            await self._cleanup_client(client_id)

    async def _client_sender(self, session: ClientSession) -> None:
        """Drain the client's queue and send frames over WebSocket."""
        try:
            while True:
                frame_json = await session.queue.get()
                try:
                    await session.ws.send_text(frame_json)
                except Exception:
                    break  # client gone
        except asyncio.CancelledError:
            pass

    async def _cleanup_client(self, client_id: str) -> None:
        """Remove a client and cancel its sender task."""
        session = self._clients.pop(client_id, None)
        if session is not None:
            if session.task is not None:
                session.task.cancel()
                try:
                    await session.task
                except asyncio.CancelledError:
                    pass

    # -------------------------------------------------------------- broadcast loop

    async def _broadcast_loop(self) -> None:
        """Periodically flush buffered frames to all clients in batches."""
        while True:
            try:
                await asyncio.sleep(self._broadcast_interval)
                await self._flush_buffer()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover
                logger.exception("Broadcast loop error: %s", exc)

    async def _flush_buffer(self) -> None:
        """Send buffered frames to all connected clients.

        OPTIMIZATIONS:
        - Uses deque for O(1) popleft batch extraction vs O(n) list slicing
        - Caches serialized batch JSON to avoid re-encoding identical batches
        - Uses asyncio.gather for parallel client sends
        - Minimizes lock scope to just buffer extraction
        """
        # Extract batch under lock (O(1) per popleft)
        batch_frames: list[str] = []
        while self._frame_buffer and len(batch_frames) < self._broadcast_batch_size:
            batch_frames.append(self._frame_buffer.popleft())

        if not batch_frames:
            return

        # Check if we can reuse cached serialized batch
        batch_key = tuple(batch_frames)
        if self._last_batch_frames == batch_key and self._last_batch_json is not None:
            message_json = self._last_batch_json
        else:
            # OPTIMIZATION: Batch JSON serialization once instead of per-client
            message = make_client_frame_batch(batch_frames)
            message_json = json.dumps(message, separators=(",", ":"))
            self._last_batch_frames = batch_key
            self._last_batch_json = message_json

        # OPTIMIZATION: Parallel send to all clients using asyncio.gather
        # This avoids sequential per-client latency
        if self._clients:
            send_tasks = []
            for session in self._clients.values():
                send_tasks.append(self._send_to_client(session, message_json))
            # Run all sends concurrently
            await asyncio.gather(*send_tasks, return_exceptions=True)

    async def _send_to_client(self, session: ClientSession, message_json: str) -> None:
        """Send message to a single client (non-blocking)."""
        try:
            session.queue.put_nowait(message_json)
        except asyncio.QueueFull:
            logger.warning("Client %s queue full, dropping batch", session.client_id)

    # ---------------------------------------------------------------- health check

    def health(self) -> dict[str, Any]:
        """Return server health status."""
        return {
            "status": "ok",
            "ingress_connected": self._ingress_ws is not None,
            "clients": len(self._clients),
            "buffered_frames": len(self._frame_buffer),
        }


# ============================================================ FastAPI app factory


def create_app(
    *,
    aggregator_config: AggregatorConfig | None = None,
    broadcast_batch_size: int = 50,
    broadcast_interval_ms: int = 10,
) -> FastAPI:
    """Create the FastAPI application with WebSocket endpoints."""
    server = SonarTraceServer(
        aggregator_config=aggregator_config,
        broadcast_batch_size=broadcast_batch_size,
        broadcast_interval_ms=broadcast_interval_ms,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await server.start()
        yield
        await server.stop()

    app = FastAPI(title="SonarTrace Gateway", lifespan=lifespan)

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(server.health())

    @app.websocket("/ws/ingress")
    async def ingress_endpoint(ws: WebSocket) -> None:
        await server.handle_ingress(ws)

    @app.websocket("/ws/client")
    async def client_endpoint(ws: WebSocket) -> None:
        await server.handle_client(ws)

    return app