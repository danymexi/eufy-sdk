import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

/**
 * `readImage` answers the `image` event for the path it requested.
 *
 * The station echoes the requested path in its `CMD_DATABASE_IMAGE` reply, which is the only tie
 * between a request and its bytes; an image for another path is someone else's.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const THUMB = "/zx/hdd_data0/Camera010000/event/202602/20260214/20260214093000_thumb.jpg";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0x3c), Buffer.from([0xff, 0xd9])]);

/** A connected session whose socket write is stubbed, so a spec drives the reply without one. */
function session(): { s: P2PSession; send: ReturnType<typeof vi.fn> } {
  const s = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
  const internals = s as unknown as { connectAddress: unknown; send: ReturnType<typeof vi.fn> };
  internals.connectAddress = { host: "127.0.0.1", port: 0 };
  internals.send = vi.fn();
  return { s, send: internals.send };
}

describe("P2PSession.readImage", () => {
  it("requests the path and answers the image event naming it, leaving another path's image alone", async () => {
    const { s, send } = session();
    const read = s.readImage(THUMB, { accountId: "ADMIN-0000" });
    expect(send).toHaveBeenCalledTimes(1);
    s.emit("image", { file: THUMB.replace("093000", "091500"), data: Buffer.alloc(4, 1) });
    s.emit("image", { file: THUMB, data: JPEG });
    expect((await read).equals(JPEG)).toBe(true);
    expect(s.listenerCount("image")).toBe(0);
  });

  it("rejects when no image for the path arrives in time, and when the caller aborts", async () => {
    const { s } = session();
    await expect(s.readImage(THUMB, { timeoutMs: 20 })).rejects.toThrow(/sent no image for/);
    const control = new AbortController();
    const read = s.readImage(THUMB, { signal: control.signal });
    control.abort();
    await expect(read).rejects.toThrow(/aborted/);
    expect(s.listenerCount("image")).toBe(0);
  });
});
