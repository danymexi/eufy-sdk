/**
 * The live pull of one camera behind a **HomeBase S1 Pro (T9000)**, over the station's control session.
 *
 * Wire, as the portal sends it on the command data channel:
 *
 *  - Start is inner `cmd 1003` in a `1350` SET_PAYLOAD on the station channel `255`. The header byte the
 *    codec names `isResponse` carries the portal's `streamId`, `1` for a live view, and `chn_list` is an
 *    array of `{index, chn, sensor, isUps, isClicked}` objects. Stop is inner `cmd 1004`, the same way.
 *  - Video arrives on the live link as portal packets `1300` on channel `100 + play id`; a single-camera
 *    view is play id `1`, whatever the camera's own channel. Each body is a short hub prefix, then Annex
 *    B HEVC. A frame can open with a 16-byte hub unit behind a start code of its own, ahead of the video:
 *    a frame counter, then the picture size as u16 LE width and height, then 8 more bytes. See
 *    {@link splitFrameBody}.
 *  - A raw, unframed keepalive (a 20-byte prefix and a bare `XZYH 1139`) goes out every ~29 s; the hub
 *    echoes it.
 *
 * The station serves one live view at a time on that play slot, so the router builds at most one pull per
 * station. This is a {@link LiveStreamHandle}: fan-out, backpressure and the start deadline are the
 * shared live source's.
 */
import { EventEmitter } from "node:events";
import type { LiveStreamHandle, LiveVideoFrame } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { hasIdr } from "../p2p/annexb.js";
import type { RtcSession } from "./session.js";
import {
  buildPortalPacket,
  parsePortalHeader,
  parsePortalPacket,
  PORTAL_HEADER_LENGTH,
  type SegmentCounter,
} from "./portal-packet.js";

/** The SET_PAYLOAD envelope. */
const PORTAL_CMD_SET_PAYLOAD = 1350;
/** The channel a station-wide command is addressed to. */
const PORTAL_STATION_CHANNEL = 255;
/** Inner `cmd` that starts a live view. */
const LIVE_START = 1003;
/** Inner `cmd` that stops it. */
const LIVE_STOP = 1004;
/** Portal packet id of a video frame. */
const LIVE_MEDIA = 1300;
/** The media channel of a single-camera view: `100` plus play id `1`. */
const LIVE_MEDIA_CHANNEL = 101;
/** The portal's `streamId` for a live view, in the header byte the codec names `isResponse`. */
const LIVE_STREAM_ID = 1;
/** How often the raw keepalive goes out. */
const KEEPALIVE_MS = 29_000;
/** The portal's 36-byte data-channel keepalive: a 20-byte prefix and a bare `XZYH 1139`. */
const KEEPALIVE = Buffer.from("0009000010000000000000006300000000000000585a5948730400000000000000000002", "hex");
const ANNEX_B_START = Buffer.from([0, 0, 0, 1]);

/** The length of the hub unit that can open a frame, after its start code. */
const HUB_UNIT_LENGTH = 16;

/**
 * Split a `1300` body into the Annex B video and the picture size the hub states. The video starts at the
 * first start code; when the unit behind it is exactly {@link HUB_UNIT_LENGTH} bytes long (the next start
 * code follows it directly) it is the hub's own, carrying the size at bytes 4 to 7, and the video starts
 * after it.
 */
export function splitFrameBody(body: Buffer): { data: Buffer; width?: number; height?: number } {
  const at = body.indexOf(ANNEX_B_START);
  if (at < 0) return { data: body.subarray(body.length) };
  const next = at + ANNEX_B_START.length + HUB_UNIT_LENGTH;
  if (body.length < next + ANNEX_B_START.length || !body.subarray(next, next + 4).equals(ANNEX_B_START))
    return { data: body.subarray(at) };
  const width = body.readUInt16LE(at + 8);
  const height = body.readUInt16LE(at + 10);
  return { data: body.subarray(next), width, height };
}

export interface RtcLiveOptions {
  session: RtcSession;
  /** The session's segment counter, shared with the command router so segments never collide. */
  seg: SegmentCounter;
  stationSn: string;
  /** The camera's `device_channel` on the station. */
  channel: number;
  /** The station's `member.admin_user_id`. */
  accountId: string;
  logger?: Logger;
}

