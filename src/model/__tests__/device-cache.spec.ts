import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Device } from "../device.js";
import type { ResolvedDevice } from "../types.js";

/** A bare battery-camera resolution — one known param (`battery`, 1101) is enough for these reads. */
const RESOLVED: ResolvedDevice = {
  codec: "camera",
  capabilities: ["battery"],
  properties: [{ name: "battery", paramType: 1101, type: "number", writable: false }],
  writeOnlySettings: [],
  name: "cam",
  source: "model",
};

function makeDevice() {
  return new Device("T8000P0000000000", RESOLVED);
}

describe("Device read-through freshness cache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("without a policy, reads never trigger a refresh (default off)", () => {
    const dev = makeDevice();
    dev.applyParams({ 1101: "50" }, Date.now() - 60_000);
    expect(dev.getProperty("battery")?.value).toBe(50);
  });

  it("a fresh value is served from cache — no refresh scheduled", async () => {
    const dev = makeDevice();
    const refresh = vi.fn().mockResolvedValue(undefined);
    dev.setFreshnessPolicy({ staleAfterMs: 15_000, refresh });
    dev.applyParams({ 1101: "50" }, Date.now());
    dev.getProperty("battery");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a stale read schedules exactly one coalesced background refresh", async () => {
    const dev = makeDevice();
    let resolveRefresh!: () => void;
    const refresh = vi.fn(() => new Promise<void>((r) => (resolveRefresh = r)));
    dev.setFreshnessPolicy({ staleAfterMs: 15_000, refresh });
    dev.applyParams({ 1101: "50" }, Date.now() - 20_000);
    dev.getProperty("battery");
    dev.getProperty("battery");
    dev.getProperty("battery");
    expect(refresh).toHaveBeenCalledOnce();
    resolveRefresh();
  });

  it("a refresh that lands via applyParams makes subsequent reads fresh again", async () => {
    const dev = makeDevice();
    const refresh = vi.fn(async () => {
      dev.applyParams({ 1101: "60" }, Date.now());
    });
    dev.setFreshnessPolicy({ staleAfterMs: 15_000, refresh });
    dev.applyParams({ 1101: "50" }, Date.now() - 20_000);
    dev.getProperty("battery");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    expect(dev.getProperty("battery")?.value).toBe(60);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("an absent value never triggers a refresh (avoids hammering on a property the device lacks)", async () => {
    const dev = makeDevice();
    const refresh = vi.fn().mockResolvedValue(undefined);
    dev.setFreshnessPolicy({ staleAfterMs: 15_000, refresh });
    expect(dev.getProperty("battery")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
  });
});
