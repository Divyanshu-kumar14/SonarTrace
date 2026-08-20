/**
 * Exception transient synthesis (PRD §4.3 / §5.2, PLAN Task 3.4).
 *
 * Contract: an unhandled exception produces a band-passed white-noise burst
 * (2 kHz – 7 kHz, 120 ms) layered with a C5 + F#5 tritone accent — a
 * deliberately dissonant, unmistakable signal that is distinct from the
 * pentatonic call voices.
 *
 * Complexity: O(duration × sampleRate) once per transient to fill the noise
 * buffer (inherent to synthesis); node wiring is O(1). Exceptions are rare
 * events, so the buffer is never pooled or reused — keeping it simple beats
 * caching for a path that fires once per failure.
 */

export interface ExceptionParams {
  /** Noise transient length in seconds (PRD: 120 ms). */
  noiseDuration: number;
  /** Band-pass center = geometric mean of 2 kHz and 7 kHz. */
  noiseCenterHz: number;
  /** Band-pass Q covering the 2–7 kHz band (≈ center/bandwidth). */
  noiseQ: number;
  /** Peak noise gain. */
  noisePeak: number;
  /** Tritone root (C5). */
  tritoneFreqA: number;
  /** Tritone augmented fourth (F#5). */
  tritoneFreqB: number;
  /** Peak gain of each tritone oscillator. */
  tritonePeak: number;
  /** Ramp-in time in seconds (short, click-free). */
  attack: number;
}

export const DEFAULT_EXCEPTION_PARAMS: ExceptionParams = {
  noiseDuration: 0.12,
  noiseCenterHz: Math.sqrt(2000 * 7000), // ≈ 3741.7 Hz
  noiseQ: 0.75,
  noisePeak: 0.4,
  tritoneFreqA: 523.25, // C5
  tritoneFreqB: 739.99, // F#5
  tritonePeak: 0.15,
  attack: 0.002,
};

/** Fills a mono AudioBuffer with white noise (values in [-1, 1)). */
export function createWhiteNoiseBuffer(ctx: AudioContext, duration: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/** Plays the full exception transient: noise burst + tritone. */
export function playException(
  ctx: AudioContext,
  output: AudioNode,
  params: Partial<ExceptionParams> = {},
): void {
  const p = { ...DEFAULT_EXCEPTION_PARAMS, ...params };
  const t0 = ctx.currentTime;
  playNoiseBurst(ctx, output, t0, p);
  playTritone(ctx, output, t0, p);
}

function playNoiseBurst(
  ctx: AudioContext,
  output: AudioNode,
  t0: number,
  p: ExceptionParams,
): void {
  const source = ctx.createBufferSource();
  source.buffer = createWhiteNoiseBuffer(ctx, p.noiseDuration);

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = p.noiseCenterHz;
  filter.Q.value = p.noiseQ;

  const gain = ctx.createGain();
  const g = gain.gain;
  g.setValueAtTime(0, t0);
  g.linearRampToValueAtTime(p.noisePeak, t0 + p.attack);
  g.linearRampToValueAtTime(0, t0 + p.noiseDuration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(output);
  source.start(t0);
  source.stop(t0 + p.noiseDuration + 0.01);
}

function playTritone(ctx: AudioContext, output: AudioNode, t0: number, p: ExceptionParams): void {
  const freqs = [p.tritoneFreqA, p.tritoneFreqB];
  for (const freq of freqs) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    const g = gain.gain;
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(p.tritonePeak, t0 + p.attack);
    g.linearRampToValueAtTime(0, t0 + p.noiseDuration);

    osc.connect(gain);
    gain.connect(output);
    osc.start(t0);
    osc.stop(t0 + p.noiseDuration + 0.01);
  }
}