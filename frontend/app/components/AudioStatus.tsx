"use client";

import { useEffect, useState } from "react";
import { getAudioContext, resumeAudioContext } from "@/lib/audio/context";

/**
 * Audio engine status card (PRD §4.3 / PLAN Task 3.1 UX).
 *
 * State machine:
 *   checking    → probing WebAudio support (skeleton shown, aria-busy)
 *   ready       → context exists and is running
 *   suspended   → context exists but the browser autoplay policy holds it;
 *                 user must press "Enable sound" (a user gesture triggers
 *                 resumeAudioContext())
 *   unsupported → no WebAudio constructor in this browser
 *
 * Accessibility:
 *   - The whole card is a live region (role="status" / role="alert") so
 *     screen readers announce state changes without focus moves.
 *   - The skeleton is decorative (aria-hidden content is never announced);
 *     its meaning is carried by the sr-only status text.
 *   - Micro-interactions are color-only (hover/active) — no transforms, so
 *     prefers-reduced-motion is fully respected.
 */
type AudioStatusState = "checking" | "ready" | "suspended" | "unsupported";

const STATUS_COPY: Record<Exclude<AudioStatusState, "checking">, string> = {
  ready: "Audio ready.",
  suspended: "Sound is paused by the browser until you enable it.",
  unsupported: "WebAudio is not supported in this browser.",
};

export default function AudioStatus() {
  const [status, setStatus] = useState<AudioStatusState>("checking");
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    // Probe on the next tick so the skeleton paints before we touch the
    // engine (no flash of final state, no layout jank).
    const timer = window.setTimeout(() => {
      let ctx: AudioContext;
      try {
        ctx = getAudioContext();
      } catch {
        setStatus("unsupported");
        return;
      }
      setStatus(ctx.state === "running" ? "ready" : "suspended");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const handleEnable = async () => {
    setEnabling(true);
    const running = await resumeAudioContext();
    setStatus(running ? "ready" : "suspended");
    setEnabling(false);
  };

  if (status === "checking") {
    return (
      <div
        role="status"
        aria-busy="true"
        className="w-64 rounded-lg border border-slate-700 bg-slate-900 p-4"
      >
        <p className="sr-only">Checking audio support…</p>
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton mt-2 h-4 w-1/3" />
      </div>
    );
  }

  if (status === "ready") {
    return (
      <div
        role="status"
        className="w-64 rounded-lg border border-slate-700 bg-slate-900 p-4 text-center"
      >
        <p className="text-sm text-slate-100">{STATUS_COPY.ready}</p>
      </div>
    );
  }

  if (status === "unsupported") {
    return (
      <div
        role="alert"
        className="w-64 rounded-lg border border-rose-400/40 bg-slate-900 p-4 text-center"
      >
        <p className="text-sm text-rose-400">{STATUS_COPY.unsupported}</p>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex w-64 flex-col items-center gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4"
    >
      <p className="text-sm text-slate-400">{STATUS_COPY.suspended}</p>
      <button
        type="button"
        onClick={handleEnable}
        disabled={enabling}
        className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400 active:bg-emerald-300 disabled:opacity-60"
      >
        {enabling ? "Enabling…" : "Enable sound"}
      </button>
    </div>
  );
}