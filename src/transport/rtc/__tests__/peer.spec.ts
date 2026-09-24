import { describe, expect, it, vi } from "vitest";
import { PassthroughFramer } from "../framer.js";
import {
  COMMAND_CHANNEL,
  DATA_CHANNEL_LABELS,
  RtcPeer,
  type NativeDataChannel,
  type NativePeerConfig,
  type NativePeerConnection,
} from "../peer.js";
import { ANKER_MAX_MESSAGE_SIZE, scallJsonToSdp } from "../scall-sdp.js";

class FakeDc implements NativeDataChannel {
  open = false;
  sent: Buffer[] = [];
  private cbs: Record<string, ((...a: never[]) => void) | undefined> = {};
  constructor(readonly label: string) {}
  getLabel(): string {
    return this.label;
  }
  isOpen(): boolean {
    return this.open;
  }
  sendMessageBinary(buffer: Buffer | Uint8Array): boolean {
    this.sent.push(Buffer.from(buffer));
    return true;
  }
  close(): void {
    this.open = false;
  }
  onOpen(cb: () => void): void {
    this.cbs.open = cb;
  }
  onClosed(cb: () => void): void {
    this.cbs.closed = cb;
  }
  onError(cb: (err: string) => void): void {
    this.cbs.error = cb as never;
  }
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void {
    this.cbs.message = cb as never;
  }
  fireOpen(): void {
    this.open = true;
    (this.cbs.open as (() => void) | undefined)?.();
  }
  fireMessage(msg: Buffer): void {
    (this.cbs.message as ((m: Buffer) => void) | undefined)?.(msg);
  }
}

class FakePc implements NativePeerConnection {
  readonly channels: FakeDc[] = [];
  remote?: { sdp: string; type: string };
  candidates: Array<[string, string]> = [];
  closed = false;
  local: { type: string; sdp: string } | null = null;
  private cbs: Record<string, ((...a: never[]) => void) | undefined> = {};
  close(): void {
    this.closed = true;
  }
  setRemoteDescription(sdp: string, type: "offer" | "answer"): void {
    this.remote = { sdp, type };
  }
  localDescription(): { type: string; sdp: string } | null {
    return this.local;
  }
  addRemoteCandidate(candidate: string, mid: string): void {
    this.candidates.push([candidate, mid]);
  }
  createDataChannel(label: string): NativeDataChannel {
    const dc = new FakeDc(label);
    this.channels.push(dc);
    return dc;
  }
  onLocalDescription(cb: (sdp: string, type: string) => void): void {
    this.cbs.local = cb as never;
  }
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
    this.cbs.cand = cb as never;
  }
  onStateChange(cb: (state: string) => void): void {
    this.cbs.state = cb as never;
  }
  onGatheringStateChange(cb: (state: string) => void): void {
    this.cbs.gather = cb as never;
  }
  onDataChannel(cb: (dc: NativeDataChannel) => void): void {
    this.cbs.dc = cb as never;
  }
  fireLocalAnswer(sdp: string): void {
    (this.cbs.local as ((s: string, t: string) => void) | undefined)?.(sdp, "answer");
  }
  fireLocalCandidate(c: string): void {
    (this.cbs.cand as ((c: string, m: string) => void) | undefined)?.(c, "2");
  }
  fireGathering(state: string): void {
    (this.cbs.gather as ((s: string) => void) | undefined)?.(state);
  }
  fireState(state: string): void {
    (this.cbs.state as ((s: string) => void) | undefined)?.(state);
  }
}

const HOST = "1 1 udp 2130706431 192.168.178.142 47470 typ host";
const SRFLX = "2 1 udp 1694498815 93.48.234.159 47470 typ srflx raddr 192.168.178.142 rport 47470";
const OFFER = scallJsonToSdp({
  setup: "actpass",
  ice: { ufrag: "u", pwd: "p", fingerprint: "ab" },
  candidate: [HOST, SRFLX],
});
const ANSWER =
  "v=0\r\na=setup:passive\r\na=ice-ufrag:x\r\na=ice-pwd:y\r\na=fingerprint:sha-256 aa:bb\r\na=max-message-size:65536\r\n";

function setup(icePolicy: "host-only" | "all" = "host-only") {
  let pc!: FakePc;
  let config!: NativePeerConfig;
  const peer = new RtcPeer({
    icePolicy,
    createPeer: (_name, cfg) => {
      config = cfg;
      pc = new FakePc();
      return pc;
    },
    createFramer: () => new PassthroughFramer(),
    answerTimeoutMs: 200,
  });
  return { peer, pc: () => pc, config: () => config };
}

