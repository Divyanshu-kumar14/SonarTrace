/**
 * Task → stereo space & timbre mapping (PRD §5.2 / PLAN Task 3.3).
 *
 * Contract:
 * - `panForTask(taskId)` deterministically hashes a task/coroutine ID to a
 *   pan in [-0.85, +0.85] so concurrent tasks are spatially separable.
 * - `waveformForTask(taskId)` deterministically assigns one of the three PRD
 *   timbres (Sine / Triangle / FM) per task.
 * - Same ID always maps to the same position and timbre; different IDs
 *   spread across the range (FNV-1a mixes well for sequential IDs like
 *   "task-0", "task-1", "task-2").
 */

import type { PooledWaveform } from "./oscillator-pool";

export const PAN_RANGE = 0.85;

// Bounded memo cache for FNV-1a hashes. Hot coroutines emit bursts of CALL
// events (the backend throttles >20 calls/50ms per task into LOOP_BURST), so
// the same task_id is hashed repeatedly — twice per event (pan + waveform).
// Caching turns the hot path from O(len(task_id)) per event into O(1)
// amortized. The FIFO cap keeps memory bounded, honoring the same
// "no unbounded growth" rule as the backend aggregator.
const HASH_CACHE_CAPACITY = 256;
const hashCache = new Map<string, number>();

/**
 * FNV-1a 32-bit hash — fast, deterministic, uniform for short strings.
 * Memoized per input string; cache is content-addressed, so the result is
 * identical with or without a cache hit (pure function semantics preserved).
 */
export function hashString(input: string): number {
  const cached = hashCache.get(input);
  if (cached !== undefined) return cached; // O(1) hit
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // keep uint32
  }
  if (hashCache.size >= HASH_CACHE_CAPACITY) {
    // Map preserves insertion order → the first key is the oldest (FIFO).
    const oldest = hashCache.keys().next().value as string;
    hashCache.delete(oldest);
  }
  hashCache.set(input, hash);
  return hash;
}

/** Diagnostics/test seam: current memo cache size (bounded by capacity). */
export function hashCacheSize(): number {
  return hashCache.size;
}

/** Deterministic stereo pan in [-PAN_RANGE, +PAN_RANGE]. */
export function panForTask(taskId: string): number {
  const normalized = hashString(taskId) / 0xffffffff; // [0, 1)
  return normalized * (PAN_RANGE * 2) - PAN_RANGE;
}

const WAVEFORM_ORDER: readonly PooledWaveform[] = ["sine", "triangle", "fm"] as const;

/** Deterministic timbre assignment: Sine, Triangle, or FM modulator. */
export function waveformForTask(taskId: string): PooledWaveform {
  return WAVEFORM_ORDER[hashString(taskId) % WAVEFORM_ORDER.length];
}