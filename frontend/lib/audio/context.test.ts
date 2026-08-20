import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAudioContext,
  isAudioRunning,
  resetAudioContext,
  resumeAudioContext,
  setAudioContextFactory,
} from "./context";
import { createFakeAudio } from "../../tests/helpers/webaudio-fake";

afterEach(() => {
  resetAudioContext();
  setAudioContextFactory(null);
  vi.restoreAllMocks();
});

describe("getAudioContext", () => {
  it("creates a singleton context on first use", () => {
    const { ctx } = createFakeAudio();
    setAudioContextFactory(() => ctx);

    expect(getAudioContext()).toBe(ctx);
    expect(getAudioContext()).toBe(ctx); // same instance
  });

  it("fails loudly when no factory is available", () => {
    setAudioContextFactory(() => {
      throw new Error("WebAudio is not supported in this browser");
    });
    expect(() => getAudioContext()).toThrow(/WebAudio is not supported/);
  });
});

describe("resumeAudioContext", () => {
  it("resumes a suspended context and reports success", async () => {
    const { fake, ctx } = createFakeAudio();
    fake.state = "suspended";
    setAudioContextFactory(() => ctx);

    await expect(resumeAudioContext()).resolves.toBe(true);
    expect(fake.resumeCalls).toBe(1);
    expect(isAudioRunning()).toBe(true);
  });

  it("is a no-op when already running", async () => {
    const { fake, ctx } = createFakeAudio();
    fake.state = "running";
    setAudioContextFactory(() => ctx);

    await expect(resumeAudioContext()).resolves.toBe(true);
    expect(fake.resumeCalls).toBe(0);
  });

  it("reports failure when resume rejects", async () => {
    const { fake, ctx } = createFakeAudio();
    fake.state = "suspended";
    fake.failResume = true;
    setAudioContextFactory(() => ctx);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(resumeAudioContext()).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("shares one in-flight resume across concurrent callers", async () => {
    const { fake, ctx } = createFakeAudio();
    fake.state = "suspended";
    setAudioContextFactory(() => ctx);

    const [a, b] = await Promise.all([resumeAudioContext(), resumeAudioContext()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(fake.resumeCalls).toBe(1);
  });
});

describe("resetAudioContext", () => {
  it("drops the singleton so the next call rebuilds it", () => {
    const first = createFakeAudio();
    const second = createFakeAudio();
    setAudioContextFactory(() => first.ctx);
    getAudioContext();

    setAudioContextFactory(() => second.ctx);
    expect(getAudioContext()).toBe(second.ctx);
  });
});