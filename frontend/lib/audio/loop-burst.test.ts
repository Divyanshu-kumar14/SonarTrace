import { describe, expect, it } from "vitest";
import {
  createFakeAudio,
  fakeGain,
  fakeOsc,
  fakeParam,
} from "../../tests/helpers/webaudio-fake";
import { DEFAULT_LOOP_BURST_PARAMS, loopBurstFrequency, playLoopBurst } from "./loop-burst";

describe("loopBurstFrequency (PRD §5.2: f_base + log10(iterations) × 30Hz)", () => {
  it("drifts logarithmically with iteration count", () => {
    expect(loopBurstFrequency(220, 1)).toBe(220); // log10(1) = 0
    expect(loopBurstFrequency(220, 10)).toBe(250);
    expect(loopBurstFrequency(220, 100)).toBe(280);
    expect(loopBurstFrequency(220, 1000)).toBe(310);
  });

  it("degrades invalid iteration counts to zero drift", () => {
    expect(loopBurstFrequency(220, 0)).toBe(220);
    expect(loopBurstFrequency(220, -5)).toBe(220);
    expect(loopBurstFrequency(220, Number.NaN)).toBe(220);
  });
});

describe("playLoopBurst (PLAN Task 3.4: texture change, not clicks)", () => {
  it("stacks the fundamental + harmonics at the drifted frequency", () => {
    const { fake, ctx } = createFakeAudio();
    const output = ctx.createGain();
    playLoopBurst(ctx, output, 220, 100); // f = 280

    const oscillators = fake.byKind("oscillator") as unknown as OscillatorNode[];
    const freqs = oscillators.map((o) => fakeOsc(o).frequency.value).sort((a, b) => a - b);
    expect(freqs).toEqual([280, 560, 840]);

    for (const osc of oscillators) {
      const f = fakeOsc(osc);
      expect(f.type).toBe("triangle");
      expect(f.startedAt).toBe(0);
      expect(f.stoppedAt).toBeCloseTo(0.26, 5);
    }
  });

  it("scales partial gains down so the chord stays balanced", () => {
    const { fake, ctx } = createFakeAudio();
    const output = ctx.createGain();
    playLoopBurst(ctx, output, 220, 10);

    const gains = fake.byKind("gain").slice(1) as unknown as GainNode[];
    const peaks = gains.map((g) => fakeParam(fakeGain(g).gain).eventsOf("ramp")[0]!.value);
    expect(peaks[0]).toBeCloseTo(DEFAULT_LOOP_BURST_PARAMS.peak, 6);
    expect(peaks[1]).toBeCloseTo(DEFAULT_LOOP_BURST_PARAMS.peak / 2, 6);
    expect(peaks[2]).toBeCloseTo(DEFAULT_LOOP_BURST_PARAMS.peak / 3, 6);
  });

  it("uses a texture-style attack (15ms) rather than a percussive 2ms click", () => {
    const { fake, ctx } = createFakeAudio();
    const output = ctx.createGain();
    playLoopBurst(ctx, output, 220, 10);

    const gain = fakeGain(fake.byKind("gain")[1] as unknown as GainNode);
    const attack = fakeParam(gain.gain).eventsOf("ramp")[0]!;
    expect(attack.time).toBeCloseTo(DEFAULT_LOOP_BURST_PARAMS.attack, 6);
  });
});