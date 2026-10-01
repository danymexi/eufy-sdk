/**
 * The WebRTC peer for a T9000 session: libdatachannel through `node-datachannel`, driven the way the
 * portal drives a browser's RTCPeerConnection.
 *
 * The hub is the offerer: it sends its SDP once it has granted the session, and the peer answers. Six
 * data channels are declared in the portal's order (`WebrtcDataChannel` first, the command channel,
 * then audio, idr, video, notify, download). Every one carries PTCS-framed portal packets; which logical
 * channel a reassembled frame belongs to is the PTCS header's channel, not the data channel it rode on.
 *
 * ICE is relay-only. The hub grants a TURN allocation in its `scall 100` reply and completes DTLS only
 * over the relay pair; on a host pair ICE connects and the DTLS handshake never completes. The peer
 * plays the DTLS client (`active`) and opens its channels on the client's even SCTP stream ids, which
 * is what the hub pairs with.
 *
 * The native peer is injectable.
 */

import { EventEmitter } from "node:events";
import { noopLogger, type Logger } from "../../core/logger.js";
import { PortalLinkType } from "./portal-packet.js";
import { PtcsFramer } from "./ptcs-framer.js";
import {
  ANKER_MAX_MESSAGE_SIZE,
  HUB_SDP_MID,
  forceDtlsRole,
  iceCandidateType,
  pinMaxMessageSize,
  sdpToScallJson,
} from "./scall-sdp.js";

export interface TurnConfig {
  turn_addr: string;
  turn_port: number;
  turn_user: string;
  turn_password: string;
  alt_turn_addr?: string;
  alt_turn_port?: number;
}

/** The slice of `node-datachannel`'s `DataChannel` the peer uses. */
export interface NativeDataChannel {
  getLabel(): string;
  isOpen(): boolean;
  sendMessageBinary(buffer: Buffer | Uint8Array): boolean;
  close(): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (err: string) => void): void;
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
}

/** The slice of `node-datachannel`'s `PeerConnection` the peer uses. */
export interface NativePeerConnection {
  close(): void;
  setRemoteDescription(sdp: string, type: "offer" | "answer"): void;
  localDescription(): { type: string; sdp: string } | null;
  addRemoteCandidate(candidate: string, mid: string): void;
  createDataChannel(label: string, config?: { id?: number; unordered?: boolean }): NativeDataChannel;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  onGatheringStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (dc: NativeDataChannel) => void): void;
}

export interface NativeIceServer {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  relayType?: "TurnUdp" | "TurnTcp" | "TurnTls";
}

export interface NativePeerConfig {
  iceServers: NativeIceServer[];
  iceTransportPolicy: "all" | "relay";
  maxMessageSize: number;
  enableIceTcp: boolean;
}

export type NativePeerFactory = (name: string, config: NativePeerConfig) => NativePeerConnection;

export interface RtcPeerOptions {
  createPeer?: NativePeerFactory;
  logger?: Logger;
}

export interface RtcPeerEvents {
  commandChannelOpen: [];
  /** The command channel went away while the peer itself may still be up. */
  commandChannelClosed: [];
  data: [label: string, frame: Buffer, linkType: number];
  iceCandidate: [candidate: string];
  iceGatheringComplete: [];
  connectionState: [state: string];
  error: [err: Error];
}

/** The portal's channel list; index 0 is the command channel. */
export const DATA_CHANNEL_LABELS = ["WebrtcDataChannel", "audio", "idr", "video", "notify", "download"] as const;
export const COMMAND_CHANNEL = DATA_CHANNEL_LABELS[0];

/** Which logical channel a reassembled frame belongs to, named after the portal's data channels. */
export function labelForLinkType(linkType: number): string {
  switch (linkType) {
    case PortalLinkType.NOTIFY:
      return "notify";
    case PortalLinkType.LIVE:
      return "video";
    case PortalLinkType.FILE:
      return "download";
    case PortalLinkType.PLAYBACK:
      return "playback";
    default:
      return COMMAND_CHANNEL;
  }
}
/**
 * The SCTP stream ids the portal assigns: `WebrtcDataChannel` is id 0 and the rest follow in channel
 * order. Even ids are the DTLS client's half under RFC 8832, which is why the peer answers `active`.
 */
const DATA_CHANNEL_IDS: Record<string, number> = {
  WebrtcDataChannel: 0,
  audio: 2,
  idr: 4,
  video: 6,
  notify: 8,
  download: 10,
};

function turnServers(turn: TurnConfig): NativeIceServer[] {
  const both = (hostname: string, port: number): NativeIceServer[] => [
    { hostname, port, username: turn.turn_user, password: turn.turn_password, relayType: "TurnUdp" },
    { hostname, port, username: turn.turn_user, password: turn.turn_password, relayType: "TurnTcp" },
  ];
  const servers = both(turn.turn_addr, turn.turn_port);
  if (turn.alt_turn_addr && turn.alt_turn_port) servers.push(...both(turn.alt_turn_addr, turn.alt_turn_port));
  return servers;
}

