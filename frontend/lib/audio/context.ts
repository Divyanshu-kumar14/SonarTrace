/**
 * Singleton AudioContext lifecycle (PRD §4.3 / PLAN Task 3.1).
 *
 * Complexity: O(1) — getAudioContext() is a null-check + create once; the
 * singleton avoids the O(node-graph) cost of rebuilding the context per
 * event stream.
 *
 * Contract:
 * - `getAudioContext()` lazily creates one shared context and returns it.
 * - `resumeAudioContext()` resumes it on a user gesture (autoplay policy);
 *   idempotent and safe to call repeatedly.
 * - Browser autoplay rules allow *creating* a context while suspended; sound
 *   only flows after a user gesture triggers `resume()`.
 */

export const AUDIO_CONTEXT_SUSPENDED_MSG =
  "AudioContext created but still suspended; call resumeAudioContext() from a user gesture.";

type AudioContextFactory = () => AudioContext;

/** Standard factory with a Safari/webkit fallback. */
const defaultFactory: AudioContextFactory = () => {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    throw new Error("WebAudio is not supported in this browser");
  }
  return new Ctor();
};

let sharedContext: AudioContext | null = null;
let contextFactory: AudioContextFactory = defaultFactory;
let resumeInFlight: Promise<boolean> | null = null;

/** Test seam: replace the context constructor (e.g. with a fake). */
export function setAudioContextFactory(factory: AudioContextFactory | null): void {
  contextFactory = factory ?? defaultFactory;
  // Any future getAudioContext() must use the new factory.
  sharedContext = null;
}

/** Test seam: drop the singleton so the next call rebuilds it. */
export function resetAudioContext(): void {
  sharedContext = null;
  resumeInFlight = null;
}

/** Returns the shared AudioContext, creating it on first use. */
export function getAudioContext(): AudioContext {
  if (!sharedContext) {
    sharedContext = contextFactory();
  }
  return sharedContext;
}

/**
 * Resumes the shared context. Safe to call from any user gesture; resolves
 * `true` once the context is running. Concurrent callers share one attempt.
 */
export async function resumeAudioContext(): Promise<boolean> {
  const ctx = getAudioContext();
  if (ctx.state === "running") return true;

  if (!resumeInFlight) {
    resumeInFlight = ctx
      .resume()
      .then(() => ctx.state === "running")
      .catch((error: unknown) => {
        // Fail loudly: a gesture-resume failure is a real problem, not noise.
        console.error("SonarTrace: failed to resume AudioContext", error);
        return false;
      })
      .finally(() => {
        resumeInFlight = null;
      });
  }
  return resumeInFlight;
}

/** True when the shared context exists and is running. */
export function isAudioRunning(): boolean {
  return sharedContext?.state === "running";
}