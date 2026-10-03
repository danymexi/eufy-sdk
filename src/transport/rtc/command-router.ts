/**
 * RTC command router: drives a **HomeBase S1 Pro (T9000)** over the portal's WebRTC data channel instead
 * of P2P.
 *
 * The T9000 answers no P2P lookup, but it accepts the portal's control channel: sign → WS join → scall →
 * SDP answer → ICE over the relay the hub grants → DTLS → SCTP data channels, with commands riding
 * `WebrtcDataChannel` as portal packets (see {@link buildPortalPacket}).
 *
 * `set-payload` rides the `1350` SET_PAYLOAD envelope, inner `{account_id, cmd, mValue3, payload}`, on
 * the station channel `255`: the frame the app sends for arming (`cmd 1224`, `{mode_type, user_name}`),
 * answered by a `1350` ACK and a pushed `1151` MODE_SWITCH. `set-json` rides the `1700` CONTROL_PAYLOAD
 * envelope, inner `{account_id, cmd, commandType, data}`. An attached device's command shares its parent
 * station's session and keeps the device's channel. Other command kinds are refused.
 *
 * One session per station, reused across commands and closed after {@link IDLE_CLOSE_MS} without one.
 * Sends on a session are serialised; an ACK is correlated by its outer command and segment, since it
 * carries no inner command. An ACK is not an observation of the resulting state.
 */
import type { Command } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import type { Logger } from "../../core/logger.js";
import { RtcSession, type RtcSessionOptions } from "./session.js";
import { buildPortalPacket, parsePortalPacket, PortalLinkType, SegmentCounter } from "./portal-packet.js";
import { awaitPayloadOwner, readPortalPayload } from "./portal-payload-reader.js";

/** The SET_PAYLOAD envelope. */
const PORTAL_CMD_SET_PAYLOAD = 1350;
/** The CONTROL_PAYLOAD envelope for a commandType/data request. */
const PORTAL_CMD_CONTROL_PAYLOAD = 1700;
/** The envelope carrying a correlated JSON control result. */
const PORTAL_CMD_NOTIFY_PAYLOAD = 1351;
/** The channel a station-wide command is addressed to. */
const PORTAL_STATION_CHANNEL = 255;

/** How long a command waits for its envelope ACK. */
const ACK_TIMEOUT_MS = 8_000;
/**
 * How long a session has to come up. A healthy hub answers in ~2 s; the bound sits under the ~15 s a
 * service call is commonly given, so a hub outage surfaces as this router's error.
 */
const CONNECT_TIMEOUT_MS = 12_000;
/** An idle station session is closed after this long. */
const IDLE_CLOSE_MS = 60_000;

export interface RtcIdentity {
  authToken: string;
  userId: string;
  /** The `gtoken` header value the mega session's authed HTTP calls carry. */
  gtoken: string;
}

export interface RtcCommandRouterDeps {
  /** The logged-in session's credentials; `undefined` while logged out. */
  identity: () => RtcIdentity | undefined;
  /** The mega shard the account signs on (`"ie-pr"`, `"eu-pr"`, `"us-pr"`); picks the smart host. */
  shard: () => string;
  /** ISO country sent on the sign request (default `US`). */
  country?: string;
  /** Resolve a device record by serial (model, member, stationSn). */
  findDevice: (sn: string) => EufyDevice | undefined;
  logger?: Logger;
  onError?: (e: Error) => void;
  createSession?: (opts: RtcSessionOptions) => RtcSession;
}

interface StationSession {
  session: RtcSession;
  seg: SegmentCounter;
  ready: Promise<void>;
  /** Serialises sends so ACKs can't be attributed to the wrong command. */
  queue: Promise<unknown>;
  pending: number;
  owner: RtcIdentity & { adminUserId: string; shard: string };
  idle?: ReturnType<typeof setTimeout>;
}

export class RtcCommandRouter {
  private readonly sessions = new Map<string, StationSession>();

  constructor(private readonly deps: RtcCommandRouterDeps) {}

