/**
 * Pentatonic frequency mapper (PRD §5.2 / PLAN Task 3.2).
 *
 * Contract: depth 1..20 maps to the C Major Pentatonic scale from C3
 * (130.81 Hz) to A6 (1760.00 Hz) — the exact PRD §5.2 table. Depths 21..32
 * (the sonified range per PLAN Task 3.2) continue the pentatonic ladder
 * upward (C7 → D9) so pitch is strictly monotonic with stack depth: a deeper
 * stack always sounds higher, which is the core psychoacoustic cue for
 * runaway recursion (PRD §8). Depths beyond 32 clamp at D9.
 */

/** C Major Pentatonic ladder: PRD C3→A6 (20 degrees) + 12 extended degrees. */
export const PENTATONIC_FREQUENCIES: readonly number[] = [
  130.81, 146.83, 164.81, 196.0, 220.0, // C3 D3 E3 G3 A3
  261.63, 293.66, 329.63, 392.0, 440.0, // C4 D4 E4 G4 A4
  523.25, 587.33, 659.25, 783.99, 880.0, // C5 D5 E5 G5 A5
  1046.5, 1174.66, 1318.51, 1567.98, 1760.0, // C6 D6 E6 G6 A6 (PRD range)
  2093.0, 2349.32, 2637.02, 3135.96, 3520.0, // C7 D7 E7 G7 A7
  4186.0, 4698.64, 5274.04, 6271.92, 7040.0, // C8 D8 E8 G8 A8
  8372.0, 9397.28, // C9 D9
] as const;

export const PENTATONIC_DEGREES = PENTATONIC_FREQUENCIES.length; // 32
export const MAX_SONIFIED_DEPTH = 32;
export const BASE_DEPTH_FREQUENCY = PENTATONIC_FREQUENCIES[0];

/**
 * Maps a call-stack depth to a pentatonic frequency in Hz.
 * O(1): a single clamped array index into the precomputed ladder — no math on
 * the event hot path. Non-finite or sub-1 depths degrade to the scale root
 * (C3) so a malformed frame can never push an invalid frequency into the
 * audio graph.
 */
export function depthToFrequency(depth: number): number {
  if (!Number.isFinite(depth)) return BASE_DEPTH_FREQUENCY;
  const degree = Math.max(1, Math.floor(depth));
  const index = Math.min(degree - 1, PENTATONIC_FREQUENCIES.length - 1);
  return PENTATONIC_FREQUENCIES[index];
}