/**
 * One camera's live pull. `start()` sends the start; a non-zero start ACK or a closed session ends it with
 * `error`, and `stop()` sends the stop. Frames are `h265` Annex B, keyframes being IDRs.
 */
export class RtcLiveStream extends EventEmitter implements LiveStreamHandle {
  private running = false;
  private startSegment = -1;
  private keepalive?: ReturnType<typeof setInterval>;
  private width = 0;
  private height = 0;
  private readonly onMedia = (frame: Buffer) => this.onMediaFrame(frame);
  private readonly onCommand = (frame: Buffer, linkType: number) => this.onCommandFrame(frame, linkType);
  private readonly onClose = () => this.fail(new Error(`rtc live ${this.tag}: session closed`));

  constructor(private readonly opts: RtcLiveOptions) {
    super();
  }

  private get tag(): string {
    return `${this.opts.stationSn}#${this.opts.channel}`;
  }

  start(): this {
    if (this.running) return this;
    const { session, seg, accountId } = this.opts;
    this.running = true;
    session.on("mediaData", this.onMedia);
    session.on("commandData", this.onCommand);
    session.on("close", this.onClose);
    this.startSegment = seg.next();
    const sent = session.sendCommand(
      buildPortalPacket({
        commandId: PORTAL_CMD_SET_PAYLOAD,
        channel: PORTAL_STATION_CHANNEL,
        segment: this.startSegment,
        isResponse: LIVE_STREAM_ID,
        payload: {
          account_id: accountId,
          cmd: LIVE_START,
          payload: {
            ClientOS: "WEB",
            entrytype: 0,
            camera_type: 0,
            key: "",
            msg_id: 116,
            audio_chn: -1,
            streamtype: 2,
            stitch_mode: 1,
            chn_list: [{ index: 0, chn: this.opts.channel, sensor: 0, isUps: 0, isClicked: true }],
            pip_cord: { x1: 0, y1: 0, x2: 0, y2: 0 },
            station_video_type: 6,
            play_id: 1,
          },
        },
      }),
    );
    if (!sent) {
      queueMicrotask(() => this.fail(new Error(`rtc live ${this.tag}: command channel not open`)));
      return this;
    }
    this.keepalive = setInterval(() => {
      if (!session.sendRaw(KEEPALIVE)) this.opts.logger?.warn?.(`[rtc] ${this.tag} keepalive not sent`);
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
    this.opts.logger?.debug?.(`[rtc] ${this.tag} live start sent`);
    return this;
  }

  stop(): void {
    if (!this.running) return;
    this.teardown();
    const { session, seg, accountId } = this.opts;
    session.sendCommand(
      buildPortalPacket({
        commandId: PORTAL_CMD_SET_PAYLOAD,
        channel: PORTAL_STATION_CHANNEL,
        segment: seg.next(),
        isResponse: LIVE_STREAM_ID,
        payload: { account_id: accountId, cmd: LIVE_STOP, payload: {} },
      }),
    );
    this.emit("stop");
  }

  private teardown(): void {
    this.running = false;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
    const { session } = this.opts;
    session.off("mediaData", this.onMedia);
    session.off("commandData", this.onCommand);
    session.off("close", this.onClose);
  }

  private fail(err: Error): void {
    if (!this.running) return;
    this.teardown();
    this.emit("error", err);
  }

  /** The start's ACK: a non-zero result code ends the pull. */
  private onCommandFrame(frame: Buffer, linkType: number): void {
    const p = parsePortalPacket(frame, linkType);
    if (!p?.isResponse || p.segment !== this.startSegment || p.commandId !== PORTAL_CMD_SET_PAYLOAD) return;
    if (p.errCode !== 0) this.fail(new Error(`rtc live ${this.tag}: start refused (err ${p.errCode})`));
  }

  private onMediaFrame(frame: Buffer): void {
    const h = parsePortalHeader(frame);
    if (!h || h.commandId !== LIVE_MEDIA || h.channel !== LIVE_MEDIA_CHANNEL) return;
    const { data, width, height } = splitFrameBody(
      frame.subarray(PORTAL_HEADER_LENGTH, PORTAL_HEADER_LENGTH + h.paramLength),
    );
    if (width && height) {
      this.width = width;
      this.height = height;
    }
    const out: LiveVideoFrame = {
      codec: "h265",
      data,
      keyframe: hasIdr(data, "h265"),
      width: this.width,
      height: this.height,
    };
    this.emit("video", out);
  }
}
