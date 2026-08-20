/**
 * ADSR envelope scheduling (PRD §4.3 / PLAN Task 3.2).
 *
 * Contract: schedules a click-free gain envelope on a GainNode's AudioParam.
 * Attack 2ms, Decay 40ms, Sustain 0, Release 10ms (PRD §4.3 / PLAN Task 3.2).
 * The attack ramps from exactly 0 (no initial click); release ramps to exactly
 * 0 so the caller can stop its oscillator at the returned time with zero
 * discontinuity.
 *
 * All values are seconds; times are clamped to >= 0 and peak to >= 0.
 *
 * Complexity: O(1) per call — a fixed set of AudioParam automation events is
 * scheduled regardless of envelope shape, so per-event scheduling cost is
 * constant on the synthesizer hot path.
 */

export interface EnvelopeParams {
  /** Seconds from 0 to peak (default 0.002). */
  attack: number;
  /** Seconds from peak to sustain level (default 0.04). */
  decay: number;
  /** Linear sustain level, 0..1 (default 0 → percussive pluck). */
  sustain: number;
  /** Seconds from sustain to 0 (default 0.01). */
  release: number;
  /** Peak gain (default 0.5). */
  peak: number;
}

export const DEFAULT_ENVELOPE: EnvelopeParams = {
  attack: 0.002,
  decay: 0.04,
  sustain: 0,
  release: 0.01,
  peak: 0.5,
};

/** Clamps invalid user-provided params to the safe defaults/domain. */
export function normalizeEnvelope(params: Partial<EnvelopeParams>): EnvelopeParams {
  const merge = { ...DEFAULT_ENVELOPE, ...params };
  const nonNegative = (value: number, fallback: number): number =>
    Number.isFinite(value) ? Math.max(0, value) : fallback;
  return {
    attack: nonNegative(merge.attack, DEFAULT_ENVELOPE.attack),
    decay: nonNegative(merge.decay, DEFAULT_ENVELOPE.decay),
    sustain: nonNegative(merge.sustain, DEFAULT_ENVELOPE.sustain),
    release: nonNegative(merge.release, DEFAULT_ENVELOPE.release),
    peak: nonNegative(merge.peak, DEFAULT_ENVELOPE.peak),
  };
}

/**
 * Schedules the attack/decay segment and returns the scheduling start time
 * (useful for the caller to start its oscillator at the same instant).
 */
export function scheduleAttackEnvelope(
  gain: GainNode,
  context: AudioContext,
  params: Partial<EnvelopeParams> = {},
): number {
  const p = normalizeEnvelope(params);
  const t0 = context.currentTime;
  const param = gain.gain;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(p.peak, t0 + p.attack);
  param.linearRampToValueAtTime(p.peak * p.sustain, t0 + p.attack + p.decay);
  return t0;
}

/**
 * Schedules the release segment (ramp to 0) and returns the exact time at
 * which the gain reaches zero — the caller should stop its oscillator at or
 * after this instant to guarantee a click-free cutoff.
 */
export function scheduleReleaseEnvelope(
  gain: GainNode,
  context: AudioContext,
  params: Partial<EnvelopeParams> = {},
): number {
  const p = normalizeEnvelope(params);
  const t0 = context.currentTime;
  const param = gain.gain;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(param.value, t0);
  param.linearRampToValueAtTime(0, t0 + p.release);
  return t0 + p.release;
}

/**
 * Total duration of one full pluck (attack + decay + release) — used to size
 * transient buffers and oscillator stop times.
 */
export function envelopeDuration(params: Partial<EnvelopeParams> = {}): number {
  const p = normalizeEnvelope(params);
  return p.attack + p.decay + p.release;
}