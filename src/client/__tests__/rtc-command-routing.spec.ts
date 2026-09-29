import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import { EufyMega } from "../eufy-mega.js";

const HUB = "T8000P0000000000";
const CAMERA = "T8000P0000000001";
const command: Command = { kind: "set-json", param: 1400, data: { time: 0, type: 2, value: 0 }, channel: 3 };

function fixture(stationModel = "T9000") {
  const client = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  const internals = client as unknown as {
    registry: { list(): EufyDevice[]; devices: EufyDevice[] };
    rtc: { dispatchCommand(sn: string, cmd: Command): Promise<void> };
    p2p: { dispatchCommand(sn: string, cmd: Command): Promise<void> };
    routeCommand(sn: string, cmd: Command): Promise<void>;
  };
  const devices = [
    { sn: HUB, model: stationModel, raw: {} },
    { sn: CAMERA, model: "T8425", stationSn: HUB, raw: { parent_sn: HUB, device_channel: 3 } },
  ] as EufyDevice[];
  internals.registry.devices = devices;
  const rtc = vi.spyOn(internals.rtc, "dispatchCommand").mockResolvedValue();
  const p2p = vi.spyOn(internals.p2p, "dispatchCommand").mockResolvedValue();
  return { internals, rtc, p2p, devices };
}

afterEach(() => vi.restoreAllMocks());

describe("station-owned RTC command routing", () => {
  it.each([HUB, CAMERA])("routes supported station topology through RTC for %s", async (sn) => {
    const { internals, rtc, p2p } = fixture();
    await internals.routeCommand(sn, command);
    expect(rtc).toHaveBeenCalledExactlyOnceWith(sn, command);
    expect(p2p).not.toHaveBeenCalled();
  });

  it("keeps another station family on its existing transport", async () => {
    const { internals, rtc, p2p } = fixture("T8030");
    await internals.routeCommand(CAMERA, command);
    expect(p2p).toHaveBeenCalledExactlyOnceWith(CAMERA, command);
    expect(rtc).not.toHaveBeenCalled();
  });

  it("does not infer RTC from a camera model without a supported station", async () => {
    const { internals, rtc, p2p, devices } = fixture();
    devices.shift();
    await internals.routeCommand(CAMERA, command);
    expect(p2p).toHaveBeenCalledExactlyOnceWith(CAMERA, command);
    expect(rtc).not.toHaveBeenCalled();
  });

  it("does not replay an ambiguous RTC failure through P2P", async () => {
    const { internals, rtc, p2p } = fixture();
    rtc.mockRejectedValueOnce(new Error("ACK timed out"));
    await expect(internals.routeCommand(CAMERA, command)).rejects.toThrow("ACK timed out");
    expect(rtc).toHaveBeenCalledTimes(1);
    expect(p2p).not.toHaveBeenCalled();
  });

  it.each(["missing", "shared", "mismatched"])("refuses a %s attached-device channel before sending", async (issue) => {
    const { internals, rtc, p2p, devices } = fixture();
    if (issue === "missing") devices[1]!.raw = { parent_sn: HUB };
    if (issue === "shared") devices.push({ ...devices[1]!, sn: "T8000P0000000002" });
    if (issue === "mismatched") devices[1]!.raw = { parent_sn: HUB, device_channel: 4 };
    await expect(internals.routeCommand(CAMERA, command)).rejects.toThrow("unambiguous attached-device channel");
    expect(rtc).not.toHaveBeenCalled();
    expect(p2p).not.toHaveBeenCalled();
  });
});
