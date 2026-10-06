import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, PortalPayloadObservation, PortalPayloadReader } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import { Device } from "../../model/device.js";
import type { RtcIdentity, RtcRoute } from "../../transport/rtc/command-router.js";
import { EufyMega } from "../eufy-mega.js";

/** Synthetic station identity, never resolved outside the process. */
const STATION = "T9000P0000000000";
/** Qualified context supplied without metadata acquisition. */
const CONTEXT: CommandContext = {
  model: "T9000",
  firmwareVersion: "4.4.0.4",
  channel: 0,
  paramIds: new Set(),
  codec: "station",
};
/** Opaque payload intent passed through the optional provider. */
const INTENT: Extract<Command, { kind: "set-payload" }> = {
  kind: "set-payload",
  cmd: 1307,
  channel: 0,
  payload: { version: 0, cmd: 11001 },
};
/** Synthetic successful observation from an already-owned channel. */
const OBSERVATION: PortalPayloadObservation = {
  payload: {
    cmd: 1307,
    payload: { body: { hdd_info: { disk_size_1024: 1024, video_used: 128, system_size: 16, system_size_data: 8 } } },
  },
  receivedAtMs: 1_800_000_000_000,
  correlation: "time-associated",
  exactlyCorrelated: false,
};
/** Minimal private facade surface needed to inspect local binding behavior. */
interface FacadeInternals {
  registry: { devices: EufyDevice[]; record(sn: string): Promise<unknown> };
  rtc: {
    readPayload(
      route: Pick<RtcRoute, "stationSn" | "adminUserId">,
      intent: Extract<Command, { kind: "set-payload" }>,
      isRecordCurrent: () => boolean,
      signal?: AbortSignal,
    ): Promise<PortalPayloadObservation>;
    dispatchCommand(route: RtcRoute, command: Command): Promise<void>;
  };
  mega: { rtcIdentity(): RtcIdentity | undefined };
  commandContext(sn: string): Promise<CommandContext>;
  portalPayloadReaderFor(sn: string, ctx: CommandContext): PortalPayloadReader | undefined;
}
/** Build a facade with synthetic records and mocked transport and metadata boundaries. */
function fixture(model = "T9000", nestedFirmware = false, fallbackAdmin = false) {
  const client = new EufyMega({
    email: "synthetic@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  const internals = client as unknown as FacadeInternals;
  const identity: RtcIdentity = { authToken: "synthetic-token", userId: "synthetic-user", gtoken: "synthetic-gtoken" };
  const rtcIdentity = vi.spyOn(internals.mega, "rtcIdentity").mockImplementation(() => identity);
  const device = {
    sn: STATION,
    model,
    stationSn: STATION,
    raw: {
      device_type: 27,
      ...(fallbackAdmin ? {} : { member: { admin_user_id: "synthetic-admin" } }),
      ...(nestedFirmware ? { deviceParams: { main_sw_version: "4.4.0.4" } } : { main_sw_version: "4.4.0.4" }),
    },
  } as EufyDevice;
  internals.registry.devices = [device];
  const read = vi.spyOn(internals.rtc, "readPayload").mockResolvedValue(OBSERVATION);
  const write = vi.spyOn(internals.rtc, "dispatchCommand").mockRejectedValue(new Error("synthetic forbidden write"));
  const record = vi
    .spyOn(internals.registry, "record")
    .mockRejectedValue(new Error("synthetic forbidden metadata read"));
  const context = vi
    .spyOn(internals, "commandContext")
    .mockRejectedValue(new Error("synthetic forbidden context refresh"));
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("synthetic forbidden network"));
  const bind = (provider?: PortalPayloadReader, ctx = CONTEXT) => {
    const bound = new Device(STATION, {
      codec: "station",
      capabilities: ["storage"],
      properties: [],
      name: "Synthetic station",
      source: "inferred",
    });
    bound.bindActions(
      ctx,
      { dispatch: vi.fn().mockRejectedValue(new Error("synthetic forbidden command")) },
      undefined,
      undefined,
      undefined,
      provider,
    );
    return bound;
  };
  return { client, internals, device, identity, rtcIdentity, read, write, record, context, fetch, bind };
}

afterEach(() => vi.restoreAllMocks());

describe("optional facade portal payload reader", () => {
  it.each(["T9000", "T8030"])(
    "threads the optional sixth provider through getDevice for %s without issuing a payload read",
    async (model) => {
      const f = fixture(model);
      f.record.mockResolvedValueOnce({ model, params: {} });
      f.context.mockResolvedValueOnce({ ...CONTEXT, model });
      const binding = vi.spyOn(Device.prototype, "bindActions");
      const bound = await f.client.getDevice(STATION);
      expect(binding).toHaveBeenCalledTimes(1);
      expect(binding.mock.calls[0]![5]).toEqual(model === "T9000" ? { readPayload: expect.any(Function) } : undefined);
      expect(bound.storage?.()?.getHddTelemetry).toEqual(model === "T9000" ? expect.any(Function) : undefined);
      expect(f.record).toHaveBeenCalledTimes(1);
      expect(f.context).toHaveBeenCalledTimes(1);
      expect(f.read).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it("binds a qualified optional provider without reads, writes, network calls or metadata refresh", () => {
    const f = fixture();
    const provider = f.internals.portalPayloadReaderFor(STATION, CONTEXT);
    expect(provider).toBeDefined();
    const bound = f.bind(provider);
    expect(bound.storage?.()?.getHddTelemetry).toBeTypeOf("function");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.context).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("leaves the read absent when the sixth binding argument is omitted", () => {
    const f = fixture();
    expect(f.bind().storage?.()?.getHddTelemetry).toBeUndefined();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["T8030", "T8425", "T8010", "T9000-synthetic-other", "t9000"])(
    "provides no portal reader for unsupported model %s",
    (model) => {
      const f = fixture(model);
      expect(f.internals.portalPayloadReaderFor(STATION, { ...CONTEXT, model })).toBeUndefined();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it("provides no reader for a missing record or an attached station-shaped record", () => {
    const f = fixture();
    expect(f.internals.portalPayloadReaderFor("T9000P0000000099", CONTEXT)).toBeUndefined();
    f.device.stationSn = "T9000P0000000001";
    expect(f.internals.portalPayloadReaderFor(STATION, CONTEXT)).toBeUndefined();
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "forwards an explicit read and abort signal with nested firmware %s",
    async (nestedFirmware) => {
      const f = fixture("T9000", nestedFirmware);
      const provider = f.internals.portalPayloadReaderFor(STATION, CONTEXT)!;
      const abort = new AbortController();
      await expect(provider.readPayload(INTENT, abort.signal)).resolves.toBe(OBSERVATION);
      expect(f.read).toHaveBeenCalledExactlyOnceWith(
        { stationSn: STATION, adminUserId: "synthetic-admin" },
        INTENT,
        expect.any(Function),
        abort.signal,
      );
      expect(f.read.mock.calls[0]![2]()).toBe(true);
      expect(f.record).not.toHaveBeenCalled();
      expect(f.context).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["model", "firmware", "nested firmware"])(
    "rejects a stale %s binding even when the transport would succeed",
    async (change) => {
      const f = fixture("T9000", change === "nested firmware");
      const stale = {
        ...CONTEXT,
        ...(change === "model" ? { model: "T9000-synthetic-other" } : { firmwareVersion: "synthetic-other" }),
      };
      const provider = f.internals.portalPayloadReaderFor(STATION, stale)!;
      await expect(provider.readPayload(INTENT)).rejects.toThrow("device record changed");
      expect(f.read).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["model", "firmware", "nested firmware", "missing"])(
    "rechecks the record before reading after %s changes",
    async (change) => {
      const f = fixture("T9000", change === "nested firmware");
      const provider = f.internals.portalPayloadReaderFor(STATION, CONTEXT)!;
      if (change === "model") f.device.model = "T9000-synthetic-other";
      if (change === "firmware") f.device.raw = { ...(f.device.raw as object), main_sw_version: "synthetic-other" };
      if (change === "nested firmware")
        f.device.raw = { ...(f.device.raw as object), deviceParams: { main_sw_version: "synthetic-other" } };
      if (change === "missing") f.internals.registry.devices = [];
      await expect(provider.readPayload(INTENT)).rejects.toThrow("device record changed");
      expect(f.read).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 0, 26, "27"])("requires numeric station device type 27 instead of %s", (deviceType) => {
    const f = fixture();
    f.device.raw = { ...(f.device.raw as object), device_type: deviceType };
    expect(f.internals.portalPayloadReaderFor(STATION, CONTEXT)).toBeUndefined();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("qualifies a station record without a station parent", () => {
    const f = fixture();
    f.device.stationSn = undefined;
    expect(f.internals.portalPayloadReaderFor(STATION, CONTEXT)).toBeDefined();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "", 27])("falls back to the current identity for member admin %s", async (admin) => {
    const f = fixture("T9000", false, true);
    f.device.raw = { ...(f.device.raw as object), member: { admin_user_id: admin } };
    const provider = f.internals.portalPayloadReaderFor(STATION, CONTEXT)!;
    await expect(provider.readPayload(INTENT)).resolves.toBe(OBSERVATION);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(
      { stationSn: STATION, adminUserId: "synthetic-user" },
      INTENT,
      expect.any(Function),
      undefined,
    );
    expect(f.read.mock.calls[0]![2]()).toBe(true);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects a read without a member admin or current account identity", async () => {
    const f = fixture("T9000", false, true);
    f.rtcIdentity.mockReturnValue(undefined);
    const provider = f.internals.portalPayloadReaderFor(STATION, CONTEXT)!;
    await expect(provider.readPayload(INTENT)).rejects.toThrow("known logged-in station");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "model",
    "firmware",
    "nested firmware",
    "device type",
    "attached parent",
    "parent removed",
    "parent added",
    "admin",
    "fallback admin",
    "record replacement",
    "record removed",
  ])("invalidates the caller callback during a read after %s drift", async (change) => {
    const f = fixture("T9000", change === "nested firmware", change === "fallback admin");
    if (change === "parent added") f.device.stationSn = undefined;
    const provider = f.internals.portalPayloadReaderFor(STATION, CONTEXT)!;
    let finish: (() => void) | undefined;
    f.read.mockImplementationOnce((_route, _intent, isRecordCurrent) => {
      expect(isRecordCurrent()).toBe(true);
      return new Promise((resolve, reject) => {
        finish = () =>
          isRecordCurrent() ? resolve(OBSERVATION) : reject(new Error("synthetic caller record changed"));
      });
    });
    const pending = provider.readPayload(INTENT);
    const assertion = expect(pending).rejects.toThrow("caller record changed");
    if (change === "model") f.device.model = "T9000-synthetic-other";
    if (change === "firmware") f.device.raw = { ...(f.device.raw as object), main_sw_version: "synthetic-other" };
    if (change === "nested firmware")
      f.device.raw = { ...(f.device.raw as object), deviceParams: { main_sw_version: "synthetic-other" } };
    if (change === "device type") f.device.raw = { ...(f.device.raw as object), device_type: 26 };
    if (change === "attached parent") f.device.stationSn = "T9000P0000000001";
    if (change === "parent removed") f.device.stationSn = undefined;
    if (change === "parent added") f.device.stationSn = STATION;
    if (change === "admin")
      f.device.raw = { ...(f.device.raw as object), member: { admin_user_id: "synthetic-other-admin" } };
    if (change === "fallback admin") f.identity.userId = "synthetic-other-user";
    if (change === "record replacement") f.internals.registry.devices = [{ ...f.device }];
    if (change === "record removed") f.internals.registry.devices = [];
    expect(f.read.mock.calls[0]![2]()).toBe(false);
    finish!();
    await assertion;
    expect(f.write).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.context).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("passes transport failure through without metadata refresh or a write fallback", async () => {
    const f = fixture();
    const provider = f.internals.portalPayloadReaderFor(STATION, CONTEXT)!;
    f.read.mockRejectedValueOnce(new Error("synthetic missing idle owner"));
    await expect(provider.readPayload(INTENT)).rejects.toThrow("synthetic missing idle owner");
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.context).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