  /** A T9000 station itself. */
  static claimsDevice(dev: EufyDevice): boolean {
    return /^T9000/i.test(dev.model ?? "") && (!dev.stationSn || dev.stationSn === dev.sn);
  }

  /** A device attached to a T9000 station: its commands ride the station's session. */
  static claimsAttached(dev: EufyDevice, stationOf: (sn: string) => EufyDevice | undefined): boolean {
    if (!dev.stationSn || dev.stationSn === dev.sn) return false;
    const station = stationOf(dev.stationSn);
    return !!station && RtcCommandRouter.claimsDevice(station);
  }

  async dispatchCommand(sn: string, cmd: Command): Promise<void> {
    if (cmd.kind !== "set-payload" && cmd.kind !== "set-json") {
      throw new Error(`rtc: ${cmd.kind} is not routable over the T9000 control channel (only set-payload or set-json)`);
    }
    const dev = this.deps.findDevice(sn);
    const stationSn = dev?.stationSn || sn;
    const station = this.deps.findDevice(stationSn);
    if (!dev || !station || !RtcCommandRouter.claimsDevice(station))
      throw new Error("RTC command requires a known T9000 station or attached device");
    const channel = stationSn === sn ? PORTAL_STATION_CHANNEL : cmd.channel;
    if (
      !Number.isInteger(channel) ||
      channel < 0 ||
      channel > PORTAL_STATION_CHANNEL ||
      (stationSn !== sn && channel === PORTAL_STATION_CHANNEL)
    )
      throw new RangeError("RTC command requires a valid device channel");
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot drive ${sn}`);
    const member = ((station.raw ?? {}) as { member?: { admin_user_id?: unknown } }).member;
    const adminUserId = (typeof member?.admin_user_id === "string" && member.admin_user_id) || identity.userId;
    const st = await this.stationSession(stationSn, adminUserId, identity);
    const outerCmd = cmd.kind === "set-json" ? PORTAL_CMD_CONTROL_PAYLOAD : PORTAL_CMD_SET_PAYLOAD;
    const innerCmd = cmd.kind === "set-json" ? cmd.param : cmd.cmd;
    const payload =
      cmd.kind === "set-json"
        ? { account_id: adminUserId, cmd: cmd.param, commandType: cmd.param, data: cmd.data }
        : { account_id: adminUserId, cmd: cmd.cmd, mValue3: cmd.mValue3 ?? 0, payload: cmd.payload };
    const segment = st.seg.next();
    const packet = buildPortalPacket({ commandId: outerCmd, channel, segment, payload });
    st.pending++;
    const run = st.queue
      .then(() => this.sendAwaitAck(stationSn, st, packet, outerCmd, innerCmd, channel, segment))
      .finally(() => {
        st.pending--;
        this.touch(stationSn, st);
      });
    st.queue = run.catch(() => undefined);
    return run;
  }

  /** Explicit payload read; shares the normal station owner and bounds acquisition plus exchange to 15 seconds. */
  async readPayload(sn: string, intent: Extract<Command, { kind: "set-payload" }>, signal?: AbortSignal) {
    const dev = this.deps.findDevice(sn);
    const identity = this.deps.identity();
    const adminUserId = this.adminUserId(dev, identity);
    if (!identity || !adminUserId || !dev || !RtcCommandRouter.claimsDevice(dev))
      throw new Error("rtc: payload read requires a known logged-in station");
    if (signal?.aborted) throw new Error("rtc: payload read aborted");
    if (!Number.isInteger(intent.channel) || intent.channel < 0 || intent.channel > 255)
      throw new RangeError("rtc: payload read requires a valid channel");
    const model = dev.model;
    const firmware = this.firmware(dev);
    const caller = { ...identity, adminUserId, shard: this.deps.shard() };
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    const timer = setTimeout(onAbort, 15_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const existing = this.sessions.get(sn);
      if (existing?.pending) throw new Error("rtc: payload read requires an idle station session");
      const st = await awaitPayloadOwner(this.stationSession(sn, adminUserId, identity), abort.signal);
      const isCurrent = () => {
        const current = this.deps.findDevice(sn);
        const auth = this.deps.identity();
        return (
          this.sessions.get(sn) === st &&
          st.session.isConnected &&
          current === dev &&
          RtcCommandRouter.claimsDevice(current) &&
          current.model === model &&
          this.firmware(current) === firmware &&
          !!auth &&
          auth.authToken === st.owner.authToken &&
          auth.userId === st.owner.userId &&
          auth.gtoken === st.owner.gtoken &&
          this.adminUserId(current, auth) === st.owner.adminUserId &&
          caller.authToken === st.owner.authToken &&
          caller.userId === st.owner.userId &&
          caller.gtoken === st.owner.gtoken &&
          caller.adminUserId === st.owner.adminUserId &&
          caller.shard === st.owner.shard &&
          this.deps.shard() === st.owner.shard
        );
      };
      if (!isCurrent()) throw new Error("rtc: payload read session owner changed");
      if (st.pending !== 0) throw new Error("rtc: payload read requires an idle station session");
      const segment = st.seg.next();
      const packet = buildPortalPacket({
        commandId: PORTAL_CMD_SET_PAYLOAD,
        channel: intent.channel,
        segment,
        payload: {
          account_id: adminUserId,
          cmd: intent.cmd,
          mChannel: intent.channel,
          mValue3: intent.mValue3 ?? 0,
          payload: intent.payload,
        },
      });
      st.pending++;
      if (st.idle) clearTimeout(st.idle);
      const run = st.queue
        .then(() =>
          readPortalPayload({
            session: st.session,
            packet,
            stationSn: sn,
            intent,
            segment,
            isCurrent,
            signal: abort.signal,
          }),
        )
        .finally(() => {
          st.pending--;
          this.touch(sn, st);
        });
      st.queue = run.catch(() => undefined);
      return await run;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Resolve the current owner without fetching device metadata. */
  private adminUserId(dev: EufyDevice | undefined, identity: RtcIdentity | undefined): string | undefined {
    const member = (dev?.raw as { member?: { admin_user_id?: unknown } } | undefined)?.member;
    return (typeof member?.admin_user_id === "string" && member.admin_user_id) || identity?.userId;
  }

  /** The record's firmware generation qualifies a read's lifetime, not its payload semantics. */
  private firmware(dev: EufyDevice): unknown {
    const raw = dev.raw as { main_sw_version?: unknown; deviceParams?: { main_sw_version?: unknown } } | undefined;
    const nested = raw?.deviceParams?.main_sw_version;
    const value = typeof nested === "string" && nested ? nested : raw?.main_sw_version;
    return typeof value === "string" && value ? value : undefined;
  }

  /** Tear down every station session (logout / shutdown). */
  close(): void {
    for (const [sn, st] of this.sessions) this.drop(sn, st);
  }

  /**
   * Completes on the command ACK or a correlated control-result notification. The notification must
   * match the request channel, parameter and segment and contain a structured payload. Receipt does
   * not establish physical actuation. The command is sent once, bounded by {@link ACK_TIMEOUT_MS}.
   */
  private sendAwaitAck(
    sn: string,
    st: StationSession,
    packet: Buffer,
    outerCmd: number,
    innerCmd: number,
    channel: number,
    segment: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onData = (frame: Buffer, linkType: number) => {
        const p = parsePortalPacket(frame, linkType);
        if (!p || p.segment !== segment) return;
        const acknowledgement = linkType === PortalLinkType.COMMAND && p.commandId === outerCmd && !!p.isResponse;
        const notification =
          outerCmd === PORTAL_CMD_CONTROL_PAYLOAD &&
          linkType === PortalLinkType.NOTIFY &&
          p.commandId === PORTAL_CMD_NOTIFY_PAYLOAD &&
          p.isResponse === 0 &&
          p.channel === channel &&
          p.cmd === innerCmd &&
          typeof p.data === "object" &&
          p.data !== null &&
          !Array.isArray(p.data) &&
          "payload" in p.data &&
          typeof p.data.payload === "object" &&
          p.data.payload !== null &&
          !Array.isArray(p.data.payload);
        if (!acknowledgement && !notification) return;
        cleanup();
        if (acknowledgement && p.errCode !== 0) {
          reject(new Error(`rtc: ${sn} rejected cmd ${innerCmd} (err ${p.errCode})`));
        } else {
          this.deps.logger?.debug?.(`[rtc] ${sn} cmd ${innerCmd} acked`);
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`rtc: ${sn} session closed while waiting for cmd ${innerCmd} ACK`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`rtc: ${sn} cmd ${innerCmd} ACK timed out after ${ACK_TIMEOUT_MS}ms`));
      }, ACK_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        st.session.off("commandData", onData);
        st.session.off("close", onClose);
        this.touch(sn, st);
      };
      st.session.on("commandData", onData);
      st.session.on("close", onClose);
      if (!st.session.sendCommand(packet)) {
        cleanup();
        reject(new Error(`rtc: ${sn} command channel not open, cmd ${innerCmd} not sent`));
      }
    });
  }

  private async stationSession(sn: string, adminUserId: string, identity: RtcIdentity): Promise<StationSession> {
    const existing = this.sessions.get(sn);
    if (existing) {
      await existing.ready;
      if (existing.session.isConnected) {
        this.touch(sn, existing);
        return existing;
      }
      this.drop(sn, existing);
    }
    const session = (this.deps.createSession ?? ((o: RtcSessionOptions) => new RtcSession(o)))({
      authToken: identity.authToken,
      gtoken: identity.gtoken,
      stationSn: sn,
      adminUserId,
      shard: this.deps.shard(),
      country: this.deps.country ?? "US",
      logger: this.deps.logger,
      peer: { logger: this.deps.logger },
    });
    const ready = this.bringUp(sn, session);
    const st: StationSession = {
      session,
      seg: new SegmentCounter(),
      ready,
      queue: Promise.resolve(),
      pending: 0,
      owner: { ...identity, adminUserId, shard: this.deps.shard() },
    };
    session.on("error", (e) => this.deps.onError?.(e));
    session.on("close", () => {
      if (this.sessions.get(sn) === st) this.sessions.delete(sn);
    });
    this.sessions.set(sn, st);
    try {
      await ready;
    } catch (e) {
      this.drop(sn, st);
      throw e;
    }
    this.touch(sn, st);
    return st;
  }

  /**
   * One bounded bring-up: the session is up when its command channel opens, and it fails, with the
   * session closed and every listener gone, when `connect()` throws, the session closes first, or
   * {@link CONNECT_TIMEOUT_MS} passes. A single promise, so an early failure cannot leave a second one
   * rejecting unheard.
   */
  private bringUp(sn: string, session: RtcSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.off("connected", onConnected);
        session.off("close", onClose);
        if (err) {
          try {
            session.close();
          } catch {
            /* already gone */
          }
          reject(err);
        } else {
          this.deps.logger?.info?.(`[rtc] ${sn} command channel up`);
          resolve();
        }
      };
      const onConnected = () => finish();
      const onClose = () => finish(new Error(`rtc: ${sn} session closed before the command channel opened`));
      const timer = setTimeout(
        () => finish(new Error(`rtc: ${sn} did not come up within ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS,
      );
      session.once("connected", onConnected);
      session.once("close", onClose);
      Promise.resolve()
        .then(() => session.connect())
        .catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
    });
  }

  private touch(sn: string, st: StationSession): void {
    if (st.idle) clearTimeout(st.idle);
    if (st.pending !== 0 || this.sessions.get(sn) !== st || !st.session.isConnected) return;
    st.idle = setTimeout(() => this.drop(sn, st), IDLE_CLOSE_MS);
    st.idle.unref?.();
  }

  private drop(sn: string, st: StationSession): void {
    if (st.idle) clearTimeout(st.idle);
    if (this.sessions.get(sn) === st) this.sessions.delete(sn);
    try {
      st.session.close();
    } catch {
      /* already gone */
    }
  }
}
