import { describe, expect, it } from "vitest";
import { createFakeAudio, fakeCompressor, fakeFilter, fakeNode } from "../../tests/helpers/webaudio-fake";
import { MASTER_COMPRESSOR_RATIO, MASTER_COMPRESSOR_THRESHOLD_DB, MASTER_LPF_FREQUENCY, MasterBus } from "./master-bus";

describe("MasterBus (PRD §4.3)", () => {
  it("builds summing → LPF(12kHz) → compressor(-6dB, 4:1) → destination", () => {
    const { fake, ctx } = createFakeAudio();
    new MasterBus(ctx);

    const input = fake.byKind("gain")[0] as unknown as GainNode;
    const filter = fake.byKind("biquadFilter")[0] as unknown as BiquadFilterNode;
    const compressor = fake.byKind("compressor")[0] as unknown as DynamicsCompressorNode;

    expect(fakeFilter(filter).type).toBe("lowpass");
    expect(fakeFilter(filter).frequency.value).toBe(MASTER_LPF_FREQUENCY);
    expect(fakeCompressor(compressor).threshold.value).toBe(MASTER_COMPRESSOR_THRESHOLD_DB);
    expect(fakeCompressor(compressor).ratio.value).toBe(MASTER_COMPRESSOR_RATIO);

    expect(fakeNode(input).connections).toContain(filter);
    expect(fakeNode(filter).connections).toContain(compressor);
    expect(fakeNode(compressor).connections).toContain(fake.destination);
  });

  it("exposes the summing bus as the voice input", () => {
    const { ctx } = createFakeAudio();
    const master = new MasterBus(ctx);
    expect(master.input).toBeDefined();
    expect(fakeNode(master.input).connections).toContain(master.filter);
  });

  it("dispose tears down every link", () => {
    const { ctx } = createFakeAudio();
    const master = new MasterBus(ctx);
    master.dispose();

    expect(fakeNode(master.input).disconnected).toBe(true);
    expect(fakeNode(master.filter).disconnected).toBe(true);
    expect(fakeNode(master.compressor).disconnected).toBe(true);
  });
});