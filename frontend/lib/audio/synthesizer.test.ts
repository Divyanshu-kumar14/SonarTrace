import { describe, expect, it } from "vitest";
import type { TelemetryFrame } from "../telemetry";
import { createFakeAudio, fakeNode, fakeOsc, fakePanner, type FakeAudioContext } from "../../tests/helpers/webaudio-fake";
import { depthToFrequency } from "./frequency-map";
import { panForTask, waveformForTask } from "./panner";
import { Synthesizer } from "./synthesizer";

function frame(overrides: Partial<TelemetryFrame> & { type: TelemetryFrame["type"] }): TelemetryFrame {
  return {
    id: 1,
    timestamp_ms: 0,
    fn_name: "fn",
    module: "mod",
    depth: 6,
    task_id: "task-0",
    ...overrides,
  };
}

/** Nodes created after `before` — isolates one event's audio. */
function newNodes(fake: FakeAudioContext, before: number) {
  return fake.nodes.slice(before);
}

describe("Synthesizer master chain", () => {
  it("connects voices through LPF and compressor to the destination", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);

    const masterInput = fake.byKind("gain")[0] as unknown as GainNode;
    const filter = fake.byKind("biquadFilter")[0] as unknown as BiquadFilterNode;
    const compressor = fake.byKind("compressor")[0] as unknown as DynamicsCompressorNode;

    expect(fakeNode(masterInput).connections).toContain(filter);
    expect(fakeNode(filter).connections).toContain(compressor);
    expect(fakeNode(compressor).connections).toContain(fake.destination);

    synth.dispose();
  });
});

describe("playEvent — CALL pluck (PRD §5.2)", () => {
  it("sounds a pentatonic pluck at the frame depth, panned by task", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);
    const before = fake.nodes.length;

    synth.playEvent(frame({ type: "CALL", depth: 6, task_id: "task-1" }));

    const nodes = newNodes(fake, before);
    const osc = nodes.find((n) => n.kind === "oscillator");
    const panner = nodes.find((n) => n.kind === "stereoPanner");

    expect(fakeOsc(osc as unknown as OscillatorNode).frequency.value).toBe(depthToFrequency(6));
    expect(fakeOsc(osc as unknown as OscillatorNode).startedAt).toBe(0);
    expect(fakeOsc(osc as unknown as OscillatorNode).stoppedAt).toBeCloseTo(0.06, 5);
    expect(fakePanner(panner as unknown as StereoPannerNode).pan.value).toBe(panForTask("task-1"));

    synth.dispose();
  });

  it("spreads concurrent tasks across distinct stereo positions", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);

    const pans = new Set<number>();
    for (const task of ["task-0", "task-1", "task-2"]) {
      synth.playEvent(frame({ type: "CALL", task_id: task }));
    }
    for (const panner of fake.byKind("stereoPanner")) {
      pans.add(fakePanner(panner as unknown as StereoPannerNode).pan.value);
    }
    expect(pans.size).toBeGreaterThanOrEqual(3);

    synth.dispose();
  });

  it("assigns the task's waveform (sine/triangle/fm) to the voice", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);

    for (const task of ["task-0", "task-1", "task-2", "task-3", "task-4"]) {
      const waveform = waveformForTask(task);
      const before = fake.nodes.length;
      synth.playEvent(frame({ type: "CALL", task_id: task }));
      const osc = newNodes(fake, before).find((n) => n.kind === "oscillator");
      expect(fakeOsc(osc as unknown as OscillatorNode).type).toBe(waveform === "fm" ? "sine" : waveform);
    }

    synth.dispose();
  });

  it("starts the FM modulator when the task timbre is FM", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);

    const fmTask = ["task-0", "task-1", "task-2", "task-3", "task-4", "task-5", "task-6", "task-7", "task-8"].find(
      (t) => waveformForTask(t) === "fm",
    );
    expect(fmTask).toBeDefined();

    const before = fake.nodes.length;
    synth.playEvent(frame({ type: "CALL", task_id: fmTask! }));
    const oscillators = newNodes(fake, before).filter((n) => n.kind === "oscillator");
    // Carrier + modulator for FM voices.
    expect(oscillators.length).toBeGreaterThanOrEqual(2);
    for (const osc of oscillators) {
      expect(fakeOsc(osc as unknown as OscillatorNode).startedAt).toBe(0);
    }

    synth.dispose();
  });

  it("releases the voice back to the pool when the note ends", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);
    const before = fake.nodes.length;

    synth.playEvent(frame({ type: "CALL", task_id: "task-0" }));
    expect(synth.activeVoices).toBe(1);

    const osc = newNodes(fake, before).find((n) => n.kind === "oscillator");
    fakeOsc(osc as unknown as OscillatorNode).triggerEnded();

    expect(synth.activeVoices).toBe(0);
    // The used oscillator is single-shot: release swaps in a fresh node and
    // disconnects the old one, so the voice can be acquired again.
    expect((osc as unknown as { disconnected: boolean }).disconnected).toBe(true);

    synth.dispose();
  });
});

