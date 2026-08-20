import { describe, expect, it } from "vitest";
import {
  DEFAULT_POOL_SIZE,
  OscillatorPool,
  type PooledWaveform,
  type Voice,
} from "./oscillator-pool";
import {
  createFakeAudio,
  fakeGain,
  fakeNode,
  fakeOsc,
  type FakeOscillatorNode,
} from "../../tests/helpers/webaudio-fake";

function voiceOsc(voice: Voice): FakeOscillatorNode {
  return fakeOsc(voice.oscillator);
}

describe("OscillatorPool constructor", () => {
  it("defaults to 32 voices (PLAN Task 3.1)", () => {
    const { ctx } = createFakeAudio();
    expect(new OscillatorPool(ctx).size).toBe(DEFAULT_POOL_SIZE);
  });

  it("rejects invalid sizes loudly", () => {
    const { ctx } = createFakeAudio();
    expect(() => new OscillatorPool(ctx, 0)).toThrow(RangeError);
    expect(() => new OscillatorPool(ctx, -3)).toThrow(RangeError);
    expect(() => new OscillatorPool(ctx, 2.5)).toThrow(RangeError);
    expect(() => new OscillatorPool(ctx, Number.NaN)).toThrow(RangeError);
  });
});

describe("acquire / release", () => {
  it("serves up to `size` concurrent voices, then returns null (fail-open)", () => {
    const { ctx } = createFakeAudio();
    const pool = new OscillatorPool(ctx, 4);

    const voices: Voice[] = [];
    for (let i = 0; i < 4; i++) {
      const voice = pool.acquire("sine");
      expect(voice).not.toBeNull();
      voices.push(voice!);
    }
    expect(pool.inUseCount).toBe(4);
    expect(pool.available).toBe(0);
    expect(pool.acquire("sine")).toBeNull(); // exhausted

    pool.release(voices[0]!);
    expect(pool.available).toBe(1);
    expect(pool.acquire("sine")).not.toBeNull();
  });

  it("reuses pooled voices without creating new nodes (GC-pressure guard)", () => {
    const { fake, ctx } = createFakeAudio();
    const pool = new OscillatorPool(ctx, 8);

    const first = pool.acquire("sine")!;
    pool.release(first);

    const before = fake.nodes.length;
    const second = pool.acquire("sine")!;
    expect(fake.nodes.length).toBe(before); // no new oscillator/gain created
    expect(second.id).toBe(first.id);
  });

  it("swaps in a fresh oscillator on release (single-shot OscillatorNodes)", () => {
    const { ctx } = createFakeAudio();
    const pool = new OscillatorPool(ctx, 2);

    const voice = pool.acquire("sine")!;
    const originalOsc = voice.oscillator;
    pool.release(voice);

    expect(voice.oscillator).not.toBe(originalOsc);
    expect(fakeNode(originalOsc).disconnected).toBe(true);
    expect(voiceOsc(voice).frequency.value).toBe(440); // fresh, unconfigured
  });

  it("release is idempotent (double release is a no-op)", () => {
    const { ctx } = createFakeAudio();
    const pool = new OscillatorPool(ctx, 2);

    const voice = pool.acquire("sine")!;
    pool.release(voice);
    pool.release(voice);

    expect(pool.available).toBe(2);
    expect(pool.inUseCount).toBe(0);
  });

  it("rejects unknown waveforms loudly", () => {
    const { ctx } = createFakeAudio();
    const pool = new OscillatorPool(ctx, 2);
    expect(() => pool.acquire("sawtooth" as PooledWaveform)).toThrow(RangeError);
  });
});

describe("FM voices (PRD §5.2 FM Modulator timbre)", () => {
  it("builds carrier + modulator + modGain routed into the carrier frequency", () => {
    const { ctx } = createFakeAudio();
    const pool = new OscillatorPool(ctx, 4);

    const voice = pool.acquire("fm")!;
    expect(voice.waveform).toBe("fm");
    expect(voice.modulator).toBeDefined();
    expect(voice.modGain).toBeDefined();
    expect(voiceOsc(voice).type).toBe("sine"); // carrier
    expect(fakeOsc(voice.modulator!).type).toBe("sine");

    const modGain = fakeGain(voice.modGain!);
    expect(modGain.connections).toContain(voice.oscillator.frequency);
    expect(fakeOsc(voice.modulator!).connections).toContain(modGain);
  });

  it("refreshes the FM chain on release", () => {
    const { ctx } = createFakeAudio();
    const pool = new OscillatorPool(ctx, 4);

    const voice = pool.acquire("fm")!;
    const oldModulator = voice.modulator;
    pool.release(voice);

    expect(voice.modulator).toBeDefined();
    expect(voice.modulator).not.toBe(oldModulator);
  });
});

describe("dispose", () => {
  it("stops and disconnects every voice, freeing all capacity", () => {
    const { ctx } = createFakeAudio();
    const pool = new OscillatorPool(ctx, 3);
    const voices = [pool.acquire("sine")!, pool.acquire("triangle")!, pool.acquire("fm")!];
    const nodes = voices.flatMap((v) => [v.oscillator, v.gain, v.modulator ?? null]);

    pool.dispose();

    expect(pool.inUseCount).toBe(0);
    expect(pool.available).toBe(3); // no voices held anymore
    for (const node of nodes) {
      if (node) expect(fakeNode(node).disconnected).toBe(true);
    }
  });
});

/** Acquisition latency smoke check (PLAN: < 1ms — measured, not asserted hard). */
describe("acquisition performance", () => {
  it("acquires from a warm pool well inside the 1ms budget", () => {
    const { ctx } = createFakeAudio();
    const pool = new OscillatorPool(ctx, 32);
    const warm = pool.acquire("sine")!;
    pool.release(warm);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const v = pool.acquire("sine");
      if (v) pool.release(v);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50); // 1000 acquires in < 50ms ⇒ ≪ 1ms each
  });
});