/**
 * `node-datachannel` is an optional dependency: only a T9000 station needs the WebRTC transport. It is
 * loaded on the first session, and a missing module fails with an install hint rather than a bare
 * module-not-found.
 */
async function loadNativePeerFactory(): Promise<NativePeerFactory> {
  let ndc: typeof import("node-datachannel");
  try {
    ndc = await import("node-datachannel");
  } catch (err) {
    throw new Error(
      "the WebRTC transport for a HomeBase S1 Pro (T9000) needs the optional 'node-datachannel' package — " +
        "install it to drive a T9000 over RTC (`npm install node-datachannel`)",
      { cause: err },
    );
  }
  return (name, config) => new ndc.PeerConnection(name, config as never) as unknown as NativePeerConnection;
}

/** How long the native peer has to produce the local answer. */
const ANSWER_TIMEOUT_MS = 15_000;

export class RtcPeer extends EventEmitter<RtcPeerEvents> {
  private pc?: NativePeerConnection;
  private readonly channels = new Map<string, NativeDataChannel>();
  private framer?: PtcsFramer;
  private readonly wireTally = new Map<string, number>();
  private framerInit?: Promise<void>;
  private commandOpen = false;
  private remoteSet = false;
  private handlingOffer = false;
  private channelsCreated = false;
  private gatheringDone = false;
  /** Set by the framer's wire callback when the native channel refused a packet mid-send. */
  private wireSendFailed = false;
  private readonly pending: string[] = [];
  private localAnswer?: { resolve: (sdp: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private readonly logger: Logger;

  constructor(private readonly opts: RtcPeerOptions = {}) {
    super();
    this.logger = opts.logger ?? noopLogger;
  }

  /** Create the native peer on the relay the hub granted in `scall 100`. */
  async init(turn: TurnConfig): Promise<void> {
    if (this.pc) return;
    const createPeer = this.opts.createPeer ?? (await loadNativePeerFactory());
    const config: NativePeerConfig = {
      iceServers: turnServers(turn),
      iceTransportPolicy: "relay",
      maxMessageSize: ANKER_MAX_MESSAGE_SIZE,
      enableIceTcp: true,
    };
    const pc = createPeer("eufy-sdk", config);
    this.pc = pc;
    pc.onLocalDescription((sdp, type) => {
      if (String(type).toLowerCase() === "answer" && this.localAnswer) {
        clearTimeout(this.localAnswer.timer);
        this.localAnswer.resolve(sdp);
        this.localAnswer = undefined;
      }
    });
    pc.onLocalCandidate((candidate) => {
      if (!candidate) return;
      if (!this.acceptsCandidate(candidate)) return;
      this.emit("iceCandidate", candidate);
    });
    pc.onGatheringStateChange((state) => {
      if (state === "complete" && !this.gatheringDone) {
        this.gatheringDone = true;
        this.emit("iceGatheringComplete");
      }
    });
    pc.onStateChange((state) => {
      this.logger.debug(`[rtc] peer state ${state}`);
      this.emit("connectionState", state);
    });
    pc.onDataChannel((dc) => this.wireChannel(dc.getLabel(), dc));
  }

  /**
   * The hub offered: apply the offer, declare the channels, return the answer SDP to signal back.
   *
   * The offer is pinned to `passive` before it is applied, so the native peer has one legal answer,
   * `active`: the role is fixed where it is decided, since rewriting the answer afterwards would change
   * only what is announced. The offer goes in before the channels are declared: `createDataChannel` on
   * a peer without a remote description starts its own negotiation and leaves it in `have-local-offer`.
   * The data channels need no m-line of their own; the offer's SCTP m-line carries them. Only an ANSWER
   * is taken as the local description: one read in `have-local-offer` is an offer.
   */
  async handleRemoteOffer(offerSdp: string): Promise<string> {
    const pc = this.pc;
    if (!pc) throw new Error("RTC peer not initialised");
    if (this.handlingOffer) throw new Error("RTC peer already handling an offer");
    this.handlingOffer = true;
    try {
      const offer = forceDtlsRole(offerSdp, "passive");
      const answerWait = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.localAnswer = undefined;
          reject(new Error("timed out waiting for the local SDP answer"));
        }, ANSWER_TIMEOUT_MS);
        this.localAnswer = { resolve, reject, timer };
      });
      pc.setRemoteDescription(offer, "offer");
      this.remoteSet = true;
      this.createChannels();
      const local = pc.localDescription();
      let answer = String(local?.type ?? "").toLowerCase() === "answer" ? (local?.sdp ?? "") : "";
      if (!answer) answer = await answerWait;
      else if (this.localAnswer) {
        clearTimeout(this.localAnswer.timer);
        this.localAnswer = undefined;
      }
      this.flushPending();
      return pinMaxMessageSize(answer);
    } finally {
      this.handlingOffer = false;
    }
  }

  /** Our answer, in the JSON shape the hub parses (`info` with `sdp`). */
  answerAsScallJson(answerSdp: string): string {
    return JSON.stringify(sdpToScallJson(answerSdp));
  }

  addRemoteCandidate(candidate: string): void {
    if (!this.pc) return;
    if (!this.acceptsCandidate(candidate)) return;
    if (!this.remoteSet || this.handlingOffer) {
      this.pending.push(candidate);
      return;
    }
    this.addNow(candidate);
  }

  get isCommandChannelReady(): boolean {
    const dc = this.channels.get(COMMAND_CHANNEL);
    return this.commandOpen && !!dc?.isOpen();
  }

  /**
   * Send one portal packet on the command channel, through the framer. False when the channel is not
   * usable or the native send refused a wire packet, so a dropped frame does not read as success.
   */
  sendCommand(portalPacket: Buffer): boolean {
    const dc = this.channels.get(COMMAND_CHANNEL);
    if (!dc?.isOpen() || !this.commandOpen || !this.framer?.isReady()) return false;
    this.wireSendFailed = false;
    try {
      this.framer.sendFrame(portalPacket);
    } catch (e) {
      this.logger.warn(`[rtc] command send failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    return !this.wireSendFailed;
  }

  /** Tear the peer down. A pending answer is rejected, so a `handleRemoteOffer` in flight settles. */
  close(): void {
    this.framer?.destroy();
    this.framer = undefined;
    this.framerInit = undefined;
    if (this.localAnswer) {
      clearTimeout(this.localAnswer.timer);
      const pending = this.localAnswer;
      this.localAnswer = undefined;
      pending.reject(new Error("RTC peer closed while waiting for the local SDP answer"));
    }
    this.commandOpen = false;
    this.gatheringDone = false;
    this.pc?.close();
    this.pc = undefined;
    this.channels.clear();
    this.channelsCreated = false;
    this.remoteSet = false;
    this.pending.length = 0;
  }

  private acceptsCandidate(candidate: string): boolean {
    return iceCandidateType(candidate) === "relay";
  }

  private createChannels(): void {
    if (!this.pc || this.channelsCreated) return;
    this.channelsCreated = true;
    for (const label of DATA_CHANNEL_LABELS) {
      const dc = this.pc.createDataChannel(label, { id: DATA_CHANNEL_IDS[label], unordered: false });
      this.wireChannel(label, dc);
    }
  }

  private wireChannel(label: string, dc: NativeDataChannel): void {
    if (this.channels.has(label)) return;
    this.channels.set(label, dc);
    dc.onOpen(() => {
      this.logger.debug(`[rtc] data channel open ${label}`);
      if (label !== COMMAND_CHANNEL) return;
      void this.initFramer(dc)
        .then(() => {
          if (!this.pc || !dc.isOpen() || !this.framer?.isReady()) return;
          this.commandOpen = true;
          this.emit("commandChannelOpen");
        })
        .catch((e: unknown) => {
          if (!this.pc || !dc.isOpen()) return;
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
        });
    });
    dc.onClosed(() => {
      this.logger.debug(`[rtc] data channel closed ${label}`);
      if (label !== COMMAND_CHANNEL) return;
      const wasOpen = this.commandOpen;
      this.commandOpen = false;
      if (wasOpen) this.emit("commandChannelClosed");
    });
    dc.onError((err) => this.emit("error", new Error(`RTC data channel ${label}: ${err}`)));
    dc.onMessage((msg) => {
      const buf = typeof msg === "string" ? Buffer.from(msg) : Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      const n = (this.wireTally.get(label) ?? 0) + 1;
      this.wireTally.set(label, n);
      if (n <= 3 || n % 100 === 0) {
        this.logger.debug(`[rtc] wire ${label} #${n} ${buf.length}B ${buf.subarray(0, 8).toString("hex")}`);
      }
      if (this.framer?.isReady()) {
        this.framer.recvPacket(buf);
        return;
      }
      this.emit("data", label, buf, 0);
    });
  }

  private initFramer(dc: NativeDataChannel): Promise<void> {
    if (this.framerInit) return this.framerInit;
    const framer = new PtcsFramer();
    this.framer = framer;
    this.framerInit = framer
      .init(
        (packet) => {
          if (!dc.isOpen() || !dc.sendMessageBinary(packet)) this.wireSendFailed = true;
        },
        (frame, linkType) => this.emit("data", labelForLinkType(linkType), frame, linkType),
      )
      .catch((e: unknown) => {
        if (this.framer === framer) {
          framer.destroy();
          this.framer = undefined;
          this.framerInit = undefined;
        }
        throw e;
      });
    return this.framerInit;
  }

  private addNow(candidate: string): void {
    try {
      this.pc?.addRemoteCandidate(candidate, HUB_SDP_MID);
    } catch (e) {
      this.logger.warn(`[rtc] addRemoteCandidate failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private flushPending(): void {
    const queued = this.pending.splice(0);
    for (const c of queued) this.addNow(c);
  }
}