describe("playEvent — special event types", () => {
  it("LOOP_BURST plays a harmonic texture at the drifted frequency", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);
    const before = fake.nodes.length;

    synth.playEvent(frame({ type: "LOOP_BURST", depth: 6, loop_iterations: 100 }));

    const oscs = newNodes(fake, before).filter((n) => n.kind === "oscillator");
    const base = depthToFrequency(6) + Math.log10(100) * 30;
    const freqs = oscs.map((o) => fakeOsc(o as unknown as OscillatorNode).frequency.value).sort((a, b) => a - b);
    expect(freqs).toEqual([base, base * 2, base * 3]);

    synth.dispose();
  });

  it("STALL drives the sub-bass drone gain from stall duration", () => {
    const { ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);

    synth.playEvent(frame({ type: "STALL", stall_duration_ms: 100 }));
    expect(synth.stallGain).toBeCloseTo(0.5, 9);

    synth.dispose();
  });

  it("EXCEPTION triggers the noise burst + tritone transient", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);
    const before = fake.nodes.length;

    synth.playEvent(frame({ type: "EXCEPTION", error_type: "RecursionError" }));

    const nodes = newNodes(fake, before);
    expect(nodes.some((n) => n.kind === "bufferSource")).toBe(true);
    expect(nodes.filter((n) => n.kind === "biquadFilter").length).toBe(1);
    expect(nodes.filter((n) => n.kind === "oscillator").length).toBe(2);

    synth.dispose();
  });

  it("RETURN is silent (no audio nodes created)", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);
    const before = fake.nodes.length;

    synth.playEvent(frame({ type: "RETURN" }));
    expect(fake.nodes.length).toBe(before);

    synth.dispose();
  });
});

describe("fail-open behavior (PLAN Task 3.1)", () => {
  it("drops events when the pool is exhausted instead of throwing", () => {
    const { ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx, { poolSize: 2 });

    synth.playEvent(frame({ type: "CALL", task_id: "task-0" }));
    synth.playEvent(frame({ type: "CALL", task_id: "task-1" }));
    synth.playEvent(frame({ type: "CALL", task_id: "task-2" })); // pool full → dropped

    expect(synth.activeVoices).toBe(2);
    expect(synth.droppedEventCount).toBe(1);

    synth.dispose();
  });

  it("recovers after a voice is released", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx, { poolSize: 1 });
    const before = fake.nodes.length;

    synth.playEvent(frame({ type: "CALL", task_id: "task-0" }));
    fakeOsc(newNodes(fake, before).find((n) => n.kind === "oscillator") as unknown as OscillatorNode).triggerEnded();

    synth.playEvent(frame({ type: "CALL", task_id: "task-0" }));
    expect(synth.droppedEventCount).toBe(0);
    expect(synth.activeVoices).toBe(1);

    synth.dispose();
  });
});

describe("setStall", () => {
  it("maps lag to the PRD drone gain formula", () => {
    const { ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);

    synth.setStall(0);
    expect(synth.stallGain).toBe(0);
    synth.setStall(200);
    expect(synth.stallGain).toBe(0.8);
    synth.setStall(1000);
    expect(synth.stallGain).toBe(0.8); // capped

    synth.dispose();
  });
});

describe("malformed frames", () => {
  it("degrades non-finite depth to the scale root (no NaN in the graph)", () => {
    const { fake, ctx } = createFakeAudio();
    const synth = new Synthesizer(ctx);
    const before = fake.nodes.length;

    synth.playEvent(frame({ type: "CALL", depth: Number.NaN, task_id: "task-0" }));

    const osc = newNodes(fake, before).find((n) => n.kind === "oscillator");
    const freq = fakeOsc(osc as unknown as OscillatorNode).frequency.value;
    expect(Number.isFinite(freq)).toBe(true);
    expect(freq).toBe(depthToFrequency(Number.NaN));

    synth.dispose();
  });
});