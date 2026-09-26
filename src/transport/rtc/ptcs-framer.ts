/**
 * The PTCS packetiser — a clean-room implementation of the framing the portal wraps around every
 * portal packet on `WebrtcDataChannel`, written from the wire behaviour of the portal's own module
 * (`libsctp`, "SCTP Version V1.0.3") observed offline: frames of 0–16 000 bytes pushed in, the packets
 * that came out, and what the receiving side reassembled from them. Nothing of that module ships here.
 *
 * Every wire packet is the same size, `28 + maxPacketBytes`, zero-padded. The live portal sends 1000 →
 * 1028-byte packets; the offline vectors were taken at 800, and the receiver accepts either, since the
 * size is carried per packet:
 *
 *   0   "PTCS"
 *   4   u8   3              constant — protocol version, as far as the vectors show
 *   5   u8   channel        the SCTP channel the frame belongs to: 0 command, 2 notify, 3 file, 4 playback, 5 live
 *   6   u16  sequence       a FRAME counter: every packet of a frame carries the same value, and it
 *                           steps once per frame. Both sources agree — the live portal sent 25, 26, 27
 *                           on three consecutive one-packet frames, and in the offline vectors each
 *                           frame's packets all carry the generator's starting 0, which a per-PACKET
 *                           counter could not produce.
 *   8   u32  frame id       one value per frame, shared by all its packets — the portal uses a ms clock
 *   12  u32  frame length   total bytes of the frame
 *   16  u16  packet index   0-based position of this packet in the frame
 *   18  u16  0x4000 | (last ? 0x0400 : 0) | payload length      (payload ≤ 1023 fits the low bits)
 *   20  8 × 0
 *   28  payload             `payload length` bytes, then zeros to the packet size
 *
 * No forward-error-correction packets were ever emitted (the module's FEC group setting changed
 * nothing), and a frame with one packet missing never reassembles — so the receiver here does the same:
 * it completes a frame only when every index up to the `last` one is present and their lengths add up.
 * Incomplete frames are subject to both idle and absolute expiry, as well as receive resource limits.
 */

import { isPortalPacket, PortalLinkType } from "./portal-packet.js";
import type { PortalFramer } from "./framer.js";

const MAGIC = Buffer.from("PTCS", "ascii");
export const PTCS_HEADER_LENGTH = 28;
/**
 * The portal's packet payload size, read off its own wire: every packet it sends on the command channel
 * is 1028 bytes, i.e. 1000 of payload after the 28-byte header.
 */
export const PTCS_DEFAULT_PAYLOAD_BYTES = 1000;
const FLAG_BASE = 0x4000;
const FLAG_LAST = 0x0400;
const LENGTH_MASK = 0x03ff;

/** SCTP channel ids as the portal numbers them, and the link type each maps to on receive. */
export const PtcsChannel = {
  COMMAND: 0,
  LIVE: 1,
  NOTIFY: 2,
  FILE: 3,
  PLAYBACK: 4,
} as const;

export function linkTypeForChannel(channel: number): number {
  switch (channel) {
    case PtcsChannel.COMMAND:
      return PortalLinkType.COMMAND;
    case PtcsChannel.NOTIFY:
      return PortalLinkType.NOTIFY;
    case PtcsChannel.FILE:
      return PortalLinkType.FILE;
    case PtcsChannel.PLAYBACK:
      return PortalLinkType.PLAYBACK;
    case 1:
    case 5:
      return PortalLinkType.LIVE;
    default:
      return PortalLinkType.INNER;
  }
}

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

/** Receive resource policy; these limits are not claims about device frame sizes. */
export interface PtcsReassemblerOptions {
  /** Maximum declared size of one frame, in bytes. Defaults to 8 MiB. */
  maxFrameBytes?: number;
  /** Maximum number of incomplete frames. Defaults to 32. */
  maxPendingFrames?: number;
  /** Maximum retained fragment payload across all incomplete frames. Defaults to 16 MiB. */
  maxBufferedBytes?: number;
  /** Maximum number of fragment positions in one frame. Defaults to 16,384. */
  maxFragmentsPerFrame?: number;
  /** Absolute assembly lifetime in milliseconds, regardless of progress. Defaults to 15,000. */
  maxAgeMs?: number;
  /** Idle lifetime in milliseconds; duplicates do not count as progress. Defaults to 15,000. */
  staleMs?: number;
  now?: () => number;
}

/**
 * Bounded, out-of-order assembly per (channel, id). Identical duplicates are ignored; conflicting
 * metadata or fragments discard the affected assembly. Capacity rejects new frames without evicting
 * existing ones. Exceeding the payload budget discards the assembly receiving that fragment.
 */
