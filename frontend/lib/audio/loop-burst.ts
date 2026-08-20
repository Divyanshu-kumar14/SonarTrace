/**
 * Loop-burst synthesis (PRD §5.2 / PLAN Task 3.4).
 *
 * Contract: when the backend throttles a hot loop into a LOOP_BURST event,
 * the synthesizer plays a layered harmonic texture whose pitch drifts with
 * the iteration count: f_burst = f_base + log10(iterations) * 30 Hz.
 * The slow-ish attack and stacked partials make it read as a texture change,
 * not a stream of individual clicks (PLAN Task 3.4 acceptance).
 */

export const LOOP_BURST_DRIFT_HZ = 30;

export interface LoopBurstParams {
  /** Ramp-in in seconds (texture, not click). */
  attack: number;
  /** Total transient length in seconds. */
  duration: number;
  /** Peak gain of the fundamental partial. */
  peak: number;
  /** Harmonic partial multipliers stacked into the texture. */
  partials: readonly number[];
}

export const DEFAULT_LOOP_BURST_PARAMS: LoopBurstParams = {
  attack: 0.015,
  duration: 0.25,
  peak: 0.22,
  partials: [1, 2, 3],
};

/**
 * PRD §5.2 drift formula. Iterations below 1 (or non-finite) yield no drift.
 * O(1): one log10 per event. The log is deliberately NOT memoized — LOOP_BURST
 * events are already throttled by the backend (max ~20/50ms per task), so a
 * Map lookup would cost more than the log itself on this cold-ish path.
 */
export function loopBurstFrequency(baseFreq: number, iterations: number): number {
  if (!Number.isFinite(iterations) || iterations < 1) return baseFreq;
  return baseFreq + Math.log10(iterations) * LOOP_BURST_DRIFT_HZ;
}

/** Plays a harmonic chord at the drifted loop-burst frequency. */
export function playLoopBurst(
  ctx: AudioContext,
  output: AudioNode,
  baseFreq: number,
  iterations: number,
  params: Partial<LoopBurstParams> = {},
): void {
  const p = { ...DEFAULT_LOOP_BURST_PARAMS, ...params };
  const t0 = ctx.currentTime;
  const freq = loopBurstFrequency(baseFreq, iterations);

  for (const multiplier of p.partials) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq * multiplier;

    const gain = ctx.createGain();
    const g = gain.gain;
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(p.peak / multiplier, t0 + p.attack);
    g.linearRampToValueAtTime(0, t0 + p.duration);

    osc.connect(gain);
    gain.connect(output);
    osc.start(t0);
    osc.stop(t0 + p.duration + 0.01);
  }
}