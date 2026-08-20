/**
 * Master bus (PRD §4.3 / PLAN Task 3.5).
 *
 * Contract: every voice sums into a GainNode (summing bus), then flows through
 * a Biquad low-pass filter at 12 kHz and a dynamics compressor
 * (threshold −6 dB, ratio 4:1) before reaching the AudioDestinationNode.
 * The compressor is the final anti-clipping guard under 32 concurrent voices.
 *
 * Complexity: O(1) — the chain is built once at construction and every voice
 * sums into the same three nodes; per-voice work is a single connect().
 */

export const MASTER_LPF_FREQUENCY = 12000; // Hz
export const MASTER_COMPRESSOR_THRESHOLD_DB = -6;
export const MASTER_COMPRESSOR_RATIO = 4;

export class MasterBus {
  /** Summing bus — voices connect here. */
  readonly input: GainNode;
  readonly filter: BiquadFilterNode;
  readonly compressor: DynamicsCompressorNode;

  constructor(private readonly ctx: AudioContext) {
    this.input = ctx.createGain();

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = MASTER_LPF_FREQUENCY;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = MASTER_COMPRESSOR_THRESHOLD_DB;
    this.compressor.ratio.value = MASTER_COMPRESSOR_RATIO;

    this.input.connect(this.filter);
    this.filter.connect(this.compressor);
    this.compressor.connect(ctx.destination);
  }

  /** Tears down the whole chain. Safe to call multiple times. */
  dispose(): void {
    this.input.disconnect();
    this.filter.disconnect();
    this.compressor.disconnect();
  }
}