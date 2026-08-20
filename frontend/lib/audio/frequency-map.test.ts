import { describe, expect, it } from "vitest";
import {
  BASE_DEPTH_FREQUENCY,
  PENTATONIC_FREQUENCIES,
  depthToFrequency,
} from "./frequency-map";

describe("PENTATONIC_FREQUENCIES (PRD §5.2 table)", () => {
  it("starts at C3 = 130.81; the PRD range ends at A6 = 1760.00 (index 19)", () => {
    expect(PENTATONIC_FREQUENCIES[0]).toBe(130.81);
    expect(PENTATONIC_FREQUENCIES[19]).toBe(1760.0);
    // Depths 21..32 extend the ladder upward (C7 → D9) — monotonic by design.
    expect(PENTATONIC_FREQUENCIES[PENTATONIC_FREQUENCIES.length - 1]).toBe(9397.28);
  });

  it("contains exactly the PRD first five degrees", () => {
    expect(PENTATONIC_FREQUENCIES.slice(0, 5)).toEqual([130.81, 146.83, 164.81, 196.0, 220.0]);
  });
});

describe("depthToFrequency", () => {
  it("maps depth 1..20 to the exact PRD table", () => {
    for (let depth = 1; depth <= 20; depth++) {
      expect(depthToFrequency(depth)).toBe(PENTATONIC_FREQUENCIES[depth - 1]);
    }
  });

  it("maps the octave anchors: C3, C4, A4, C5, A5, C6, A6", () => {
    expect(depthToFrequency(1)).toBe(130.81);
    expect(depthToFrequency(6)).toBe(261.63);
    expect(depthToFrequency(10)).toBe(440.0);
    expect(depthToFrequency(11)).toBe(523.25);
    expect(depthToFrequency(15)).toBe(880.0);
    expect(depthToFrequency(16)).toBe(1046.5);
    expect(depthToFrequency(20)).toBe(1760.0);
  });

  it("continues the ladder upward for depths 21..32 (monotonic, PLAN Task 3.2)", () => {
    expect(depthToFrequency(21)).toBe(2093.0); // C7
    expect(depthToFrequency(25)).toBe(3520.0); // A7
    expect(depthToFrequency(32)).toBe(9397.28); // D9
    expect(depthToFrequency(33)).toBe(9397.28); // clamps at the top
  });

  it("is strictly ascending across the whole sonified 1..32 range", () => {
    for (let depth = 1; depth < 32; depth++) {
      expect(depthToFrequency(depth + 1)).toBeGreaterThan(depthToFrequency(depth));
    }
  });

  it("degrades invalid depths to the scale root (fail-safe)", () => {
    expect(depthToFrequency(0)).toBe(BASE_DEPTH_FREQUENCY);
    expect(depthToFrequency(-7)).toBe(BASE_DEPTH_FREQUENCY);
    expect(depthToFrequency(Number.NaN)).toBe(BASE_DEPTH_FREQUENCY);
    expect(depthToFrequency(Number.POSITIVE_INFINITY)).toBe(BASE_DEPTH_FREQUENCY);
  });
});