export class PtcsReassembler {
  private readonly partials = new Map<string, Partial>();
  private readonly limits: Required<Omit<PtcsReassemblerOptions, "now">>;
  private readonly now: () => number;
  private retainedBytes = 0;

  constructor(
    private readonly onFrame: (frame: Buffer, channel: number) => void,
    opts: PtcsReassemblerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.limits = {
      maxFrameBytes: opts.maxFrameBytes ?? 8 * 1024 * 1024,
      maxPendingFrames: opts.maxPendingFrames ?? 32,
      maxBufferedBytes: opts.maxBufferedBytes ?? 16 * 1024 * 1024,
      maxFragmentsPerFrame: opts.maxFragmentsPerFrame ?? 16_384,
      maxAgeMs: opts.maxAgeMs ?? 15_000,
      staleMs: opts.staleMs ?? 15_000,
    };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(`PTCS ${name} must be a positive safe integer`);
    }
    if (this.limits.maxFragmentsPerFrame > 65_536) throw new RangeError("PTCS fragment limit exceeds the index range");
  }

  push(packet: Buffer): boolean {
    const h = parsePtcsHeader(packet);
    if (!h) return false;
    const now = this.now();
    this.expireAt(now);
    const key = `${h.channel}:${h.frameId}`;
    const body = packet.subarray(PTCS_HEADER_LENGTH, PTCS_HEADER_LENGTH + h.payloadLength);
    if (
      body.length !== h.payloadLength ||
      h.frameLength > this.limits.maxFrameBytes ||
      h.index >= this.limits.maxFragmentsPerFrame ||
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
    if (
      (p?.bytes ?? 0) + body.length > h.frameLength ||
      this.retainedBytes + body.length > this.limits.maxBufferedBytes
    ) {
      this.drop(key);
      return false;
    }
    if (!p) {
      if (this.partials.size >= this.limits.maxPendingFrames) return false;
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
  expire(): number {
    return this.expireAt(this.now());
  }

  private expireAt(now: number): number {
    let dropped = 0;
    for (const [key, p] of this.partials) {
      if (now - p.touched >= this.limits.staleMs || now - p.created >= this.limits.maxAgeMs) {
        this.drop(key);
        dropped++;
      }
    }
    return dropped;
  }

  private drop(key: string): void {
    const p = this.partials.get(key);
    if (!p) return;
    this.retainedBytes -= p.bytes;
    this.partials.delete(key);
  }

  get pending(): number {
    return this.partials.size;
  }

  /** Retained fragment payload bytes, excluding metadata and delivered frames. */
  get bufferedBytes(): number {
    return this.retainedBytes;
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

export interface PtcsFramerOptions extends PtcsReassemblerOptions {
  payloadBytes?: number;
  /** Where the frame counter starts; the portal's was mid-run when it was observed. */
  sequence?: number;
  nextFrameId?: () => number;
}

/** The {@link PortalFramer} the session uses: PTCS out, PTCS in, with the portal's channel mapping. */
export class PtcsFramer implements PortalFramer {
  private onWire?: (packet: Buffer) => void;
  private onFrame?: (frame: Buffer, linkType: number) => void;
  private reassembler?: PtcsReassembler;
  private sweep?: NodeJS.Timeout;
  private ready = false;
  private readonly nextFrameId: () => number;
  private sequence: number;

  constructor(private readonly opts: PtcsFramerOptions = {}) {
    this.nextFrameId = opts.nextFrameId ?? frameIdClock(opts.now);
    this.sequence = (opts.sequence ?? 0) & 0xffff;
  }

  async init(
    onWirePacket: (packet: Buffer) => void,
    onFrame: (frame: Buffer, linkType: number) => void,
  ): Promise<void> {
    this.onWire = onWirePacket;
    this.onFrame = onFrame;
    this.reassembler = new PtcsReassembler(
      (frame, channel) => this.onFrame?.(frame, linkTypeForChannel(channel)),
      this.opts,
    );
    this.sweep = setInterval(() => this.reassembler?.expire(), 1_000);
    this.sweep.unref?.();
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  sendFrame(portalPacket: Buffer): void {
    if (!this.ready) throw new Error("PTCS framer not initialised");
    const packets = packetize(portalPacket, {
      frameId: this.nextFrameId(),
      payloadBytes: this.opts.payloadBytes,
      sequence: this.sequence,
    });
    this.sequence = (this.sequence + 1) & 0xffff;
    for (const packet of packets) this.onWire?.(packet);
  }

  recvPacket(wirePacket: Buffer): void {
    if (!this.ready) return;
    // The hub sometimes answers with a bare portal packet; pass it through as a command frame.
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
