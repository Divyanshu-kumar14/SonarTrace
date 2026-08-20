import { describe, expect, it } from "vitest";
import { createFakeAudio, fakeGain, fakeOsc, fakeParam } from "../../tests/helpers/webaudio-fake";
import { DEFAULT_DRONE_PARAMS, Drone, droneGainForLag } from "./drone";

/** Access to the drone's (private) nodes for assertions. */
function droneInternals(drone: Drone): { osc: OscillatorNode; gain: GainNode } {
  return drone as unknown as { osc: OscillatorNode; gain: GainNode };
}

describe("droneGainForLag (PRD §5.2: min(0.8, lag_ms / 200))", () => {
  it("maps lag to proportional gain with a 0.8 ceiling", () => {
    expect(droneGainForLag(0)).toBe(0);
    expect(droneGainForLag(50)).toBe(0.25);
    expect(droneGainForLag(100)).toBe(0.5);
    expect(droneGainForLag(200)).toBe(0.8);
    expect(droneGainForLag(500)).toBe(0.8); // capped
  });

  it("degrades invalid lag to silence", () => {
    expect(droneGainForLag(-10)).toBe(0);
    expect(droneGainForLag(Number.NaN)).toBe(0);
    expect(droneGainForLag(Number.POSITIVE_INFINITY)).toBe(0); // not a real measurement
  });
});

describe("Drone (PRD: 46 Hz continuous sine)", () => {
  it("starts a 46 Hz sine into the given output at zero gain", () => {
    const { ctx } = createFakeAudio();
    const output = ctx.createGain();
    const drone = new Drone(ctx, output);

    const osc = fakeOsc(droneInternals(drone).osc);
    const gain = fakeGain(droneInternals(drone).gain);

    expect(osc.type).toBe("sine");
    expect(osc.frequency.value).toBe(DEFAULT_DRONE_PARAMS.frequency);
    expect(gain.gain.value).toBe(0);
    expect(osc.connections).toContain(gain);
    expect(gain.connections).toContain(output);
    expect(osc.startedAt).not.toBeNull();
  });

  it("fades to the lag-derived gain over 100ms (no clicks)", () => {
    const { fake, ctx } = createFakeAudio();
    const output = ctx.createGain();
    const drone = new Drone(ctx, output);
    fake.advance(2.0);

    drone.setLag(100); // → 0.5

    const param = fakeParam(fakeGain(droneInternals(drone).gain).gain);
    expect(param.eventsOf("cancel").at(-1)).toMatchObject({ time: 2.0 });
    expect(param.eventsOf("ramp").at(-1)).toMatchObject({ time: 2.1, value: 0.5 });
    expect(drone.targetGain).toBe(0.5);
  });

  it("skips re-scheduling when the target gain is unchanged", () => {
    const { ctx } = createFakeAudio();
    const output = ctx.createGain();
    const drone = new Drone(ctx, output);

    drone.setLag(100);
    const eventsBefore = fakeParam(fakeGain(droneInternals(drone).gain).gain).events
      .length;
    drone.setLag(100);
    const eventsAfter = fakeParam(fakeGain(droneInternals(drone).gain).gain).events
      .length;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it("responds to larger lag by raising the target", () => {
    const { ctx } = createFakeAudio();
    const output = ctx.createGain();
    const drone = new Drone(ctx, output);

    drone.setLag(100);
    drone.setLag(250); // → 0.8 cap
    expect(drone.targetGain).toBe(0.8);
  });

  it("fades out over 100ms and stops on dispose", () => {
    const { fake, ctx } = createFakeAudio();
    const output = ctx.createGain();
    const drone = new Drone(ctx, output);
    fake.advance(1.0);
    drone.setLag(200);

    drone.dispose();

    const gain = fakeGain(droneInternals(drone).gain);
    const osc = fakeOsc(droneInternals(drone).osc);
    expect(fakeParam(gain.gain).eventsOf("ramp").at(-1)).toMatchObject({ time: 1.1, value: 0 });
    expect(osc.stoppedAt).toBeCloseTo(1.11, 5);
    expect(gain.disconnected).toBe(true);
    expect(osc.disconnected).toBe(true);
  });
});