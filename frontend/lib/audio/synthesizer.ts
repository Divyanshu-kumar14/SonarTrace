/**
 * SonarTrace synthesizer — main audio entry point (PRD §4.3 / PLAN Task 3.5).
 *
 * Contract:
 * - `playEvent(frame)` maps one telemetry frame to sound per PRD §5.2:
 *   CALL/AWAIT/RESUME → pentatonic pluck at call depth, panned by task,
 *   timbre by task; LOOP_BURST → drifted harmonic texture; STALL → sub-bass
 *   drone gain; EXCEPTION → noise burst + tritone; RETURN → silent.
 * - `setStall(lag_ms)` drives the 46 Hz drone gain.
 * - Fail-open: when the voice pool is exhausted, events are dropped (counted,
 *   never throwing) so audio can never crash the HUD or the traced process.
 *
 * Voice pipeline (PRD §4.3): Voice Oscillator → Envelope Gain → Stereo Panner
 * → Master summing bus → LPF (12 kHz) → Compressor (−6 dB, 4:1) → Destination.
 */

import type { TelemetryFrame } from "../telemetry";
import { getAudioContext } from "./context";
import { Drone } from "./drone";
import { DEFAULT_ENVELOPE, envelopeDuration, scheduleAttackEnvelope } from "./envelope";
import { playException } from "./exception";
import { depthToFrequency } from "./frequency-map";
import { playLoopBurst } from "./loop-burst";
import { MasterBus } from "./master-bus";
import { OscillatorPool, DEFAULT_POOL_SIZE, type PooledWaveform } from "./oscillator-pool";
import { panForTask, waveformForTask } from "./panner";

/** FM modulator sits at 4× the carrier frequency. */
const FM_RATIO = 4;
/** FM index: deviation = FM_INDEX × modulator frequency. */
const FM_INDEX = 0.5;

export interface SynthesizerOptions {
  /** Voice pool capacity (default 32, PRD §4.3). */
  poolSize?: number;
  /** Pre-built master bus (test seam). */
  master?: MasterBus;
  /** Pre-built drone (test seam). */
  drone?: Drone;
  /** Pluck length in seconds (default: envelope duration + 8 ms tail). */
  voiceDuration?: number;
}

export class Synthesizer {
  readonly ctx: AudioContext;
  readonly master: MasterBus;
  private readonly pool: OscillatorPool;
  private readonly drone: Drone;
  private readonly voiceDuration: number;
  private droppedEvents = 0;

  constructor(ctx: AudioContext = getAudioContext(), options: SynthesizerOptions = {}) {
    this.ctx = ctx;
    this.master = options.master ?? new MasterBus(ctx);
    this.pool = new OscillatorPool(ctx, options.poolSize ?? DEFAULT_POOL_SIZE);
    this.drone = options.drone ?? new Drone(ctx, this.master.input);
    this.voiceDuration = options.voiceDuration ?? envelopeDuration(DEFAULT_ENVELOPE) + 0.008;
  }

  /** Maps one telemetry frame to sound (PRD §5.2). */
  playEvent(frame: TelemetryFrame): void {
    switch (frame.type) {
      case "CALL":
      case "AWAIT":
      case "RESUME":
        this.playPluck(frame);
        break;
      case "RETURN":
        // Returns release stack space; sounding them would add cacophony.
        break;
      case "LOOP_BURST":
        playLoopBurst(
          this.ctx,
          this.master.input,
          depthToFrequency(frame.depth),
          frame.loop_iterations ?? 1,
        );
        break;
      case "STALL":
        this.setStall(frame.stall_duration_ms ?? 0);
        break;
      case "EXCEPTION":
        playException(this.ctx, this.master.input);
        break;
    }
  }

  /** Sets the sub-bass drone gain from the reported event-loop lag. */
  setStall(lagMs: number): void {
    this.drone.setLag(lagMs);
  }

  /** Current drone gain target (0..0.8) — exposed for the HUD. */
  get stallGain(): number {
    return this.drone.targetGain;
  }

  /** Voices currently sounding. */
  get activeVoices(): number {
    return this.pool.inUseCount;
  }

  /** Events dropped because the pool was exhausted (fail-open counter). */
  get droppedEventCount(): number {
    return this.droppedEvents;
  }

  /** Stops everything and releases all audio nodes. */
  dispose(): void {
    this.drone.dispose();
    this.pool.dispose();
    this.master.dispose();
  }

  private playPluck(frame: TelemetryFrame): void {
    // O(1) amortized hot path: waveform + pan come from the memoized hash
    // (panner.ts), pitch is a clamped table index (frequency-map.ts), and the
    // voice comes from the pool with no allocation while capacity remains.
    const waveform: PooledWaveform = waveformForTask(frame.task_id);
    const voice = this.pool.acquire(waveform);
    if (!voice) {
      this.droppedEvents += 1;
      return; // fail-open: no pool capacity, drop the event
    }

    const t0 = this.ctx.currentTime;
    const freq = depthToFrequency(frame.depth);

    voice.oscillator.frequency.setValueAtTime(freq, t0);
    if (waveform === "fm" && voice.modulator && voice.modGain) {
      const modFreq = freq * FM_RATIO;
      voice.modulator.frequency.setValueAtTime(modFreq, t0);
      voice.modGain.gain.setValueAtTime(FM_INDEX * modFreq, t0);
    }

    // Per-voice stereo placement (PRD §4.3): Voice → Envelope → Panner.
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = panForTask(frame.task_id);
    voice.gain.connect(panner);
    panner.connect(this.master.input);

    const startAt = scheduleAttackEnvelope(voice.gain, this.ctx);
    voice.oscillator.start(startAt);
    voice.modulator?.start(startAt);

    const stopAt = startAt + this.voiceDuration;
    voice.oscillator.stop(stopAt);
    voice.modulator?.stop(stopAt);

    // Return the voice to the pool the moment its note finishes.
    voice.oscillator.onended = () => {
      panner.disconnect();
      this.pool.release(voice);
    };
  }
}