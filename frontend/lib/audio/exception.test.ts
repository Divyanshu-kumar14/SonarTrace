import { describe, expect, it } from "vitest";
import {
  createFakeAudio,
  fakeFilter,
  fakeGain,
  fakeOsc,
  fakeParam,
  fakeSource,
  type FakeAudioContext,
  type FakeAudioNode,
} from "../../tests/helpers/webaudio-fake";
import { createWhiteNoiseBuffer, playException } from "./exception";

function noiseChain(fake: FakeAudioContext): {
  source: ReturnType<typeof fakeSource>;
  filter: ReturnType<typeof fakeFilter>;
  gain: ReturnType<typeof fakeGain>;
} {
  const sourceNode = fake.byKind("bufferSource")[0] as FakeAudioNode;
  const filterNode = fake.byKind("biquadFilter")[0] as FakeAudioNode;
  const gainNode = fake.byKind("gain")[0] as FakeAudioNode;
  return {
    source: fakeSource(sourceNode),
    filter: fakeFilter(filterNode),
    gain: fakeGain(gainNode),
  };
}

describe("createWhiteNoiseBuffer", () => {
  it("fills a mono buffer of duration × sampleRate with [-1, 1) samples", () => {
    const { ctx } = createFakeAudio();
    const buffer = createWhiteNoiseBuffer(ctx, 0.12);

    expect(buffer.numberOfChannels).toBe(1);
    expect(buffer.length).toBe(Math.floor(48000 * 0.12));
    expect(buffer.sampleRate).toBe(48000);

    const data = buffer.getChannelData(0);
    expect(data.length).toBe(buffer.length);
    for (const sample of data) {
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThan(1);
    }
    // Not silent, not a constant tone.
    expect(new Set(Array.from(data)).size).toBeGreaterThan(100);
  });

  it("never produces an empty buffer, even for zero duration", () => {
    const { ctx } = createFakeAudio();
    expect(createWhiteNoiseBuffer(ctx, 0).length).toBe(1);
  });
});

describe("playException (PRD: 2–7kHz noise 120ms + C5/F#5 tritone)", () => {
  it("builds the band-passed noise chain (center ≈ 3741.7 Hz, Q 0.75)", () => {
    const { fake, ctx } = createFakeAudio();
    playException(ctx, fake.destination as unknown as AudioNode);

    const { source, filter, gain } = noiseChain(fake);

    expect(filter.type).toBe("bandpass");
    expect(filter.frequency.value).toBeCloseTo(Math.sqrt(2000 * 7000), 5);
    expect(filter.Q.value).toBeCloseTo(0.75, 5);

    expect(source.buffer).not.toBeNull();
    expect(source.buffer!.length).toBe(Math.floor(48000 * 0.12));
    expect(source.startedAt).toBe(0);
    expect(source.stoppedAt).toBeCloseTo(0.13, 5);
    expect(source.connections).toContain(filter);
    expect(filter.connections).toContain(gain);
  });

  it("gates the noise with a short attack and full-length decay to 0", () => {
    const { fake, ctx } = createFakeAudio();
    playException(ctx, fake.destination as unknown as AudioNode);

    const param = fakeParam(noiseChain(fake).gain.gain);
    expect(param.eventsOf("set")).toEqual([{ op: "set", time: 0, value: 0 }]);
    expect(param.eventsOf("ramp").map((e) => [e.value, e.time])).toEqual([
      [0.4, 0.002],
      [0, 0.12],
    ]);
  });

  it("plays the C5 + F#5 tritone on triangle oscillators", () => {
    const { fake, ctx } = createFakeAudio();
    playException(ctx, fake.destination as unknown as AudioNode);

    const oscillators = fake.byKind("oscillator") as unknown as OscillatorNode[];
    const freqs = oscillators.map((o) => fakeOsc(o).frequency.value).sort((a, b) => a - b);
    expect(freqs).toEqual([523.25, 739.99]);

    for (const osc of oscillators) {
      const f = fakeOsc(osc);
      expect(f.type).toBe("triangle");
      expect(f.startedAt).toBe(0);
      expect(f.stoppedAt).toBeCloseTo(0.13, 5);
    }
  });

  it("keeps the tritone at a restrained level", () => {
    const { fake, ctx } = createFakeAudio();
    playException(ctx, fake.destination as unknown as AudioNode);

    const tritoneGains = fake
      .byKind("gain")
      .slice(1) as unknown as GainNode[];
    for (const gain of tritoneGains) {
      const ramps = fakeParam(fakeGain(gain).gain).eventsOf("ramp");
      expect(ramps[0]!.value).toBeLessThanOrEqual(0.15);
    }
  });
});