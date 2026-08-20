# SonarTrace

**Runtime Execution Sonification for Visually Impaired Developers.**

SonarTrace turns a running Python program's execution telemetry — call-stack depth,
concurrent task activity, event-loop stalls, hot loops, and exceptions — into a
**real-time, spatial polyphonic audio landscape**. Instead of reading flamegraphs
or 2,000-line logs with a screen reader, a developer *hears* code execute: pitch
maps to call depth, stereo position maps to coroutines, a sub-bass drone swells
when the event loop stalls, and a dissonant noise burst announces an unhandled
exception.

> **TL;DR** — a zero-code-modification tracer (`sys.setprofile`) → throttling
> aggregator → WebSocket gateway → WebAudio DSP synthesizer pipeline, built for
> blind and low-vision engineers who need to debug recursion, asyncio
> concurrency, and event-loop starvation by ear.

---

## Table of Contents

- [What it does](#what-it-does)
- [How it sounds (perceptual mapping)](#how-it-sounds-perceptual-mapping)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Implementation status](#implementation-status)
- [Quick start](#quick-start)
- [Usage examples](#usage-examples)
- [Configuration reference](#configuration-reference)
- [Edge cases & gotchas](#edge-cases--gotchas)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [License](#license)

---

## What it does

| Capability | How |
|---|---|
| **Zero code modification** | A `sys.setprofile` hook traces any Python script without editing it (PRD US-1) |
| **Call-depth sonification** | Each `call`/`return` event is a pentatonic "pluck" whose pitch rises with stack depth — runaway recursion is instantly audible (PRD US-2) |
| **Concurrent task separation** | Each asyncio task is deterministically assigned a stereo pan (`-0.85…+0.85`) and timbre (sine / triangle / FM) so parallel work is spatially separable (PRD US-3) |
| **Loop throttling** | A sliding-window aggregator folds >20 calls/50 ms per function into a single `LOOP_BURST` harmonic texture — no ear fatigue (PRD US-4) |
| **Stall detection** | An asyncio heartbeat monitors event-loop lag; a 46 Hz sub-bass drone swells with the lag (PRD §4.1, §5.2) |
| **Exception alarms** | Unhandled exceptions trigger a band-passed white-noise burst + C5/F#5 tritone |
| **Fail-open by design** | Tracer hooks can never crash the traced program; audio drops events rather than throwing when overloaded |

---

## How it sounds (perceptual mapping)

| Telemetry event | Audio cue | Formula / implementation |
|---|---|---|
| `CALL`, `AWAIT`, `RESUME` | Pentatonic pluck, pitch = call depth | `depthToFrequency(depth)`: depth 1…32 → C Major Pentatonic C3 (130.81 Hz) → D9 (9397.28 Hz); depths > 32 clamp at D9 |
| Task identity | Stereo pan + timbre | `panForTask(task_id)`: FNV-1a hash → `[-0.85, +0.85]`; `waveformForTask`: sine / triangle / FM (FM ratio 4×, index 0.5) |
| `RETURN` | *Silent* | Returns release stack space; sounding them adds cacophony |
| `LOOP_BURST` | Harmonic texture, pitch drift | `f_burst = f_base + log10(iterations) × 30 Hz`, triangle partials 1×, 2×, 3×, 250 ms |
| `STALL` | 46 Hz sub-bass drone | gain = `min(0.8, lag_ms / 200)`, 100 ms linear fades |
| `EXCEPTION` | Noise burst + tritone | 2–7 kHz band-passed white noise, 120 ms, layered with C5 (523.25 Hz) + F#5 (739.99 Hz) |

Every voice runs through: **oscillator → envelope (ADSR: attack 2 ms, decay 40 ms,
sustain 0, release 10 ms) → stereo panner → master summing bus → 12 kHz low-pass →
compressor (−6 dB, 4:1) → destination** (PRD §4.3).

---

## Architecture

```
TARGET APPLICATION RUNTIME (Python)
┌────────────────────────────────────┐
│  User code (any Python script)     │
│        │ sys.setprofile hook       │
│        ▼                           │
│  Tracer (tracer.py)                │
│  • per-task call depth             │
│  • asyncio heartbeat → STALL       │
│  • excepthook wrapper → EXCEPTION  │
└───────────────┬────────────────────┘
                │ TelemetryFrame objects (asyncio.Queue)
                ▼
┌────────────────────────────────────┐
│  LoopAggregator (aggregator.py)    │
│  • 50 ms rolling window per (fn,   │
│    module) key                     │
│  • >20 calls/50 ms → LOOP_BURST    │
└───────────────┬────────────────────┘
                │ JSON frames
                ▼
┌────────────────────────────────────┐
│  Gateway server (server.py)  ⏳     │
│  • /ws/ingress (tracer → server)   │
│  • /ws/client (server → browsers)  │
└───────────────┬────────────────────┘
                │ WebSocket (localhost:8765)
                ▼
┌────────────────────────────────────┐
│  WebAudio DSP (frontend/lib/audio) │
│  Synthesizer → MasterBus →         │
│  OscillatorPool / Drone /          │
│  exception.ts / loop-burst.ts      │
└───────────────┬────────────────────┘
                ▼
        Stereo output (headphones/transducers)
```

> ⏳ = not yet implemented — see [Implementation status](#implementation-status).

---

## Repository layout

```
SonarTrace/
├── README.md                  ← you are here
├── SonarTrace_PRD.md          Product requirements & system design (source of truth)
├── PLAN.md                    Phase-by-phase implementation plan
├── pyproject.toml             Root package config (CLI entry point: sonartrace:main)
├── requirements.txt           Runtime + dev dependency pins
│
├── backend/                   Python tracer engine (Phase 1 & 2)
│   ├── pyproject.toml         sonartrace package (3.11+, zero runtime deps for tracing)
│   ├── sonartrace/
│   │   ├── types.py           EventType enum + TelemetryFrame dataclass (PRD §5.1)
│   │   ├── tracer.py          sys.setprofile hooks, per-task depth, stall heartbeat
│   │   ├── aggregator.py      Sliding-window loop throttling → LOOP_BURST
│   │   ├── serialization.py   Strict JSON encode/decode of frames
│   │   ├── server.py          ⏳ FastAPI WebSocket gateway (planned)
│   │   └── cli.py             ⏳ `sonartrace run <script.py>` (planned)
│   └── tests/
│       ├── test_tracer.py     ✅  passes
│       ├── test_types.py      ✅  passes
│       ├── test_aggregator.py ✅  passes
│       ├── test_cli.py        ❌  fails — cli.py not implemented
│       ├── test_server.py     ❌  errors — server.py not implemented
│       ├── test_integration.py❌  errors — server.py not implemented
│       └── fixtures/          simple.py, demo_recursion.py, demo_starvation.py,
│                              demo_concurrency.py, echo_args.py, long_running.py, …
│
└── frontend/                  Next.js 14 + TypeScript WebAudio synthesizer (Phase 3)
    ├── package.json           Scripts: dev, build, lint, typecheck, test
    ├── lib/
    │   ├── telemetry.ts       TS mirror of TelemetryFrame / EventType + runtime guards
    │   └── audio/
    │       ├── context.ts         Singleton AudioContext + resume (autoplay policy)
    │       ├── oscillator-pool.ts Recycled Oscillator/Gain voice pool (default 32)
    │       ├── frequency-map.ts   Depth → pentatonic frequency (C3…D9, clamped)
    │       ├── envelope.ts        ADSR scheduling (attack 2 ms, decay 40 ms, …)
    │       ├── panner.ts          Task ID → pan/timbre (FNV-1a, memoized)
    │       ├── drone.ts           46 Hz stall drone (gain = min(0.8, lag/200))
    │       ├── exception.ts       Noise burst + tritone transient
    │       ├── loop-burst.ts      Harmonic texture with log10 iteration drift
    │       ├── master-bus.ts      Sum → LPF 12 kHz → compressor (−6 dB, 4:1)
    │       └── synthesizer.ts     Main entry point: playEvent(frame) / setStall(ms)
    └── app/
        ├── page.tsx           ⏳ Placeholder HUD (Phase 4)
        └── components/AudioStatus.tsx  ✅ Working audio-state card (ARIA live region)
```

---

## Implementation status

| Phase | Component | Status |
|---|---|---|
| 1.1 | Tracer core (`tracer.py`) | ✅ Implemented, tested |
| 1.2 | Frame schema & serialization (`types.py`, `serialization.py`) | ✅ Implemented, tested |
| 2.1 | Loop aggregator (`aggregator.py`) | ✅ Implemented, tested |
| 2.2 | FastAPI WebSocket server (`server.py`, `ws_protocol.py`) | ⏳ **Not implemented** (tests exist and fail with `ModuleNotFoundError`) |
| 2.3 | CLI entry point (`cli.py`, `sonartrace run`) | ⏳ **Not implemented** (12 CLI tests fail; root `sonartrace:main` is a stub) |
| 3.1–3.5 | WebAudio DSP library (`frontend/lib/audio/*`) | ✅ Implemented, tested (85 tests) |
| 4.1–4.4 | Keyboard HUD, ARIA live log, WebSocket client, demo integration | ⏳ Partially done — only `AudioStatus` card exists |

The **backend tracer pipeline works end-to-end as a library today**: trace a
program, throttle bursts, serialize frames — the missing pieces are the transport
(WebSocket gateway) and the CLI runner that wire it to the browser.

---

## Quick start

### Prerequisites

- Python **3.11+** (developed on 3.14; backend package declares `>=3.11`)
- Node.js **18+** / pnpm (frontend uses `pnpm-lock.yaml`)
- A browser with WebAudio (all modern browsers; Safari needs `webkitAudioContext` fallback, which is handled)

### Backend (tracer engine)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e .           # installs the `sonartrace` package (zero runtime deps)
pytest tests/ -q           # Phase 1 + 2.1 tests (test_tracer/test_types/test_aggregator)
```

> `test_cli.py`, `test_server.py`, and `test_integration.py` will **fail** until
> Phase 2.2/2.3 lands — see [Implementation status](#implementation-status).

### Frontend (synthesizer + HUD)

```bash
cd frontend
pnpm install
pnpm dev                   # http://localhost:3000 — shows the audio-status card
pnpm test                  # 85 unit tests (Vitest + WebAudio fakes)
pnpm lint && pnpm typecheck
```

---

## Usage examples

### 1. Trace a Python program (library API)

```python
import asyncio

from sonartrace import Tracer, TelemetryFrame

async def main() -> None:
    tracer = Tracer()  # optional: max_queue_size, heartbeat_interval_ms, stall_threshold_ms
    tracer.start()

    async def worker(name: str) -> None:
        for _ in range(3):
            await asyncio.sleep(0.01)  # emits CALL/RETURN around the coroutine

    # do work here — the tracer watches everything that runs on this loop

    # Drain frames (this is what a gateway server would forward to the browser)
    while not tracer.queue.empty():
        frame: TelemetryFrame = tracer.queue.get_nowait()
        print(frame)

    tracer.stop()

asyncio.run(main())
```

### 2. Throttle hot loops into LOOP_BURST

```python
from sonartrace import LoopAggregator, AggregatorConfig

# defaults: 50 ms window, >20 calls per (fn_name, module) → LOOP_BURST
aggregator = LoopAggregator(AggregatorConfig(window_ms=50, threshold=20))

async def pipeline(frames):
    async for frame in aggregator.process(frames):
        await forward_to_websocket(frame)  # CALL floods become LOOP_BURST
```

### 3. Serialize / deserialize frames (wire format)

```python
from sonartrace import dumps_frame, loads_frame, TelemetryFrame, EventType

frame = TelemetryFrame(
    id=1, timestamp_ms=1_750_000_000_000, type=EventType.CALL,
    fn_name="fib", module="/tmp/demo.py", depth=4, task_id="main",
)
payload = dumps_frame(frame)
# {"id":1,"timestamp_ms":1750000000000,"type":"CALL","fn_name":"fib",
#  "module":"/tmp/demo.py","depth":4,"task_id":"main"}
assert loads_frame(payload) == frame
```

### 4. Sonify frames in the browser (frontend API)

```ts
import { Synthesizer, resumeAudioContext } from "@/lib/audio";
import type { TelemetryFrame } from "@/lib/telemetry";

const synth = new Synthesizer();                    // pool 32 voices, master bus, drone
await resumeAudioContext();                         // required: user gesture (autoplay policy)

function onFrame(frame: TelemetryFrame) {
  synth.playEvent(frame);                           // CALL/AWAIT/RESUME/LOOP_BURST/STALL/EXCEPTION
}

function onLag(lagMs: number) {
  synth.setStall(lagMs);                            // drives the 46 Hz drone gain
}

console.log(synth.activeVoices, synth.droppedEventCount);  // diagnostics
// synth.dispose() when tearing down
```

---

## Configuration reference

### Backend — `Tracer` (`tracer.py`)

| Parameter | Default | Description |
|---|---|---|
| `max_queue_size` | `10_000` | Queue cap; oldest frames are dropped first on overflow (bounded memory) |
| `heartbeat_interval_ms` | `10.0` | Period of the event-loop heartbeat tick |
| `stall_threshold_ms` | `35.0` | Tick delay beyond which a `STALL` frame is emitted |

Validation: all three must be `> 0` or `ValueError` is raised.

### Backend — `AggregatorConfig` (`aggregator.py`)

| Parameter | Default | Description |
|---|---|---|
| `window_ms` | `50` | Rolling time window in ms |
| `threshold` | `20` | Max `CALL` events per window before a `LOOP_BURST` is emitted |

Validation: both must be `> 0` or `ValueError` is raised.

### Frontend — `SynthesizerOptions` (`synthesizer.ts`)

| Option | Default | Description |
|---|---|---|
| `poolSize` | `32` | Voice pool capacity (PRD §4.3) |
| `master` | new `MasterBus(ctx)` | Test seam: pre-built master bus |
| `drone` | new `Drone(ctx, master.input)` | Test seam: pre-built stall drone |
| `voiceDuration` | `envelopeDuration() + 0.008 s` | Pluck length (envelope + 8 ms tail) |

### Frontend — tunable DSP constants

| Module | Constant(s) | Value |
|---|---|---|
| `frequency-map.ts` | `PENTATONIC_FREQUENCIES` | 32 degrees: C3 (130.81 Hz) → D9 (9397.28 Hz) |
| `panner.ts` | `PAN_RANGE` | `0.85` |
| `drone.ts` | `DEFAULT_DRONE_PARAMS` | `frequency: 46`, `maxGain: 0.8`, `lagDivisor: 200`, `fadeSeconds: 0.1` |
| `envelope.ts` | `DEFAULT_ENVELOPE` | `attack: 0.002`, `decay: 0.04`, `sustain: 0`, `release: 0.01`, `peak: 0.5` |
| `exception.ts` | `DEFAULT_EXCEPTION_PARAMS` | noise 0.12 s @ ~3741.7 Hz band-pass, C5 + F#5 tritone |
| `loop-burst.ts` | `LOOP_BURST_DRIFT_HZ` | `30` (log10(iterations) × 30 Hz drift) |
| `master-bus.ts` | `MASTER_LPF_FREQUENCY`, `MASTER_COMPRESSOR_THRESHOLD_DB`, `MASTER_COMPRESSOR_RATIO` | `12000`, `-6`, `4` |
| `synthesizer.ts` | `FM_RATIO`, `FM_INDEX` | `4`, `0.5` |

### Wire format — `TelemetryFrame` (PRD §5.1)

```jsonc
{
  "id": 1,                  // monotonic sequence ID (int)
  "timestamp_ms": 1750000000000, // epoch ms (int)
  "type": "CALL",           // CALL | RETURN | AWAIT | RESUME | LOOP_BURST | STALL | EXCEPTION
  "fn_name": "fib",         // function / coroutine name
  "module": "/tmp/demo.py", // file or module path
  "depth": 4,               // observed call depth (NOT clamped — the frontend clamps)
  "task_id": "task-0",      // coroutine ID; "main" outside tasks
  // optional — omitted when null:
  "loop_iterations": 42,    // LOOP_BURST only
  "stall_duration_ms": 87,  // STALL only
  "error_type": "RecursionError" // EXCEPTION only
}
```

---

## Edge cases & gotchas

### Backend (Python)

- **Hooks never raise.** Every profile-hook body is wrapped in
  `try … except BaseException: pass` — a broken hook can never crash the traced
  program (fail-safe guarantee, PRD §6).
- **The tracer never traces itself.** Frames originating inside the
  `sonartrace` package directory are filtered with an O(1) prefix check, and the
  heartbeat task (`_sonartrace_heartbeat`) is excluded from the stream — no
  feedback loops.
- **`sys.setprofile` is per-thread and disables itself during the callback.** The
  interpreter does not re-enter the hook while it runs, so `asyncio.current_task()`
  / queue puts inside the hook are safe. But only the *installing* thread is
  traced — worker threads of the target program are not covered.
- **`c_exception` fires instead of `c_return`** when a C function raises; both are
  treated as "leave" events that decrement depth (CPython 3.14 semantics,
  empirically verified).
- **Depth is reported *before* decrement on leave events** so a frame's `CALL` and
  its matching `RETURN` carry the same depth; depth is clamped at 0 per task.
- **Control-flow exceptions are silent.** `StopIteration` and `GeneratorExit`
  never produce `EXCEPTION` frames.
- **Depth is not clamped upstream.** `TelemetryFrame.depth` carries the *observed*
  depth (can exceed 32); clamping to the 1…32 sonification range is the
  frontend's job so no information is lost.
- **Queue overflow drops oldest frames**, never raises — a slow consumer cannot
  exhaust the target's memory.
- **Heartbeat measures *scheduled vs. actual* tick time** via `asyncio.sleep`,
  so it reports real event-loop lag, and it only starts when a loop is running
  (lazily on first traced event inside a loop).
- **Aggregator edge cases:** only `CALL` frames are throttled; all other types
  pass through untouched. Burst mode suppresses subsequent `CALL`s until the
  window count drops to ≤ threshold. The ring buffer is a `deque(maxlen=10000)`,
  so per-key memory is bounded. Timestamps are taken from the frame
  (`timestamp_ms`), not wall-clock — feed frames with sane timestamps.
- **Strict deserialization.** `loads_frame` / `frame_from_dict` raise
  `ValueError` on malformed JSON, missing fields, wrong types, or unknown event
  types — the frontend's `isTelemetryFrame` guard mirrors this strictness.
- **The root CLI entry point is a stub.** `pyproject.toml` maps
  `sonartrace = "sonartrace:main"`, but `src/sonartrace/__init__.py` only prints
  "Hello from sonartrace!". `sonartrace run script.py` does **not** work yet.

### Frontend (WebAudio / TypeScript)

- **Autoplay policy.** You may *create* an `AudioContext` while suspended, but
  sound only flows after a user gesture calls `resumeAudioContext()` (the
  `AudioStatus` card's "Enable sound" button exists for exactly this).
- **Browser autoplay policy applies per-document; the `AudioStatus` card**
  transitions through `checking → ready | suspended | unsupported`.
- **OscillatorNodes are single-shot.** A stopped oscillator cannot restart, so
  `OscillatorPool.release()` swaps in a fresh oscillator while reusing the
  GainNode — the allocation-heavy part of the graph stays pooled. `dispose()`
  makes the pool unusable afterward.
- **Pool exhaustion is fail-open.** `acquire()` returns `null` past pool size;
  the synthesizer increments `droppedEventCount` and drops the event instead of
  allocating unbounded nodes or throwing.
- **Malformed depths degrade gracefully.** `depthToFrequency` maps non-finite or
  sub-1 depths to the scale root (C3) so a bad frame can never push an invalid
  frequency into the audio graph.
- **`panForTask` / `waveformForTask` are deterministic and memoized** (FNV-1a,
  256-entry FIFO cache). The same task ID always maps to the same pan and
  timbre; the cache is content-addressed so results are identical with or
  without a hit.
- **Envelopes are click-free by construction:** attack ramps from exactly 0;
  release ramps to exactly 0; the caller must stop its oscillator at/after the
  returned release time. `scheduleReleaseEnvelope` returns the zero-crossing
  time for exactly this reason.
- **Drone gain is idempotent.** `setLag` skips re-ramping when the target gain is
  unchanged, and non-finite/negative lag maps to 0 (drone off).
- **`RETURN` events are intentionally silent** — sounding them would turn every
  call site into cacophony.
- **`playException` allocates a fresh noise buffer per event.** That's deliberate:
  exceptions are rare, so caching a buffer on a cold path isn't worth it.
- **The master compressor (−6 dB, 4:1) is the final anti-clipping guard** under
  32 concurrent voices — but if you crank `poolSize` up, keep the compressor in
  the chain or expect clipping.
- **`isTelemetryFrame` validates the wire format at the boundary** — fields must
  be the right JS types (`number` for `id`/`timestamp_ms`/`depth`, not `string`),
  which mirrors the backend's strict validation.

---

## Testing

```bash
# Backend (63 pass, 12 fail + 2 collect errors — the failures are Phase 2.2/2.3 gaps)
cd backend
ruff check .                          # lint
mypy sonartrace/                      # strict type check
pytest tests/test_tracer.py tests/test_types.py tests/test_aggregator.py -v
pytest tests/ -q --cov=sonartrace --cov-report=term-missing   # full suite (expect Phase 2 failures)

# Frontend (85 pass)
cd frontend
pnpm lint                             # ESLint
pnpm typecheck                        # tsc --noEmit
pnpm test                             # Vitest — all 11 files pass
```

---

## Roadmap

Planned next steps (see `PLAN.md` for the full breakdown):

1. **Phase 2.2** — FastAPI WebSocket gateway (`server.py`): `/ws/ingress` for the
   tracer, `/ws/client` broadcast for browsers, connection management.
2. **Phase 2.3** — `sonartrace run <script.py>` CLI: spawn tracer + aggregator +
   server, forward args/stdout/stderr, propagate exit codes, clean Ctrl+C.
3. **Phase 4** — Accessible HUD: keyboard controls (`Space`, `←/→`, `1–9`, `M`),
   ARIA live regions, WebSocket client with exponential-backoff reconnection,
   and wiring the demo scripts (`demo_recursion.py`, `demo_starvation.py`,
   `demo_concurrency.py`) to the synthesizer for the PRD §8 acoustic scenarios.

---

## License

MIT — see [LICENSE](LICENSE).

---

*Product spec: [`SonarTrace_PRD.md`](SonarTrace_PRD.md) · Implementation plan:
[`PLAN.md`](PLAN.md)*