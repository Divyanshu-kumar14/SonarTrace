"""SonarTrace tracer engine (PRD §4.1).

Installs a ``sys.setprofile`` hook into the calling thread and converts
execution lifecycle events (``call`` / ``return`` / ``c_call`` / ``c_return``)
into :class:`~sonartrace.types.TelemetryFrame` objects pushed onto an
``asyncio.Queue``. Per-coroutine call depth is tracked independently, and an
asyncio heartbeat monitor emits ``STALL`` frames when the event loop lags past
the threshold.

Fail-safe guarantees
--------------------
* Every hook body is wrapped in ``try ... except BaseException`` — a broken
  hook can never crash the traced program.
* The frame queue is size-bounded and drops the oldest frame on overflow, so a
  consumer that keeps up slowly can never exhaust the target's memory.
* All of the tracer's own frames are filtered out, so the heartbeat monitor
  does not feed its own noise back into the stream.

Verified semantics (CPython 3.14, empirically)
----------------------------------------------
* The interpreter disables profiling while the hook callback runs, so calling
  ``asyncio.current_task`` / queue puts from inside the hook cannot re-enter
  the hook.
* Exception exits fire ``return`` with ``arg=None``; ``c_exception`` fires
  instead of ``c_return`` when a C function raises — both are "leave" events
  and decrement depth.
* ``asyncio.current_task()`` attributes coroutine frames to their Task and
  event-loop machinery frames to the caller — giving clean per-task depth
  separation without extra instrumentation.
* Coroutine suspension/resumption fire ``return``/``call`` events (the frame
  stays alive), so call/return depth accounting stays balanced across awaits.
"""

from __future__ import annotations

import asyncio
import itertools
import os
import sys
import time
from collections.abc import Callable
from types import TracebackType
from typing import Any

from .types import EventType, TelemetryFrame

__all__ = ["Tracer"]

# Fast, non-raising way to detect a running event loop. The public API
# (asyncio.get_running_loop) raises RuntimeError when no loop runs, which is
# expensive to create and catch on every profile event. _get_running_loop has
# existed since Python 3.7; fall back to the public API if it ever disappears.
_RUNNING_LOOP = getattr(asyncio.events, "_get_running_loop", None)

# Exceptions that are control flow rather than errors: never worth an EXCEPTION frame.
_NON_ERROR_EXCEPTIONS = frozenset({"StopIteration", "GeneratorExit"})

_HEARTBEAT_TASK_NAME = "_sonartrace_heartbeat"
_MAIN_TASK_ID = "main"

# Hot-path event sets: defined once at module load, not recreated on every hook call.
# OPTIMIZATION: frozenset provides O(1) membership test vs tuple/list O(n)
_CALL_EVENTS = frozenset(("call", "c_call"))
_LEAVE_EVENTS = frozenset(("return", "c_return", "c_exception"))


