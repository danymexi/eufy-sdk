import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { LiveVideoFrame } from "../../../core/contracts.js";
import { RtcLiveStream, splitFrameBody } from "../live.js";
import { buildPortalHeader, parsePortalHeader, PORTAL_HEADER_LENGTH, SegmentCounter } from "../portal-packet.js";
import type { RtcSession } from "../session.js";

const START = Buffer.from([0, 0, 0, 1]);
/** A 16-byte hub unit: frame counter, width 1920, height 1080, 8 more bytes. */
const HUB_UNIT = Buffer.from("0200000080073804bfa81e02a1010000", "hex");
const IDR = Buffer.concat([START, Buffer.from("2601af0e", "hex")]);
const TRAIL = Buffer.concat([START, Buffer.from("0201d00a", "hex")]);

class FakeSession extends EventEmitter {
  sent: Buffer[] = [];
  raw: Buffer[] = [];
  open = true;
  sendCommand(pkt: Buffer): boolean {
    if (!this.open) return false;
    this.sent.push(pkt);
    return true;
  }
  sendRaw(bytes: Buffer): boolean {
    this.raw.push(bytes);
    return this.open;
  }
}

function stream(session = new FakeSession()) {
  const live = new RtcLiveStream({
    session: session as unknown as RtcSession,
    seg: new SegmentCounter(),
    stationSn: "T9000P0000000001",
    channel: 5,
    accountId: "synthetic-admin",
  });
  return { live, session };
}

const media = (body: Buffer, channel = 101) =>
  Buffer.concat([buildPortalHeader(1300, body.length, channel, 0, 0), body]);

describe("splitFrameBody", () => {
  it("drops the hub unit that opens a frame and reads the picture size from it", () => {
    const body = Buffer.concat([Buffer.from("aabb", "hex"), START, HUB_UNIT, IDR]);
    expect(splitFrameBody(body)).toEqual({ data: IDR, width: 1920, height: 1080 });
  });

  it("keeps a frame that opens with video as it is", () => {
    expect(splitFrameBody(Buffer.concat([Buffer.from("aabb", "hex"), TRAIL]))).toEqual({ data: TRAIL });
  });
});

describe("RtcLiveStream", () => {
  it("starts with the portal's 1003 on the station channel, stream id in the header, and stops with 1004", () => {
    const { live, session } = stream();
    live.start();
    const start = parsePortalHeader(session.sent[0]!)!;
    expect(start).toMatchObject({ commandId: 1350, channel: 255, isResponse: 1 });
    const body = JSON.parse(session.sent[0]!.subarray(PORTAL_HEADER_LENGTH).toString()) as {
      cmd: number;
      payload: { chn_list: Array<{ chn: number }> };
    };
    expect(body.cmd).toBe(1003);
    expect(body.payload.chn_list[0]!.chn).toBe(5);
    const stopped = vi.fn();
    live.on("stop", stopped);
    live.stop();
    expect(JSON.parse(session.sent[1]!.subarray(PORTAL_HEADER_LENGTH).toString()).cmd).toBe(1004);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(session.listenerCount("mediaData")).toBe(0);
  });

  it("emits h265 frames off the play slot, keyframes being IDRs, and ignores other channels", () => {
    const { live, session } = stream();
    const frames: LiveVideoFrame[] = [];
    live.on("video", (f: LiveVideoFrame) => frames.push(f));
    live.start();
    session.emit("mediaData", media(Buffer.concat([Buffer.from("aabb", "hex"), START, HUB_UNIT, IDR])));
    session.emit("mediaData", media(Buffer.concat([Buffer.from("aabb", "hex"), TRAIL])));
    session.emit("mediaData", media(TRAIL, 102));
    expect(frames.map((f) => [f.codec, f.keyframe, f.width, f.height, f.data.toString("hex")])).toEqual([
      ["h265", true, 1920, 1080, IDR.toString("hex")],
      ["h265", false, 1920, 1080, TRAIL.toString("hex")],
    ]);
    live.stop();
  });

  it("ends with an error on a refused start, and on a closed session", () => {
    const refused = stream();
    const errors: string[] = [];
    refused.live.on("error", (e: Error) => errors.push(e.message));
    refused.live.start();
    const segment = parsePortalHeader(refused.session.sent[0]!)!.segment;
    const code = Buffer.alloc(4);
    code.writeInt32LE(1, 0);
    refused.session.emit("commandData", Buffer.concat([buildPortalHeader(1350, 4, 255, segment, 1), code]), 1);
    expect(errors).toEqual(["rtc live T9000P0000000001#5: start refused (err 1)"]);
    expect(refused.session.listenerCount("commandData")).toBe(0);

    const closed = stream();
    closed.live.on("error", (e: Error) => errors.push(e.message));
    closed.live.start();
    closed.session.emit("close");
    expect(errors.at(-1)).toBe("rtc live T9000P0000000001#5: session closed");
  });

  it("sends the raw keepalive every 29 s while running", () => {
    vi.useFakeTimers();
    try {
      const { live, session } = stream();
      live.start();
      vi.advanceTimersByTime(29_000);
      expect(session.raw).toHaveLength(1);
      expect(session.raw[0]!.subarray(20, 24).toString()).toBe("XZYH");
      live.stop();
      vi.advanceTimersByTime(60_000);
      expect(session.raw).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
