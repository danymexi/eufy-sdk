import { describe, expect, it, vi } from "vitest";
import { DeviceType } from "../../model/device-types.js";
import { EufyMega } from "../eufy-mega.js";

/**
 * `readStationTable` and `readStationImage` resolve which station, which transport and which account
 * id, and hand the read to that transport, which owns assembling the reply and is specced with it.
 * These cover the facade's half: a HomeBase S1 Pro (T9000) reads over its control channel, any other
 * station over its P2P session, and both refuse a station they cannot name.
 */
const HUB = "T8010P0000000000";
const T9000 = "T9000P0000000001";
const CAMERA = "T8000P0000000002";
const THUMB = "/zx/hdd_data0/Camera020000/event/202604/20260410/20260410153000_thumb.jpg";
const ROWS = [{ device_sn: CAMERA, record_id: 7, thumb_path: THUMB }];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function harness(opts: { adminUserId?: string; session?: null } = {}) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", autoRealtime: false, pollMs: 0 });
  const readDatabase = vi.fn().mockResolvedValue(ROWS);
  const readImage = vi.fn().mockResolvedValue(JPEG);
  const session = opts.session === null ? null : { readDatabase, readImage };
  const internals = eufy as unknown as {
    registry: { list: () => unknown[] };
    rtc: { readTable: unknown; readImage: unknown };
    p2p: {
      stationKeyOf: (sn: string) => string;
      ensureStation: (sn: string, signal?: AbortSignal) => Promise<void>;
      getSessions: () => Map<string, unknown>;
    };
  };
  const member = { admin_user_id: opts.adminUserId ?? "ADMIN-0000" };
  vi.spyOn(internals.registry, "list").mockReturnValue([
    { sn: HUB, model: "T8010", raw: { device_type: DeviceType.STATION, member } },
    { sn: T9000, model: "T9000", raw: { device_type: DeviceType.STATION_9000, member } },
    { sn: CAMERA, model: "T8425", stationSn: T9000, raw: { parent_sn: T9000, device_channel: 2 } },
  ]);
  const rtcTable = vi
    .spyOn(internals.rtc as { readTable: () => Promise<unknown[]> }, "readTable")
    .mockResolvedValue(ROWS);
  const rtcImage = vi.spyOn(internals.rtc as { readImage: () => Promise<Buffer> }, "readImage").mockResolvedValue(JPEG);
  internals.p2p = {
    stationKeyOf: (sn: string) => (sn === CAMERA ? T9000 : sn),
    ensureStation: async () => undefined,
    getSessions: () => new Map(session ? [[HUB, session]] : []),
  };
  return { eufy, readDatabase, readImage, rtcTable, rtcImage };
}

describe("readStationTable", () => {
  it("reads a HomeBase's table over its P2P session, scoped to the station's admin id", async () => {
    const { eufy, readDatabase, rtcTable } = harness();
    const control = new AbortController();
    const query = { count: 20, start_time: "0" };
    expect(
      await eufy.readStationTable(HUB, "history_record_info", { innerCmd: 10017, query, signal: control.signal }),
    ).toEqual(ROWS);
    expect(readDatabase).toHaveBeenCalledExactlyOnceWith("history_record_info", {
      accountId: "ADMIN-0000",
      innerCmd: 10017,
      query,
      signal: control.signal,
    });
    expect(rtcTable).not.toHaveBeenCalled();
  });

  it("reads a T9000's table over its control channel, by the station route a camera on it resolves to", async () => {
    const { eufy, readDatabase, rtcTable } = harness();
    expect(await eufy.readStationTable(CAMERA, "history_record_info", { timeoutMs: 500 })).toEqual(ROWS);
    expect(rtcTable).toHaveBeenCalledExactlyOnceWith(
      { stationSn: T9000, adminUserId: "ADMIN-0000", attached: false },
      "history_record_info",
      { timeoutMs: 500 },
    );
    expect(readDatabase).not.toHaveBeenCalled();
  });

  it("refuses a station not in the device list, one stating no admin id, and one with no session", async () => {
    const { eufy: unknown, readDatabase, rtcTable } = harness();
    await expect(unknown.readStationTable("T8010P0000000009", "history_record_info")).rejects.toThrow(
      /not in the device list/,
    );
    const { eufy: unnamed } = harness({ adminUserId: "" });
    await expect(unnamed.readStationTable(T9000, "history_record_info")).rejects.toThrow(/admin_user_id/);
    await expect(unnamed.readStationTable(HUB, "history_record_info")).rejects.toThrow(/admin_user_id/);
    const { eufy: sessionless } = harness({ session: null });
    await expect(sessionless.readStationTable(HUB, "history_record_info")).rejects.toThrow(/no P2P session/);
    expect(readDatabase).not.toHaveBeenCalled();
    expect(rtcTable).not.toHaveBeenCalled();
  });
});

describe("readStationImage", () => {
  it("fetches a HomeBase's stored image over its P2P session", async () => {
    const { eufy, readImage, rtcImage } = harness();
    expect((await eufy.readStationImage(HUB, THUMB, { timeoutMs: 500 })).equals(JPEG)).toBe(true);
    expect(readImage).toHaveBeenCalledExactlyOnceWith(THUMB, { accountId: "ADMIN-0000", timeoutMs: 500 });
    expect(rtcImage).not.toHaveBeenCalled();
  });

  it("fetches a T9000's stored image over its control channel", async () => {
    const { eufy, readImage, rtcImage } = harness();
    const control = new AbortController();
    expect((await eufy.readStationImage(T9000, THUMB, { signal: control.signal })).equals(JPEG)).toBe(true);
    expect(rtcImage).toHaveBeenCalledExactlyOnceWith(
      { stationSn: T9000, adminUserId: "ADMIN-0000", attached: false },
      THUMB,
      { signal: control.signal },
    );
    expect(readImage).not.toHaveBeenCalled();
  });

  it("refuses a station not in the device list and one stating no admin id", async () => {
    const { eufy } = harness();
    await expect(eufy.readStationImage("T8010P0000000009", THUMB)).rejects.toThrow(/not in the device list/);
    const { eufy: unnamed, readImage, rtcImage } = harness({ adminUserId: "" });
    await expect(unnamed.readStationImage(T9000, THUMB)).rejects.toThrow(/admin_user_id/);
    expect(readImage).not.toHaveBeenCalled();
    expect(rtcImage).not.toHaveBeenCalled();
  });
});