describe("RtcPeer", () => {
  it("builds a host-only peer with no ICE servers and the hub's max message size", async () => {
    const { peer, config } = setup();
    await peer.init({ turn_addr: "t", turn_port: 3478, turn_user: "u", turn_password: "p" });
    expect(config()).toEqual({
      iceServers: [],
      iceTransportPolicy: "all",
      maxMessageSize: ANKER_MAX_MESSAGE_SIZE,
      enableIceTcp: true,
    });
    const all = setup("all");
    await all.peer.init({
      turn_addr: "t",
      turn_port: 3478,
      turn_user: "u",
      turn_password: "p",
      alt_turn_addr: "t2",
      alt_turn_port: 3479,
    });
    expect(all.config().iceServers.map((s) => `${s.relayType}@${s.hostname}:${s.port}`)).toEqual([
      "TurnUdp@t:3478",
      "TurnTcp@t:3478",
      "TurnUdp@t2:3479",
      "TurnTcp@t2:3479",
    ]);
  });

  it("answers the hub's offer: declares the portal's channels, strips non-host candidates, pins the size", async () => {
    const { peer, pc } = setup();
    await peer.init();
    const answering = peer.handleRemoteOffer(OFFER);
    expect(pc().channels.map((c) => c.label)).toEqual([...DATA_CHANNEL_LABELS]);
    expect(pc().remote?.type).toBe("offer");
    expect(pc().remote?.sdp).toContain(HOST);
    expect(pc().remote?.sdp).not.toContain("typ srflx");
    pc().fireLocalAnswer(ANSWER);
    const answer = await answering;
    expect(answer).toContain(`a=max-message-size:${ANKER_MAX_MESSAGE_SIZE}`);
    expect(JSON.parse(peer.answerAsScallJson(answer))).toEqual({
      setup: "passive",
      ice: { ufrag: "x", pwd: "y", fingerprint_type: "sha-256", fingerprint: "aabb" },
    });
  });

  it("uses an answer libdatachannel already produced, and times out when it never does", async () => {
    const { peer, pc } = setup();
    await peer.init();
    const early = setup();
    await early.peer.init();
    early.pc().local = { type: "answer", sdp: ANSWER };
    await expect(early.peer.handleRemoteOffer(OFFER)).resolves.toContain("a=setup:passive");
    await expect(peer.handleRemoteOffer(OFFER)).rejects.toThrow(/local SDP answer/);
    expect(pc().closed).toBe(false);
  });

  it("queues remote candidates until the offer is applied, and filters both directions by policy", async () => {
    const { peer, pc } = setup();
    await peer.init();
    peer.addRemoteCandidate(HOST);
    peer.addRemoteCandidate(SRFLX);
    expect(pc().candidates).toEqual([]);
    const answering = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answering;
    expect(pc().candidates).toEqual([[HOST, "2"]]);
    peer.addRemoteCandidate("3 1 udp 1 10.0.0.9 5 typ host");
    expect(pc().candidates).toHaveLength(2);
    const local: string[] = [];
    peer.on("iceCandidate", (c) => local.push(c));
    pc().fireLocalCandidate(SRFLX);
    pc().fireLocalCandidate(HOST);
    pc().fireLocalCandidate("");
    expect(local).toEqual([HOST]);
    const done = vi.fn();
    peer.on("iceGatheringComplete", done);
    pc().fireGathering("in-progress");
    pc().fireGathering("complete");
    pc().fireGathering("complete");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("opens the command path once the channel opens, sends through the framer, and surfaces inbound frames", async () => {
    const { peer, pc } = setup();
    await peer.init();
    const answering = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answering;
    const cmd = pc().channels.find((c) => c.label === COMMAND_CHANNEL)!;
    expect(peer.isCommandChannelReady).toBe(false);
    expect(peer.sendCommand(Buffer.from("XZYH-not-open-yet!"))).toBe(false);
    const opened = vi.fn();
    peer.on("commandChannelOpen", opened);
    cmd.fireOpen();
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(peer.isCommandChannelReady).toBe(true);
    const packet = Buffer.from("XZYHcommand");
    expect(peer.sendCommand(packet)).toBe(true);
    expect(cmd.sent).toEqual([packet]);
    const frames: Array<[string, string, number]> = [];
    peer.on("data", (label, frame, lt) => frames.push([label, frame.toString(), lt]));
    cmd.fireMessage(Buffer.from("XZYHreply-16-bytes"));
    const notify = pc().channels.find((c) => c.label === "notify")!;
    notify.fireMessage(Buffer.from("XZYHpush--16-bytes"));
    const video = pc().channels.find((c) => c.label === "video")!;
    video.fireMessage(Buffer.from("XZYHvideo-16-byte!"));
    video.fireMessage(Buffer.from("raw"));
    // Every channel feeds the framer; the passthrough framer tags all of them as command frames, and
    // a three-byte message is not a portal packet at all.
    expect(frames).toEqual([
      [COMMAND_CHANNEL, "XZYHreply-16-bytes", 1],
      [COMMAND_CHANNEL, "XZYHpush--16-bytes", 1],
      [COMMAND_CHANNEL, "XZYHvideo-16-byte!", 1],
    ]);
    const states: string[] = [];
    peer.on("connectionState", (s) => states.push(s));
    pc().fireState("connected");
    expect(states).toEqual(["connected"]);
    peer.close();
    expect(pc().closed).toBe(true);
    expect(peer.isCommandChannelReady).toBe(false);
  });

  it("refuses to work before init and to handle two offers at once", async () => {
    const { peer, pc } = setup();
    await expect(peer.handleRemoteOffer(OFFER)).rejects.toThrow(/not initialised/);
    await peer.init();
    const first = peer.handleRemoteOffer(OFFER);
    await expect(peer.handleRemoteOffer(OFFER)).rejects.toThrow(/already handling/);
    pc().fireLocalAnswer(ANSWER);
    await first;
  });
});
