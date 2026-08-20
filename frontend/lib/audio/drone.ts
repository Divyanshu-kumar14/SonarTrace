/**
 * Sub-bass stall drone (PRD §4.3 / §5.2, PLAN Task 3.3).
 *
 * Contract:
 * - Continuous 46 Hz sine. Gain = min(0.8, lag_ms / 200) — the longer the
 *   event-loop lag, the louder the drone.
 * - All gain moves fade linearly over 100 ms so the drone starts, swells, and
 *   stops without clicks (PLAN Task 3.3 acceptance).
 */

export interface DroneParams {
  /** Drone frequency in Hz (PRD: 46). */
  frequency: number;
  /** Ceiling on drone gain (PRD: 0.8). */
  maxGain: number;
  /** lag_ms divisor in the gain formula (PRD: 200). */
  lagDivisor: number;
  /** Fade time in seconds (PLAN: 100 ms). */
  fadeSeconds: number;
}

export const DEFAULT_DRONE_PARAMS: DroneParams = {
  frequency: 46,
  maxGain: 0.8,
  lagDivisor: 200,
  fadeSeconds: 0.1,
};

/** Pure gain mapping: min(0.8, lag_ms / 200); non-finite/negative → 0. */
export function droneGainForLag(lagMs: number, params: DroneParams = DEFAULT_DRONE_PARAMS): number {
  if (!Number.isFinite(lagMs) || lagMs <= 0) return 0;
  return Math.min(params.maxGain, lagMs / params.lagDivisor);
}

export class Drone {
  readonly params: DroneParams;
  private readonly osc: OscillatorNode;
  private readonly gain: GainNode;
  private currentTarget = 0;

  constructor(
    private readonly ctx: AudioContext,
    output: AudioNode,
    params: Partial<DroneParams> = {},
  ) {
    this.params = { ...DEFAULT_DRONE_PARAMS, ...params };
    this.osc = ctx.createOscillator();
    this.osc.type = "sine";
    this.osc.frequency.value = this.params.frequency;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.osc.connect(this.gain);
    this.gain.connect(output);
    this.osc.start();
  }

  /**
   * Targets the drone gain implied by the reported event-loop lag.
   * O(1): one cancel + one anchor + one linear ramp per changed target.
   */
  setLag(lagMs: number): void {
    const target = droneGainForLag(lagMs, this.params);
    if (target === this.currentTarget) return;
    const now = this.ctx.currentTime;
    const param = this.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + this.params.fadeSeconds);
    this.currentTarget = target;
  }

  /** The gain level the drone is currently moving toward. */
  get targetGain(): number {
    return this.currentTarget;
  }

  /** Fades the drone out over the fade window and releases the nodes. */
  dispose(): void {
    const now = this.ctx.currentTime;
    const param = this.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(0, now + this.params.fadeSeconds);
    try {
      this.osc.stop(now + this.params.fadeSeconds + 0.01);
    } catch {
      // Already stopped — fine.
    }
    this.osc.disconnect();
    this.gain.disconnect();
  }
}