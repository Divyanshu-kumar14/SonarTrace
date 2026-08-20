import { describe, expect, it } from "vitest";
import { createFakeAudio, fakeGain, fakeParam } from "../../tests/helpers/webaudio-fake";
import {
  DEFAULT_ENVELOPE,
  envelopeDuration,
  normalizeEnvelope,
  scheduleAttackEnvelope,
  scheduleReleaseEnvelope,
} from "./envelope";

describe("normalizeEnvelope", () => {
  it("returns PRD defaults untouched", () => {
    expect(normalizeEnvelope({})).toEqual({
      attack: 0.002,
      decay: 0.04,
      sustain: 0,
      release: 0.01,
      peak: 0.5,
    });
  });

  it("clamps negative values and falls back on non-finite ones", () => {
    const p = normalizeEnvelope({ attack: -1, decay: Number.NaN, peak: -0.2, release: 99 });
    expect(p.attack).toBe(0);
    expect(p.decay).toBe(DEFAULT_ENVELOPE.decay);
    expect(p.peak).toBe(0);
    expect(p.release).toBe(99);
  });
});

describe("scheduleAttackEnvelope (PRD: attack 2ms, decay 40ms)", () => {
  it("schedules a click-free 0 → peak → sustain ramp", () => {
    const { ctx } = createFakeAudio();
    const gain = ctx.createGain();
    const t0 = scheduleAttackEnvelope(gain, ctx);

    const param = fakeParam(fakeGain(gain).gain);
    const sets = param.eventsOf("set");
    const ramps = param.eventsOf("ramp");

    expect(t0).toBe(0);
    expect(sets.map((e) => [e.value, e.time])).toEqual([
      [0, 0], // anchor at exactly 0 → no click
    ]);
    expect(ramps.map((e) => [e.value, e.time])).toEqual([
      [0.5, 0.002], // attack to peak
      [0.0, 0.042], // decay to sustain 0
    ]);
  });

  it("honors custom params (attack 10ms, decay 100ms, sustain 0.5, peak 0.8)", () => {
    const { ctx } = createFakeAudio();
    const gain = ctx.createGain();
    scheduleAttackEnvelope(gain, ctx, { attack: 0.01, decay: 0.1, sustain: 0.5, peak: 0.8 });

    const ramps = fakeParam(fakeGain(gain).gain).eventsOf("ramp");
    expect(ramps.map((e) => [e.value, e.time])).toEqual([
      [0.8, 0.01],
      [0.4, 0.11],
    ]);
  });

  it("cancels stale automation before scheduling (reused GainNodes)", () => {
    const { ctx } = createFakeAudio();
    const gain = ctx.createGain();
    scheduleAttackEnvelope(gain, ctx);
    scheduleAttackEnvelope(gain, ctx);

    const events = fakeParam(fakeGain(gain).gain).events;
    expect(events[events.length - 4].op).toBe("cancel");
  });
});

describe("scheduleReleaseEnvelope (PRD: release 10ms)", () => {
  it("anchors the current value and ramps to 0, returning the stop time", () => {
    const { fake, ctx } = createFakeAudio();
    fake.advance(1.0);
    const gain = ctx.createGain();
    fakeParam(fakeGain(gain).gain).value = 0.5;

    const stopAt = scheduleReleaseEnvelope(gain, ctx);

    const param = fakeParam(fakeGain(gain).gain);
    expect(param.eventsOf("ramp")).toEqual([{ op: "ramp", time: 1.01, value: 0 }]);
    expect(param.eventsOf("set").at(-1)).toMatchObject({ time: 1.0, value: 0.5 });
    expect(stopAt).toBe(1.01);
  });
});

describe("envelopeDuration", () => {
  it("totals attack + decay + release (52ms default)", () => {
    expect(envelopeDuration()).toBeCloseTo(0.052, 9);
  });
});