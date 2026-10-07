/**
 * The PTCS packetiser: a clean-room implementation of the framing the portal wraps around every portal
 * packet on `WebrtcDataChannel` (the portal's `libsctp` module). Nothing of that module ships here.
 *
 * Every wire packet is the same size, `28 + payload bytes`, zero-padded. The size is carried per packet,
 * so the receiver accepts any:
 *
 *   0   "PTCS"
 *   4   u8   3              constant
 *   5   u8   channel        the logical channel the frame belongs to: 0 command, 2 notify
 *   6   u16  sequence       a frame counter: every packet of a frame carries the same value, and it
 *                           steps once per frame
 *   8   u32  frame id       one value per frame, shared by all its packets — the portal uses a ms clock
 *   12  u32  frame length   total bytes of the frame
 *   16  u16  packet index   0-based position of this packet in the frame
 *   18  u16  0x4000 | (last ? 0x0400 : 0) | payload length      (payload ≤ 1023 fits the low bits)
 *   20  8 × 0
 *   28  payload             `payload length` bytes, then zeros to the packet size
 *
 * The format carries no forward error correction. The receiver completes a frame only when every index
 * up to the `last` one is present and their lengths add up. Incomplete frames are bounded by payload,
 * fragment and frame counts, and dropped at their idle or absolute {@link PTCS_STALE_MS} deadline.
 */

import { isPortalPacket, PortalLinkType } from "./portal-packet.js";

const MAGIC = Buffer.from("PTCS", "ascii");
export const PTCS_HEADER_LENGTH = 28;
/** The portal's packet payload size: 1028-byte packets, 1000 bytes of payload after the header. */
export const PTCS_DEFAULT_PAYLOAD_BYTES = 1000;
const FLAG_BASE = 0x4000;
const FLAG_LAST = 0x0400;
const LENGTH_MASK = 0x03ff;

/** SCTP channel ids as the portal numbers them, and the link type each maps to on receive. */
export const PtcsChannel = {
  COMMAND: 0,
  NOTIFY: 2,
} as const;

/** The link type a received frame belongs to: notify on the notify channel, command otherwise. */
export function linkTypeForChannel(channel: number): number {
  return channel === PtcsChannel.NOTIFY ? PortalLinkType.NOTIFY : PortalLinkType.COMMAND;
}

/** How long a partly received frame is kept before it is dropped. */
export const PTCS_STALE_MS = 15_000;

/** Receive resource limits, independent of device frame-size claims. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_FRAMES = 32;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_FRAGMENTS_PER_FRAME = 16_384;

export interface PtcsHeader {
  channel: number;
  /** The sender's running packet counter — see the header map. */
  sequence: number;
  frameId: number;
  frameLength: number;
  index: number;
  last: boolean;
  payloadLength: number;
}

export function parsePtcsHeader(packet: Buffer): PtcsHeader | undefined {
  if (packet.length < PTCS_HEADER_LENGTH || packet.subarray(0, 4).compare(MAGIC) !== 0) return undefined;
  const flags = packet.readUInt16LE(18);
  return {
    channel: packet[5]!,
    sequence: packet.readUInt16LE(6),
    frameId: packet.readUInt32LE(8),
    frameLength: packet.readUInt32LE(12),
    index: packet.readUInt16LE(16),
    last: (flags & FLAG_LAST) !== 0,
    payloadLength: flags & LENGTH_MASK,
  };
}

/** Split one frame into wire packets. */
export function packetize(
  frame: Buffer,
  opts: { channel?: number; frameId: number; payloadBytes?: number; sequence?: number },
): Buffer[] {
  const size = opts.payloadBytes ?? PTCS_DEFAULT_PAYLOAD_BYTES;
  if (size <= 0 || size > LENGTH_MASK) throw new RangeError(`PTCS payload size ${size} out of range`);
  const channel = opts.channel ?? PtcsChannel.COMMAND;
  const count = Math.max(1, Math.ceil(frame.length / size));
  const sequence = (opts.sequence ?? 0) & 0xffff;
  const packets: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = frame.subarray(i * size, Math.min(frame.length, (i + 1) * size));
    const last = i === count - 1;
    const packet = Buffer.alloc(PTCS_HEADER_LENGTH + size);
    MAGIC.copy(packet, 0);
    packet[4] = 3;
    packet[5] = channel & 0xff;
    packet.writeUInt16LE(sequence, 6);
    packet.writeUInt32LE(opts.frameId >>> 0, 8);
    packet.writeUInt32LE(frame.length >>> 0, 12);
    packet.writeUInt16LE(i, 16);
    packet.writeUInt16LE(FLAG_BASE | (last ? FLAG_LAST : 0) | chunk.length, 18);
    chunk.copy(packet, PTCS_HEADER_LENGTH);
    packets.push(packet);
  }
  return packets;
}

interface Partial {
  channel: number;
  sequence: number;
  frameLength: number;
  chunks: Map<number, Buffer>;
  bytes: number;
  maxIndex: number;
  lastIndex?: number;
  created: number;
  touched: number;
}

/**
 * Bounded, out-of-order assembly per (channel, id). Identical duplicates are ignored; conflicting
 * metadata or fragments discard the affected assembly. Capacity rejects new frames without evicting
 * existing ones. Exceeding the payload budget discards the assembly receiving that fragment.
 */
export class PtcsReassembler {
  private readonly partials = new Map<string, Partial>();
  private retainedBytes = 0;

