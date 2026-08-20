/**
 * Oscillator voice pool (PLAN Task 3.1).
 *
 * Contract:
 * - Recycles OscillatorNode + GainNode pairs to avoid GC pressure on the hot
 *   event path (every CALL/EXCEPTION/LOOP_BURST acquires a voice).
 * - Pool size is configurable (default 32 voices) and bounds memory.
 * - `acquire()` returns null when exhausted — the synthesizer drops the event
 *   fail-open rather than allocating unbounded nodes.
 * - WebAudio OscillatorNodes are single-shot (a stopped node cannot restart),
 *   so `release()` swaps in a fresh oscillator while reusing the GainNode —
 *   the allocation-heavy part of the graph stays pooled.
 * - FM voices (PRD §5.2 "FM Modulator" timbre) carry an optional modulator
 *   oscillator routed into the carrier's frequency AudioParam.
 */

export type PooledWaveform = "sine" | "triangle" | "fm";

export const POOL_WAVEFORMS: readonly PooledWaveform[] = ["sine", "triangle", "fm"] as const;

// O(1) membership lookup: waveform validation runs on the acquire hot path
// (every CALL/EXCEPTION/LOOP_BURST event), so a Set replaces the array scan.
const POOL_WAVEFORM_SET: ReadonlySet<string> = new Set(POOL_WAVEFORMS);

function isPooledWaveform(value: string): value is PooledWaveform {
  return POOL_WAVEFORM_SET.has(value);
}

export const DEFAULT_POOL_SIZE = 32;

export interface Voice {
  readonly id: number;
  readonly waveform: PooledWaveform;
  /** Single-shot carrier; replaced with a fresh node on release. */
  oscillator: OscillatorNode;
  readonly gain: GainNode;
  /** Present only when waveform === "fm"; swapped fresh on release. */
  modulator?: OscillatorNode;
  modGain?: GainNode;
}

export class OscillatorPool {
  readonly size: number;
  private readonly ctx: AudioContext;
  private readonly free: Map<PooledWaveform, Voice[]>;
  private readonly inUse: Set<Voice>;
  private nextVoiceId = 0;

  constructor(ctx: AudioContext, size: number = DEFAULT_POOL_SIZE) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`OscillatorPool size must be a positive integer, got ${size}`);
    }
    this.ctx = ctx;
    this.size = size;
    this.free = new Map<PooledWaveform, Voice[]>();
    for (const waveform of POOL_WAVEFORMS) this.free.set(waveform, []);
    this.inUse = new Set();
  }

  get available(): number {
    return this.size - this.inUse.size;
  }

  get inUseCount(): number {
    return this.inUse.size;
  }

  /** Returns a ready voice, or null when the pool is exhausted. O(1). */
  acquire(waveform: PooledWaveform): Voice | null {
    if (this.inUse.size >= this.size) return null;
    const stack = this.free.get(waveform);
    if (!stack) throw new RangeError(`Unknown waveform: ${String(waveform)}`);
    const voice = stack.pop() ?? this.createVoice(waveform); // O(1): array pop / lazy create
    this.inUse.add(voice); // O(1): Set add
    return voice;
  }

  /**
   * Returns a voice to the pool. Idempotent: double-release is a no-op.
   * O(1): Set delete + stack push.
   */
  release(voice: Voice): void {
    if (!this.inUse.delete(voice)) return;
    this.free.get(voice.waveform)?.push(this.refresh(voice));
  }

  /** Stops and disconnects every voice; the pool cannot be reused after. */
  dispose(): void {
    for (const voice of this.inUse) this.disconnectAll(voice);
    for (const stack of this.free.values()) for (const voice of stack) this.disconnectAll(voice);
    this.inUse.clear();
    this.free.clear();
  }

  private createVoice(waveform: PooledWaveform): Voice {
    const gain = this.ctx.createGain();
    const oscillator = this.ctx.createOscillator();
    oscillator.type = waveform === "fm" ? "sine" : waveform;
    oscillator.connect(gain);

    let modulator: OscillatorNode | undefined;
    let modGain: GainNode | undefined;
    if (waveform === "fm") {
      modulator = this.ctx.createOscillator();
      modulator.type = "sine";
      modGain = this.ctx.createGain();
      modulator.connect(modGain);
      modGain.connect(oscillator.frequency);
    }

    return { id: this.nextVoiceId++, waveform, oscillator, gain, modulator, modGain };
  }

  /** Replaces the single-shot oscillator (and FM chain) with fresh nodes. */
  private refresh(voice: Voice): Voice {
    voice.oscillator.disconnect();
    voice.oscillator = this.ctx.createOscillator();
    voice.oscillator.type = voice.waveform === "fm" ? "sine" : voice.waveform;
    voice.oscillator.connect(voice.gain);

    if (voice.waveform === "fm") {
      voice.modulator?.disconnect();
      voice.modGain?.disconnect();
      voice.modulator = this.ctx.createOscillator();
      voice.modulator.type = "sine";
      voice.modGain = this.ctx.createGain();
      voice.modulator.connect(voice.modGain);
      voice.modGain.connect(voice.oscillator.frequency);
    }
    return voice;
  }

  private disconnectAll(voice: Voice): void {
    try {
      voice.oscillator.stop();
    } catch {
      // Already stopped — fine.
    }
    voice.oscillator.disconnect();
    voice.gain.disconnect();
    voice.modulator?.disconnect();
    voice.modGain?.disconnect();
  }
}

/** Small named export for callers that want a standalone factory. */
export function createVoice(waveform: PooledWaveform, ctx: AudioContext): Voice {
  if (!isPooledWaveform(waveform)) {
    throw new RangeError(`Unknown waveform: ${String(waveform)}`);
  }
  const gain = ctx.createGain();
  const oscillator = ctx.createOscillator();
  oscillator.type = waveform === "fm" ? "sine" : waveform;
  oscillator.connect(gain);
  return { id: 0, waveform, oscillator, gain };
}