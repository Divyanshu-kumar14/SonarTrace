import { describe, expect, it } from "vitest";
import { EVENT_TYPES, isEventType, isTelemetryFrame, type TelemetryFrame } from "./telemetry";

const validFrame: TelemetryFrame = {
  id: 1,
  timestamp_ms: 0,
  type: "CALL",
  fn_name: "factorial",
  module: "demo.py",
  depth: 3,
  task_id: "task-0",
};

describe("isEventType", () => {
  it("accepts every PRD §5.1 event type", () => {
    for (const type of EVENT_TYPES) {
      expect(isEventType(type)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isEventType("NOPE")).toBe(false);
    expect(isEventType("")).toBe(false);
    expect(isEventType(42)).toBe(false);
    expect(isEventType(undefined)).toBe(false);
    expect(isEventType(null)).toBe(false);
    expect(isEventType({})).toBe(false);
  });
});

describe("isTelemetryFrame", () => {
  it("accepts a well-formed frame", () => {
    expect(isTelemetryFrame(validFrame)).toBe(true);
  });

  it("accepts optional PRD fields when populated", () => {
    const rich: TelemetryFrame = {
      ...validFrame,
      loop_iterations: 99,
      stall_duration_ms: 50,
      error_type: "RecursionError",
    };
    expect(isTelemetryFrame(rich)).toBe(true);
  });

  it("rejects null and non-objects", () => {
    expect(isTelemetryFrame(null)).toBe(false);
    expect(isTelemetryFrame(undefined)).toBe(false);
    expect(isTelemetryFrame("CALL")).toBe(false);
    expect(isTelemetryFrame(42)).toBe(false);
  });

  it("rejects frames with missing or invalid fields", () => {
    expect(isTelemetryFrame({})).toBe(false);
    expect(isTelemetryFrame({ ...validFrame, type: "NOPE" })).toBe(false);
    expect(isTelemetryFrame({ ...validFrame, id: "1" })).toBe(false);
    expect(isTelemetryFrame({ ...validFrame, depth: "3" })).toBe(false);
    expect(isTelemetryFrame({ ...validFrame, task_id: undefined })).toBe(false);
    expect(isTelemetryFrame({ ...validFrame, fn_name: 42 })).toBe(false);
  });
});