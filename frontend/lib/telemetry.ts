/**
 * Shared telemetry contracts for the SonarTrace frontend.
 *
 * Mirrors `backend/sonartrace/types.py` (PRD §5.1) exactly so JSON frames
 * arriving over the Phase 2 WebSocket are wire-compatible with this module.
 * Field names intentionally keep the backend's snake_case.
 */

export type EventType =
  | "CALL"
  | "RETURN"
  | "AWAIT"
  | "RESUME"
  | "LOOP_BURST"
  | "STALL"
  | "EXCEPTION";

export const EVENT_TYPES: readonly EventType[] = [
  "CALL",
  "RETURN",
  "AWAIT",
  "RESUME",
  "LOOP_BURST",
  "STALL",
  "EXCEPTION",
] as const;

// O(1) membership lookup: frames arrive at event rate over the WebSocket
// (Phase 4), so every frame is validated here — a Set beats array .includes()
// (O(n) scan) with zero allocation, and the set is fixed at module load.
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export interface TelemetryFrame {
  /** Monotonic sequence ID. */
  id: number;
  /** Epoch timestamp (ms). */
  timestamp_ms: number;
  type: EventType;
  /** Function / coroutine identifier. */
  fn_name: string;
  /** File or module path. */
  module: string;
  /** Current call-stack depth (sonified in the 1..32 range). */
  depth: number;
  /** Coroutine ID (e.g. "task-0", "main"). */
  task_id: string;
  /** Populated for LOOP_BURST. */
  loop_iterations?: number;
  /** Populated for STALL. */
  stall_duration_ms?: number;
  /** Populated for EXCEPTION. */
  error_type?: string;
}

/** Narrowing guard for untrusted WebSocket payloads (PRD §5.1). O(1). */
export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

/**
 * Validates that an unknown JSON payload is a well-formed TelemetryFrame.
 * Used at the WebSocket boundary (Phase 4) and by the synthesizer's guards.
 */
export function isTelemetryFrame(value: unknown): value is TelemetryFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame.id === "number" &&
    typeof frame.timestamp_ms === "number" &&
    isEventType(frame.type) &&
    typeof frame.fn_name === "string" &&
    typeof frame.module === "string" &&
    typeof frame.depth === "number" &&
    typeof frame.task_id === "string"
  );
}