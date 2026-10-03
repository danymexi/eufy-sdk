import { STORAGE, type StorageActions } from "../storage.js";
import { buildActions } from "../index.js";
import type { CommandContext } from "../types.js";
import type { PortalPayloadObservation, PortalPayloadReader } from "../../../core/contracts.js";

const MIB = 1_048_576;
const ARRIVAL = 1_700_000_000_000;

function fixture(hdd: unknown = { disk_size_1024: 100, video_used: 60, system_size: 10, system_size_data: 5 }) {
  const observation: PortalPayloadObservation = {
    payload: { cmd: 1307, payload: { cmd: 11001, mIntRet: 0, hdd_info: hdd } },
    receivedAtMs: ARRIVAL,
    correlation: "time-associated",
    exactlyCorrelated: false,
  };
  const readPayload = vi.fn<PortalPayloadReader["readPayload"]>().mockResolvedValue(observation);
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const ctx: CommandContext = {
    codec: "station",
    model: "T9000",
    firmwareVersion: "4.4.0.4",
    homeBaseAttached: false,
    channel: 0,
    paramIds: new Set(),
  };
  const bind = (overrides: Partial<CommandContext> = {}, reader: PortalPayloadReader | undefined = { readPayload }) =>
    STORAGE.actions!({
      ctx: { ...ctx, ...overrides },
      sink: { dispatch },
      read: () => undefined,
      portalPayload: reader,
    }) as StorageActions;
  return { observation, readPayload, dispatch, bind, ctx };
}

describe("qualified HDD telemetry", () => {
  it("binds without I/O and explicitly reads the qualified dialect with its abort signal", async () => {
    const { readPayload, dispatch, bind } = fixture();
    const actions = bind();
    expect(readPayload).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    await expect(actions.getHddTelemetry!(signal)).resolves.toEqual({
      totalBytes: 100 * MIB,
      usedBytes: 75 * MIB,
      availableBytes: 25 * MIB,
      videoBytes: 60 * MIB,
      systemBytes: 15 * MIB,
      usedPercent: 75,
      observedAtMs: ARRIVAL,
      correlation: "time-associated",
      exactlyCorrelated: false,
    });
    expect(readPayload).toHaveBeenCalledExactlyOnceWith(
      { kind: "set-payload", cmd: 1307, channel: 0, mValue3: 0, payload: { version: 0, cmd: 11001 } },
      signal,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { model: "T8010" },
    { model: "T8030" },
    { model: "T9000-extra" },
    { model: undefined },
    { homeBaseAttached: true },
    { firmwareVersion: "4.4.0.5" },
    { firmwareVersion: undefined },
  ])("omits the read for unsupported evidence %o", (overrides) => {
    const { bind, readPayload } = fixture();
    expect(bind(overrides).getHddTelemetry).toBeUndefined();
    expect(readPayload).not.toHaveBeenCalled();
  });

  it("omits the read without an injected provider", () => {
    const { ctx } = fixture();
    const actions = STORAGE.actions!({ ctx, sink: { dispatch: vi.fn() }, read: () => undefined }) as StorageActions;
    expect(actions.getHddTelemetry).toBeUndefined();
  });

  it("wires the storage accessor through the capability barrel without scalar parameters", async () => {
    const { ctx, readPayload } = fixture();
    const actions = buildActions(["storage"], {
      ctx,
      sink: { dispatch: vi.fn() },
      read: () => undefined,
      portalPayload: { readPayload },
    });
    await expect(actions.storage?.getHddTelemetry?.()).resolves.toMatchObject({ usedPercent: 75 });
    expect(STORAGE.properties).toEqual([]);
  });

  it("accepts the body layout and numeric strings without using nominal or alternate usage fields", async () => {
    const { observation, bind } = fixture();
    observation.payload = {
      cmd: 1307,
      payload: {
        cmd: 11001,
        body: {
          hdd_info: {
            disk_size_1024: "100",
            video_used: "60",
            system_size: "10",
            system_size_data: "5",
            disk_size: 999,
            disk_used: 1,
          },
        },
      },
    };
    await expect(bind().getHddTelemetry!()).resolves.toMatchObject({ totalBytes: 100 * MIB, usedBytes: 75 * MIB });
  });

  it("preserves complete zero usage and absent or invalid deferred media", async () => {
    const { observation, bind } = fixture({ disk_size_1024: 8, video_used: 0, system_size: 0, system_size_data: 0 });
    const envelope = observation.payload as { payload: Record<string, unknown> };
    envelope.payload.emmc_info = { disk_size: false, health: "unqualified" };
    await expect(bind().getHddTelemetry!()).resolves.toMatchObject({
      usedBytes: 0,
      usedPercent: 0,
      availableBytes: 8 * MIB,
    });
  });

  it.each([undefined, null, false, -1, NaN, Infinity, "", " 3", "3e2", {}, [], Number.MAX_SAFE_INTEGER, 1 / (MIB * 2)])(
    "answers undefined for invalid or inexact byte quantities %j",
    async (invalid) => {
      const { bind } = fixture({ disk_size_1024: 100, video_used: invalid, system_size: 10, system_size_data: 5 });
      await expect(bind().getHddTelemetry!()).resolves.toBeUndefined();
    },
  );

  it.each([
    {},
    { disk_size_1024: 0, video_used: 0, system_size: 0, system_size_data: 0 },
    { disk_size_1024: 10, video_used: 11, system_size: 0, system_size_data: 0 },
    { disk_size_1024: 100, video_used: 60, system_size: 10 },
    { disk_size: 100, disk_used: 75 },
    [],
    null,
  ])("answers undefined for incomplete or impossible HDD %j", async (hdd) => {
    await expect(fixture(hdd).bind().getHddTelemetry!()).resolves.toBeUndefined();
  });

  it.each([
    { cmd: 1306, payload: { cmd: 11001, hdd_info: {} } },
    { cmd: 1307, payload: { cmd: 11002, hdd_info: {} } },
    { cmd: 1307, payload: { mIntRet: "0", hdd_info: {} } },
    { cmd: 1307, payload: { mIntRet: 1, hdd_info: {} } },
    { cmd: 1307, payload: { hdd_info: {}, body: {} } },
    { cmd: 1307, payload: { body: [] } },
    { cmd: 1307, payload: [] },
    null,
  ])("answers undefined for unqualified envelopes %j", async (payload) => {
    const { observation, bind } = fixture();
    observation.payload = payload;
    await expect(bind().getHddTelemetry!()).resolves.toBeUndefined();
  });

  it.each([0, -1, NaN, Infinity, 1.5])("answers undefined for invalid arrival %j", async (receivedAtMs) => {
    const { observation, bind } = fixture();
    observation.receivedAtMs = receivedAtMs;
    await expect(bind().getHddTelemetry!()).resolves.toBeUndefined();
  });

  it("preserves arrival on unchanged observations and does not mutate the evidence", async () => {
    const { observation, bind, readPayload } = fixture();
    const before = structuredClone(observation);
    const actions = bind();
    const first = await actions.getHddTelemetry!();
    const second = await actions.getHddTelemetry!();
    expect(first).toEqual(second);
    expect(second?.observedAtMs).toBe(ARRIVAL);
    expect(observation).toEqual(before);
    expect(readPayload).toHaveBeenCalledTimes(2);
  });

  it("propagates provider failure without retry or a control dispatch", async () => {
    const { bind, readPayload, dispatch } = fixture();
    const failure = new Error("Existing session unavailable");
    readPayload.mockRejectedValue(failure);
    await expect(bind().getHddTelemetry!()).rejects.toBe(failure);
    expect(readPayload).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
