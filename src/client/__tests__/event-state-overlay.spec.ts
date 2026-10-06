import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";

const sn = "T9000P0000000000";
const refresh = { param: 1224, property: "armingMode", timeoutMs: 1_000 };

/** Retained model and registry with independently controlled cloud and realtime observations. */
function fixture(mode = 3) {
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic" });
  const client = eufy as any;
  const registry = client.registry;
  const cloud: { params: Record<number, string> } = { params: { 1224: "1", 1101: "20" } };
  const values: Record<number, string> = { 1224: String(mode), 1101: "80" };
  const device = {
    getProperty: () => ({ value: Number(values[1224]) }),
    applyParams: vi.fn((params: Record<number, string>) => Object.assign(values, params)),
  };
  client.liveDevices.set(sn, new WeakRef(device));
  vi.spyOn(registry, "require").mockImplementation(() => cloud);
  const fetch = vi.spyOn(registry, "getDevices").mockResolvedValue([]);
  registry.applyRealtimeParams(sn, { ...values });
  return { client, registry, cloud, values, device, fetch };
}

afterEach(() => vi.useRealTimers());

describe("event state uses the effective parameter", () => {
  it("bounds an unchanged valueless observation without rolling back realtime state", async () => {
    vi.useFakeTimers();
    const { client, values, device, fetch } = fixture();
    const result = client.refreshEventState(sn, refresh).then(
      (value: boolean) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { observed: "3" } });
    expect(values).toEqual({ 1224: "3", 1101: "80" });
    expect(device.applyParams).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("accepts an already reported expected value without a cloud fetch", async () => {
    const { client, values, device, fetch } = fixture();
    await expect(client.refreshEventState(sn, { ...refresh, expected: 3 })).resolves.toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(device.applyParams).toHaveBeenCalledExactlyOnceWith({ 1224: "3" });
    expect(values[1101]).toBe("80");
  });

  it("applies only the observed cloud parameter when no realtime override remains", async () => {
    const { client, registry, cloud, values, device } = fixture(1);
    registry.retireRealtimeParams(sn, [1224]);
    cloud.params[1224] = "3";
    await expect(client.refreshEventState(sn, { ...refresh, expected: 3 })).resolves.toBe(true);
    expect(device.applyParams).toHaveBeenCalledExactlyOnceWith({ 1224: "3" });
    expect(values[1101]).toBe("80");
  });

  it("accepts a subsequent realtime transition during a valueless observation", async () => {
    vi.useFakeTimers();
    const { client, registry, values, device } = fixture();
    const pending = client.refreshEventState(sn, refresh);
    await vi.advanceTimersByTimeAsync(100);
    registry.applyRealtimeParams(sn, { 1224: "0" });
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toBe(true);
    expect(device.applyParams).toHaveBeenCalledExactlyOnceWith({ 1224: "0" });
    expect(values).toEqual({ 1224: "0", 1101: "80" });
  });

  it("allows a later cloud transition after the normal overlay retirement", async () => {
    vi.useFakeTimers();
    const { client, registry, cloud, values } = fixture();
    const pending = client.refreshEventState(sn, refresh);
    await vi.advanceTimersByTimeAsync(100);
    cloud.params[1224] = "0";
    registry.retireRealtimeParams(sn, [1224]);
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toBe(true);
    expect(values).toEqual({ 1224: "0", 1101: "80" });
  });

  it("refuses an unloaded serial even when a realtime overlay exists", async () => {
    const { client, registry } = fixture();
    registry.require.mockRestore();
    await expect(client.refreshEventState(sn, { ...refresh, expected: 3 })).rejects.toThrow(/not loaded/);
  });

  it("observes an independently refreshed model when the cached raw parameter is absent", async () => {
    vi.useFakeTimers();
    const { client, registry, cloud, values, device } = fixture();
    registry.retireRealtimeParams(sn, [1224]);
    delete cloud.params[1224];
    const pending = client.refreshEventState(sn, refresh).then(
      (value: boolean) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(100);
    values[1224] = "0";
    await vi.advanceTimersByTimeAsync(900);
    expect(await pending).toEqual({ value: true });
    expect(device.applyParams).not.toHaveBeenCalled();
    expect(values).toEqual({ 1224: "0", 1101: "80" });
  });
});
