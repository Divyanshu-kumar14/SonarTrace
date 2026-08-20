/**
 * Deterministic WebAudio fake for unit tests.
 *
 * Node has no WebAudio implementation, so the audio modules are exercised
 * against a recording fake: every node creation and every AudioParam
 * automation event is captured and assertable. Production code never imports
 * this module; only tests do.
 */

export interface ParamEvent {
  op: "set" | "ramp" | "cancel";
  /** Scheduled time in seconds; -1 for immediate `.value =` assignments. */
  time: number;
  value: number;
}

export class FakeAudioParam {
  readonly events: ParamEvent[] = [];
  private _value: number;

  constructor(initial: number) {
    this._value = initial;
  }

  get value(): number {
    return this._value;
  }

  set value(v: number) {
    this._value = v;
    this.events.push({ op: "set", time: -1, value: v });
  }

  setValueAtTime(value: number, time: number): this {
    this._value = value;
    this.events.push({ op: "set", time, value });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this._value = value;
    this.events.push({ op: "ramp", time, value });
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.events.push({ op: "cancel", time, value: NaN });
    return this;
  }

  /** Automation events of one op kind, in order. */
  eventsOf(op: ParamEvent["op"]): ParamEvent[] {
    return this.events.filter((e) => e.op === op);
  }
}

export class FakeAudioNode {
  readonly kind: string;
  readonly id: number;
  readonly connections: Array<FakeAudioNode | FakeAudioParam> = [];
  disconnected = false;

  constructor(kind: string, ctx: FakeAudioContext) {
    this.kind = kind;
    this.id = ctx.nextNodeId++;
  }

  connect(dest: FakeAudioNode | FakeAudioParam): FakeAudioNode | FakeAudioParam {
    this.connections.push(dest);
    return dest;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

export class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam(1);
  constructor(ctx: FakeAudioContext) {
    super("gain", ctx);
  }
}

export class FakeStereoPannerNode extends FakeAudioNode {
  readonly pan = new FakeAudioParam(0);
  constructor(ctx: FakeAudioContext) {
    super("stereoPanner", ctx);
  }
}

export class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = "lowpass";
  readonly frequency = new FakeAudioParam(350);
  readonly Q = new FakeAudioParam(1);
  constructor(ctx: FakeAudioContext) {
    super("biquadFilter", ctx);
  }
}

export class FakeDynamicsCompressorNode extends FakeAudioNode {
  readonly threshold = new FakeAudioParam(-24);
  readonly ratio = new FakeAudioParam(12);
  readonly knee = new FakeAudioParam(30);
  readonly attack = new FakeAudioParam(0.003);
  readonly release = new FakeAudioParam(0.25);
  constructor(ctx: FakeAudioContext) {
    super("compressor", ctx);
  }
}

export class FakeOscillatorNode extends FakeAudioNode {
  type: OscillatorType = "sine";
  readonly frequency = new FakeAudioParam(440);
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;

  constructor(ctx: FakeAudioContext) {
    super("oscillator", ctx);
  }

  start(time = 0): void {
    this.startedAt = time;
  }

  stop(time = 0): void {
    this.stoppedAt = time;
  }

  triggerEnded(): void {
    this.onended?.();
  }
}

export class FakeBufferSourceNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;

  constructor(ctx: FakeAudioContext) {
    super("bufferSource", ctx);
  }

  start(time = 0): void {
    this.startedAt = time;
  }

  stop(time = 0): void {
    this.stoppedAt = time;
  }
}

export class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new RangeError(`No channel ${channel} in buffer`);
    return data;
  }
}

export class FakeAudioContext {
  state: AudioContextState = "running";
  sampleRate = 48000;
  currentTime = 0;
  /** All nodes created via the factory methods, in creation order. */
  readonly nodes: FakeAudioNode[] = [];
  readonly destination = new FakeAudioNode("destination", this);
  nextNodeId = 0;
  resumeCalls = 0;
  failResume = false;

  private track(node: FakeAudioNode): FakeAudioNode {
    this.nodes.push(node);
    return node;
  }

  createGain(): FakeGainNode {
    return this.track(new FakeGainNode(this)) as FakeGainNode;
  }

  createOscillator(): FakeOscillatorNode {
    return this.track(new FakeOscillatorNode(this)) as FakeOscillatorNode;
  }

  createStereoPanner(): FakeStereoPannerNode {
    return this.track(new FakeStereoPannerNode(this)) as FakeStereoPannerNode;
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    return this.track(new FakeBiquadFilterNode(this)) as FakeBiquadFilterNode;
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    return this.track(new FakeDynamicsCompressorNode(this)) as FakeDynamicsCompressorNode;
  }

  createBufferSource(): FakeBufferSourceNode {
    return this.track(new FakeBufferSourceNode(this)) as FakeBufferSourceNode;
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.failResume) throw new Error("resume failed (test)");
    this.state = "running";
  }

  byKind(kind: string): FakeAudioNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
  }
}

export interface FakeAudioFixture {
  fake: FakeAudioContext;
  ctx: AudioContext;
}

/** Builds a fake context and its `AudioContext`-typed view for the modules. */
export function createFakeAudio(): FakeAudioFixture {
  const fake = new FakeAudioContext();
  return { fake, ctx: fake as unknown as AudioContext };
}

// --- Downcast helpers (production modules receive WebAudio-typed nodes). ---
// Inputs are `unknown` because tests legitimately hold both real-typed
// handles and fake instances; the cast is a test-only escape hatch.

export function fakeNode(node: unknown): FakeAudioNode {
  return node as FakeAudioNode;
}

export function fakeOsc(node: unknown): FakeOscillatorNode {
  return node as FakeOscillatorNode;
}

export function fakeGain(node: unknown): FakeGainNode {
  return node as FakeGainNode;
}

export function fakePanner(node: unknown): FakeStereoPannerNode {
  return node as FakeStereoPannerNode;
}

export function fakeFilter(node: unknown): FakeBiquadFilterNode {
  return node as FakeBiquadFilterNode;
}

export function fakeCompressor(node: unknown): FakeDynamicsCompressorNode {
  return node as FakeDynamicsCompressorNode;
}

export function fakeSource(node: unknown): FakeBufferSourceNode {
  return node as FakeBufferSourceNode;
}

export function fakeParam(param: unknown): FakeAudioParam {
  return param as FakeAudioParam;
}