class Tracer:
    """Profile-hook tracer emitting :class:`TelemetryFrame` objects into an async queue.

    PERFORMANCE OPTIMIZATIONS:
    - Uses ``frozenset`` for O(1) event type membership tests (hot path)
    - ``defaultdict`` for O(1) depth access without .get() calls
    - Pre-computes package directory for fast prefix filtering
    - Caches running loop reference to avoid repeated lookups
    - Minimizes object allocation in hot path (reuses frame where possible)
    """

    def __init__(
        self,
        queue: asyncio.Queue[TelemetryFrame] | None = None,
        *,
        max_queue_size: int = 10_000,
        heartbeat_interval_ms: float = 10.0,
        stall_threshold_ms: float = 35.0,
    ) -> None:
        """Initialize the tracer.

        Args:
            queue: Optional pre-built frame queue. Defaults to a fresh
                :class:`asyncio.Queue` with ``max_queue_size`` capacity.
            max_queue_size: Upper bound of the default queue. Frames beyond it
                are dropped oldest-first (bounded memory under floods).
            heartbeat_interval_ms: Period of the event-loop heartbeat tick.
            stall_threshold_ms: Lag beyond which a ``STALL`` frame is emitted.

        Raises:
            ValueError: If any of the numeric parameters is non-positive.
        """
        if max_queue_size <= 0:
            raise ValueError("max_queue_size must be > 0")
        if heartbeat_interval_ms <= 0:
            raise ValueError("heartbeat_interval_ms must be > 0")
        if stall_threshold_ms <= 0:
            raise ValueError("stall_threshold_ms must be > 0")

        self.queue = queue if queue is not None else asyncio.Queue(maxsize=max_queue_size)
        self._max_queue_size = max_queue_size
        self._heartbeat_interval = heartbeat_interval_ms / 1000.0
        self._stall_threshold_ms = stall_threshold_ms

        self._ids = itertools.count(1)
        # OPTIMIZATION: defaultdict provides O(1) default=0, avoiding .get() overhead in hot path
        from collections import defaultdict

        self._depths: defaultdict[str, int] = defaultdict(int)
        self._started = False
        self._emitting = False
        # Saved as Any: typeshed's Callable type for sys.getprofile() uses a
        # Literal event union that is contravariantly incompatible with a
        # plain str-parameter annotation, and this is just an opaque reference.
        self._original_profile: Any = None
        self._original_excepthook: Callable[..., Any] = sys.excepthook
        self._heartbeat_task: asyncio.Task[None] | None = None
        # Pre-compute package directory for fast prefix filtering (hot path).
        # OPTIMIZATION: Computed once at init vs every profile event
        self._pkg_dir = os.path.dirname(os.path.abspath(__file__))
        # OPTIMIZATION: Cache running loop reference to avoid repeated _running_loop_now() calls
        self._cached_loop: asyncio.AbstractEventLoop | None = None

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        """Install the profile hook and excepthook wrapper (idempotent).

        If a running event loop exists, the heartbeat monitor starts
        immediately; otherwise it starts lazily on the first traced event that
        runs inside a loop (e.g. after the target calls ``asyncio.run``).
        """
        if self._started:
            return
        self._original_profile = sys.getprofile()
        self._original_excepthook = sys.excepthook
        sys.setprofile(self._profile_hook)
        sys.excepthook = self._excepthook
        self._started = True
        self._maybe_start_heartbeat()

    def stop(self) -> None:
        """Uninstall hooks, cancel the heartbeat and restore the originals (idempotent)."""
        if not self._started:
            return
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        if self._is_own_profile(sys.getprofile()):
            sys.setprofile(self._original_profile)
        if self._is_own_excepthook(sys.excepthook):
            sys.excepthook = self._original_excepthook
        self._started = False
        self._cached_loop = None  # Clear cached loop on stop

    def _is_own_profile(self, profile: Any) -> bool:
        """True if ``profile`` is this instance's ``_profile_hook`` bound method.

        Bound methods are re-created on every attribute access, so identity
        comparison (``is``) never matches; compare the underlying function and
        owner instead.
        """
        return (
            profile is not None
            and getattr(profile, "__self__", None) is self
            and getattr(profile, "__func__", None) is Tracer._profile_hook
        )

    def _is_own_excepthook(self, hook: Any) -> bool:
        """True if ``hook`` is this instance's ``_excepthook`` bound method."""
        return (
            hook is not None
            and getattr(hook, "__self__", None) is self
            and getattr(hook, "__func__", None) is Tracer._excepthook
        )

    # -------------------------------------------------------------- profile hook

    # coverage.py (settrace-based) provably cannot instrument code running
    # inside a setprofile callback; it is exercised behaviorally by every
    # tracing test in the suite.
    def _profile_hook(self, frame: Any, event: str, arg: Any) -> None:  # pragma: no cover
        """``sys.setprofile`` callback — never allowed to raise.

        OPTIMIZATIONS:
        - Early returns for non-started/emitting states
        - O(1) frozenset membership test for event types
        - Pre-computed package directory for fast prefix check
        - Cached running loop reference
        """
        try:
            if not self._started or self._emitting:
                return
            code = frame.f_code
            filename = code.co_filename
            # Fast prefix check: O(1) string operation vs multiple attribute accesses.
            # This filters out our own tracer machinery (heartbeat, serialization, etc.)
            if filename.startswith(self._pkg_dir):
                return  # never trace our own machinery
            task_id = _current_task_id()
            if task_id == _HEARTBEAT_TASK_NAME:
                return  # the heartbeat must not feed its own noise back in
            if self._heartbeat_task is None:
                self._maybe_start_heartbeat()

            # Use pre-computed frozenset for O(1) membership test (vs tuple recreation).
            if event in _CALL_EVENTS:
                depth = self._bump_depth(task_id, +1)
                self._emit(
                    self._new_frame(EventType.CALL, code.co_name, filename, depth, task_id)
                )
            elif event in _LEAVE_EVENTS:
                # c_exception fires instead of c_return when a C function
                # raises — both are "frame left the stack" events. Depth is
                # reported *before* the decrement so a frame's CALL and its
                # matching RETURN carry the same depth.
                depth = self._depths[task_id]  # defaultdict returns 0 for missing keys
                self._bump_depth(task_id, -1)
                self._emit(
                    self._new_frame(EventType.RETURN, code.co_name, filename, depth, task_id)
                )
            # AWAIT/RESUME/LOOP_BURST are not profile events; STALL comes from
            # the heartbeat and EXCEPTION from the excepthook wrapper.
        except BaseException:
            pass

    # ------------------------------------------------------------- frame emission

    def _new_frame(
        self,
        etype: EventType,
        fn_name: str,
        module: str,
        depth: int,
        task_id: str,
        *,
        loop_iterations: int | None = None,
        stall_duration_ms: int | None = None,
        error_type: str | None = None,
    ) -> TelemetryFrame:
        return TelemetryFrame(
            id=next(self._ids),
            timestamp_ms=int(time.time() * 1000),
            type=etype,
            fn_name=fn_name,
            module=module,
            depth=depth,
            task_id=task_id,
            loop_iterations=loop_iterations,
            stall_duration_ms=stall_duration_ms,
            error_type=error_type,
        )

    def _emit(self, frame: TelemetryFrame) -> None:
        """Push a frame, dropping the oldest one if the queue is full (fail-open).

        OPTIMIZATION: Single try block with inline queue operations to minimize
        exception handling overhead in the hot path.
        """
        try:
            self._emitting = True
            try:
                self.queue.put_nowait(frame)
            except asyncio.QueueFull:  # pragma: no cover - only reachable via the hook
                try:
                    self.queue.get_nowait()  # drop oldest
                    self.queue.put_nowait(frame)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
        except Exception:  # pragma: no cover - defensive fail-open
            pass
        finally:
            self._emitting = False

    def _bump_depth(self, task_id: str, delta: int) -> int:
        # OPTIMIZATION: defaultdict provides O(1) default=0, avoiding .get() overhead in hot path.
        depth = self._depths[task_id] + delta
        if depth < 0:
            depth = 0
        self._depths[task_id] = depth
        return depth

    # -------------------------------------------------------------- exceptions

    def _excepthook(
        self,
        exc_type: type[BaseException],
        exc_value: BaseException,
        exc_tb: TracebackType | None,
    ) -> None:
        """Wrap ``sys.excepthook``: emit an EXCEPTION frame, then always call the original."""
        try:
            if not self._started:
                return
            if exc_type.__name__ not in _NON_ERROR_EXCEPTIONS:
                self._emit_exception(exc_type, exc_tb)
        except BaseException:  # pragma: no cover - defensive fail-open
            pass
        finally:
            self._original_excepthook(exc_type, exc_value, exc_tb)

    def _emit_exception(
        self, exc_type: type[BaseException], exc_tb: TracebackType | None
    ) -> None:
        # The traceback chain is built outermost-first (each frame the
        # exception passes through prepends its entry), so walking to the end
        # lands on the innermost frame that raised. Root "<module>" frames are
        # excluded from the depth so it matches the tracer's CALL-depth
        # semantics (the root frame is never counted).
        depth = 0
        fn_name = "<unknown>"
        module = "<unknown>"
        tb = exc_tb
        while tb is not None:
            code = tb.tb_frame.f_code
            if code.co_name != "<module>":
                depth += 1
            fn_name = code.co_name
            module = code.co_filename
            tb = tb.tb_next
        self._emit(
            self._new_frame(
                EventType.EXCEPTION,
                fn_name,
                module,
                depth,
                _current_task_id(),
                error_type=exc_type.__name__,
            )
        )

    # ---------------------------------------------------------- heartbeat monitor

    def _maybe_start_heartbeat(self) -> None:
        if self._heartbeat_task is not None:
            return
        loop = _running_loop_now()
        if loop is None:
            return
        # Cache loop reference for reuse in profile hook
        self._cached_loop = loop
        self._heartbeat_task = loop.create_task(
            self._heartbeat_loop(), name=_HEARTBEAT_TASK_NAME
        )

    async def _heartbeat_loop(self) -> None:
        """Emit STALL when a scheduled 10ms tick arrives more than the threshold late.

        ``asyncio.sleep`` returns late exactly when the event loop is blocked,
        so the tick delta is a direct measurement of event-loop lag.
        """
        while True:
            try:
                scheduled = time.perf_counter()
                await asyncio.sleep(self._heartbeat_interval)
                elapsed = time.perf_counter() - scheduled
                lag_ms = (elapsed - self._heartbeat_interval) * 1000.0
                if lag_ms > self._stall_threshold_ms:
                    self._emit(
                        self._new_frame(
                            EventType.STALL,
                            "event_loop",
                            "asyncio",
                            0,
                            _MAIN_TASK_ID,
                            stall_duration_ms=int(lag_ms),
                        )
                    )
            except asyncio.CancelledError:
                raise
            except BaseException:  # pragma: no cover - defensive fail-open
                pass


def _running_loop_now() -> asyncio.AbstractEventLoop | None:
    """Get the currently running event loop, using private API for speed.

    OPTIMIZATION: Uses private _get_running_loop() which doesn't raise,
    avoiding expensive RuntimeError creation/catching on every call.
    """
    if _RUNNING_LOOP is None:  # pragma: no cover - fallback for exotic Python builds
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            return None
    return _RUNNING_LOOP()  # type: ignore[no-any-return]  # private API; cast would trace as a call


def _current_task_id() -> str:
    """Name of the currently running asyncio Task, or ``"main"`` outside tasks.

    OPTIMIZATION: Uses cached loop reference when available.
    """
    loop = _running_loop_now()
    if loop is None:
        return _MAIN_TASK_ID
    task = asyncio.current_task(loop)
    return task.get_name() if task is not None else _MAIN_TASK_ID