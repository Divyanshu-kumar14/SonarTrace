import { describe, expect, it } from "vitest";
import {
  PAN_RANGE,
  hashCacheSize,
  hashString,
  panForTask,
  waveformForTask,
} from "./panner";

const SAMPLE_TASK_IDS = [
  "main",
  "task-0",
  "task-1",
  "task-2",
  "task-3",
  "task-4",
  "task-5",
  "task-6",
  "task-7",
  "task-8",
];

describe("hashString", () => {
  it("is deterministic", () => {
    expect(hashString("task-3")).toBe(hashString("task-3"));
  });

  it("distinguishes sequential task IDs", () => {
    const hashes = SAMPLE_TASK_IDS.map(hashString);
    expect(new Set(hashes).size).toBeGreaterThan(8);
  });
});

describe("hashString memo cache (perf: O(1) amortized hot path)", () => {
  it("returns identical values on cache hits (pure semantics preserved)", () => {
    const first = hashString("task-0");
    const second = hashString("task-0");
    expect(second).toBe(first);
  });

  it("stays bounded after many unique inputs (FIFO cap, no unbounded growth)", () => {
    for (let i = 0; i < 500; i++) {
      hashString(`unique-task-${i}`);
    }
    expect(hashCacheSize()).toBeLessThanOrEqual(256);
  });

  it("remains deterministic after cache churn", () => {
    const probe = "churn-probe";
    const value = hashString(probe);
    for (let i = 0; i < 300; i++) hashString(`churn-${i}`);
    expect(hashString(probe)).toBe(value);
  });
});

describe("panForTask (PRD §5.2: -0.85 to +0.85)", () => {
  it("keeps every sample task inside the pan range", () => {
    for (const id of SAMPLE_TASK_IDS) {
      expect(panForTask(id)).toBeGreaterThanOrEqual(-PAN_RANGE);
      expect(panForTask(id)).toBeLessThanOrEqual(PAN_RANGE);
    }
  });

  it("is deterministic per task", () => {
    expect(panForTask("task-2")).toBe(panForTask("task-2"));
  });

  it("spreads concurrent tasks across the field (≥3 distinct positions)", () => {
    const pans = new Set(SAMPLE_TASK_IDS.map(panForTask));
    expect(pans.size).toBeGreaterThanOrEqual(3);
  });

  it("handles the empty string deterministically", () => {
    const pan = panForTask("");
    expect(pan).toBeGreaterThanOrEqual(-PAN_RANGE);
    expect(pan).toBeLessThanOrEqual(PAN_RANGE);
    expect(panForTask("")).toBe(pan);
  });
});

describe("waveformForTask (PRD §5.2: Sine/Triangle/FM)", () => {
  it("returns only valid waveform types", () => {
    for (const id of SAMPLE_TASK_IDS) {
      expect(["sine", "triangle", "fm"]).toContain(waveformForTask(id));
    }
  });

  it("is deterministic", () => {
    expect(waveformForTask("task-1")).toBe(waveformForTask("task-1"));
  });

  it("assigns more than one timbre across tasks", () => {
    const timbres = new Set(SAMPLE_TASK_IDS.map(waveformForTask));
    expect(timbres.size).toBeGreaterThanOrEqual(2);
  });
});