  constructor(
    private readonly onFrame: (frame: Buffer, channel: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  push(packet: Buffer): boolean {
    const h = parsePtcsHeader(packet);
    if (!h) return false;
    const now = this.now();
    this.expireAt(now);
    const key = `${h.channel}:${h.frameId}`;
    const body = packet.subarray(PTCS_HEADER_LENGTH, PTCS_HEADER_LENGTH + h.payloadLength);
    if (
      body.length !== h.payloadLength ||
      h.frameLength > MAX_FRAME_BYTES ||
      h.index >= MAX_FRAGMENTS_PER_FRAME ||
      (h.frameLength === 0
        ? h.index !== 0 || !h.last || body.length !== 0
        : body.length === 0 || h.index >= h.frameLength)
    ) {
      this.drop(key);
      return false;
    }
    let p = this.partials.get(key);
    if (
      p &&
      (p.frameLength !== h.frameLength ||
        p.sequence !== h.sequence ||
        (p.lastIndex !== undefined && (h.index > p.lastIndex || (h.last && h.index !== p.lastIndex))) ||
        (h.last && h.index < p.maxIndex))
    ) {
      this.drop(key);
      return false;
    }
    const previous = p?.chunks.get(h.index);
    if (previous) {
      if (previous.equals(body) && h.last === (p!.lastIndex === h.index)) return true;
      this.drop(key);
      return false;
    }
    if ((p?.bytes ?? 0) + body.length > h.frameLength || this.retainedBytes + body.length > MAX_BUFFERED_BYTES) {
      this.drop(key);
      return false;
    }
    if (!p) {
      if (this.partials.size >= MAX_PENDING_FRAMES) return false;
      p = {
        channel: h.channel,
        sequence: h.sequence,
        frameLength: h.frameLength,
        chunks: new Map(),
        bytes: 0,
        maxIndex: h.index,
        created: now,
        touched: now,
      };
      this.partials.set(key, p);
    }
    p.touched = now;
    p.maxIndex = Math.max(p.maxIndex, h.index);
    p.chunks.set(h.index, Buffer.from(body));
    p.bytes += body.length;
    this.retainedBytes += body.length;
    if (h.last) p.lastIndex = h.index;
    if (p.lastIndex === undefined || p.chunks.size !== p.lastIndex + 1) return true;
    this.drop(key);
    if (p.bytes !== p.frameLength) return false;
    const parts: Buffer[] = [];
    for (let i = 0; i <= p.lastIndex; i++) parts.push(p.chunks.get(i)!);
    this.onFrame(Buffer.concat(parts, p.bytes), p.channel);
    return true;
  }

  /** Drop frames at their idle or absolute deadline. Also performed before admitting a packet. */
  expire(): void {
    this.expireAt(this.now());
  }

  private expireAt(now: number): void {
    for (const [key, p] of this.partials) {
      if (now - p.touched >= PTCS_STALE_MS || now - p.created >= PTCS_STALE_MS) {
        this.drop(key);
      }
    }
  }

  private drop(key: string): void {
    const p = this.partials.get(key);
    if (!p) return;
    this.retainedBytes -= p.bytes;
    this.partials.delete(key);
  }
}

/** Frame ids the way the portal draws them — a millisecond clock, nudged forward on a collision. */
export function frameIdClock(now: () => number = Date.now): () => number {
  let last = 0;
  return () => {
    let id = now() >>> 0;
    if (id <= last) id = (last + 1) >>> 0;
    last = id;
    return id;
  };
}

/**
 * The framer between portal packets and the data channel: PTCS out, PTCS in, with the portal's channel
 * mapping. An inbound bare `XZYH` packet, which the hub sometimes answers with, passes through as a
 * command frame. Frame ids are a millisecond clock and the frame counter starts at 0.
 */
export class PtcsFramer {
  private onWire?: (packet: Buffer) => void;
  private onFrame?: (frame: Buffer, linkType: number) => void;
  private reassembler?: PtcsReassembler;
  private sweep?: NodeJS.Timeout;
  private ready = false;
  private readonly nextFrameId = frameIdClock();
  private sequence = 0;

  /** Arm the two callbacks; `sendFrame` may be called from here on. */
  init(onWirePacket: (packet: Buffer) => void, onFrame: (frame: Buffer, linkType: number) => void): void {
    this.onWire = onWirePacket;
    this.onFrame = onFrame;
    this.reassembler = new PtcsReassembler((frame, channel) => this.onFrame?.(frame, linkTypeForChannel(channel)));
    this.sweep = setInterval(() => this.reassembler?.expire(), 1_000);
    this.sweep.unref?.();
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  sendFrame(portalPacket: Buffer): void {
    if (!this.ready) throw new Error("PTCS framer not initialised");
    const packets = packetize(portalPacket, { frameId: this.nextFrameId(), sequence: this.sequence });
    this.sequence = (this.sequence + 1) & 0xffff;
    for (const packet of packets) this.onWire?.(packet);
  }

  recvPacket(wirePacket: Buffer): void {
    if (!this.ready) return;
    if (isPortalPacket(wirePacket)) {
      this.onFrame?.(wirePacket, PortalLinkType.COMMAND);
      return;
    }
    this.reassembler?.push(wirePacket);
  }

  destroy(): void {
    this.ready = false;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
    this.reassembler = undefined;
    this.onWire = undefined;
    this.onFrame = undefined;
  }
}
