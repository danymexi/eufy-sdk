/**
 * RTC command router — drives a **HomeBase Professional S1 (T9000)** over the portal's WebRTC data
 * channel instead of P2P.
 *
 * The T9000 has no reachable P2P endpoint (every `device.set` over P2P times out), but it accepts the
 * app/portal's control channel: sign → WS join → scall → SDP answer → ICE → DTLS → SCTP data channels,
 * with commands riding `WebrtcDataChannel` as portal packets (see `portal-packet.ts`).
 *
 * ⚠️ ICE policy MUST be `relay` (or `all` with the relay reachable): the hub completes DTLS **only
 * through TURN**. On a host-only pair ICE connects and the DTLS handshake times out, every time
 * (measured on firmware 4.4.0.4, 2026-09-25 — a full night of negatives that all traced back to a
 * host-only default). The relay is granted by the hub itself in the scall `status:100` reply.
 *
 * What rides here today is the `set-payload` envelope (`1350` SET_PAYLOAD, inner
 * `{account_id, cmd, mValue3, payload}`) on the station channel `255` — the exact frame the app sends
 * for arming (`cmd 1224`, `{mode_type, user_name}`), ✅ verified live end-to-end on a T9000 4.4.0.4
 * (2026-09-25 23:55): ACK `1350 err=0`, `1151` MODE_SWITCH pushed back, cloud state updated within 1 s.
 * Other command kinds are refused with a clear error rather than silently misrouted.
 *
 * One session per station, reused across commands and closed after {@link RtcCommandRouterDeps.idleCloseMs}
 * of inactivity. Sends on a session are serialised, because the `1350` ACK carries no inner `cmd` to
 * correlate on: the first ACK after a send belongs to that send.
 */
import type { Command } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import type { Logger } from "../../core/logger.js";
import { RtcSession, type RtcSessionOptions } from "./session.js";
import { buildPortalPacket, parsePortalPacket, SegmentCounter } from "./portal-packet.js";
import { PORTAL_CMD_SET_PAYLOAD, PORTAL_STATION_CHANNEL } from "./commands.js";

export interface RtcIdentity {
  authToken: string;
  userId: string;
  /** The cloud `user_id` the gtoken derives from (falls back to `userId`). */
  accountUserId?: string;
  /** The `gtoken` header value, when the caller already derives it (same as its HTTP calls). */
  gtoken?: string;
}

export interface RtcCommandRouterDeps {
  /** The logged-in session's credentials; `undefined` while logged out. */
  identity: () => RtcIdentity | undefined;
  /** The mega shard the account signs on (`"ie-pr"`, `"eu-pr"`, `"us-pr"`) — picks the smart host. */
  shard: () => string;
  /** ISO country sent on the sign request (default `US`). */
  country?: string;
  /** The acting account name commands attribute themselves to (`user_name`). */
  accountName: () => string;
  /** Resolve a device record by serial (model, adminUserId, stationSn). */
  findDevice: (sn: string) => EufyDevice | undefined;
  logger?: Logger;
  /** `relay` (default) or `all`. Never `host-only` — see the module doc. */
  icePolicy?: "relay" | "all";
  /** How long a command waits for its `1350` ACK (default 8 s). */
  ackTimeoutMs?: number;
  /**
   * How long to wait for the session to come up (default 12 s). A healthy hub answers in ~2 s; the
   * default sits under Home Assistant's 15 s service timeout so a hub outage surfaces as this router's
   * error rather than HA's own timeout.
   */
  connectTimeoutMs?: number;
  /** Close an idle station session after this long (default 60 s). */
  idleCloseMs?: number;
  onError?: (e: Error) => void;
  /** Session factory (tests inject a fake). */
  createSession?: (opts: RtcSessionOptions) => RtcSession;
}

interface StationSession {
  session: RtcSession;
  seg: SegmentCounter;
  ready: Promise<void>;
  /** Serialises sends so ACKs can't be attributed to the wrong command. */
  queue: Promise<unknown>;
  idle?: ReturnType<typeof setTimeout>;
}

export class RtcCommandRouter {
  private readonly sessions = new Map<string, StationSession>();

  constructor(private readonly deps: RtcCommandRouterDeps) {}

  /** A T9000 station itself. Attached cameras keep their own (P2P) path for now. */
  static claimsDevice(dev: EufyDevice): boolean {
    return /^T9000/i.test(dev.model ?? "") && (!dev.stationSn || dev.stationSn === dev.sn);
  }

  async dispatchCommand(sn: string, cmd: Command): Promise<void> {
    if (cmd.kind !== "set-payload") {
      throw new Error(`rtc: ${cmd.kind} is not routable over the T9000 control channel yet (only set-payload)`);
    }
    const dev = this.deps.findDevice(sn);
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot drive ${sn}`);
    // Same identity the P2P router attributes station writes to: the record's member id, else the login.
    const member = ((dev?.raw ?? {}) as { member?: { admin_user_id?: unknown } }).member;
    const adminUserId = (typeof member?.admin_user_id === "string" && member.admin_user_id) || identity.userId;
    const st = await this.stationSession(sn, adminUserId, identity);
    // A station-scoped command rides the broadcast channel; a device-scoped one keeps its own.
    const channel = !dev?.stationSn || dev.stationSn === sn ? PORTAL_STATION_CHANNEL : cmd.channel;
    const packet = buildPortalPacket({
      commandId: PORTAL_CMD_SET_PAYLOAD,
      channel,
      segment: st.seg.next(),
      payload: { account_id: adminUserId, cmd: cmd.cmd, mValue3: cmd.mValue3 ?? 0, payload: cmd.payload },
    });
    const run = st.queue.then(() => this.sendAwaitAck(sn, st, packet, cmd.cmd));
    st.queue = run.catch(() => undefined);
    return run;
  }

  /** Tear down every station session (logout / shutdown). */
  close(): void {
    for (const [sn, st] of this.sessions) {
      if (st.idle) clearTimeout(st.idle);
      try {
        st.session.close();
      } catch {
        /* already gone */
      }
      this.sessions.delete(sn);
    }
  }

  private sendAwaitAck(sn: string, st: StationSession, packet: Buffer, innerCmd: number): Promise<void> {
    const timeoutMs = this.deps.ackTimeoutMs ?? 8_000;
    return new Promise<void>((resolve, reject) => {
      const onData = (frame: Buffer, linkType: number) => {
        const p = parsePortalPacket(frame, linkType);
        if (!p || p.commandId !== PORTAL_CMD_SET_PAYLOAD || !p.isResponse) return;
        cleanup();
        if (p.errCode && p.errCode !== 0) {
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
        reject(new Error(`rtc: ${sn} cmd ${innerCmd} ACK timed out after ${timeoutMs}ms`));
      }, timeoutMs);
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
      userId: identity.userId,
      accountUserId: identity.accountUserId,
      gtoken: identity.gtoken,
      stationSn: sn,
      adminUserId,
      shard: this.deps.shard() as never,
      country: this.deps.country ?? "US",
      channelId: 0,
      logger: this.deps.logger,
      peer: { logger: this.deps.logger, icePolicy: this.deps.icePolicy ?? "relay" },
    });
    const connectTimeoutMs = this.deps.connectTimeoutMs ?? 12_000;
    const ready = (async () => {
      const connected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`rtc: ${sn} did not come up within ${connectTimeoutMs}ms`)), connectTimeoutMs);
        session.once("connected", () => {
          clearTimeout(timer);
          resolve();
        });
        session.once("close", () => {
          clearTimeout(timer);
          reject(new Error(`rtc: ${sn} session closed before the command channel opened`));
        });
      });
      await session.connect();
      await connected;
      this.deps.logger?.info?.(`[rtc] ${sn} command channel up (${this.deps.icePolicy ?? "relay"})`);
    })();
    const st: StationSession = { session, seg: new SegmentCounter(), ready, queue: Promise.resolve() };
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

  private touch(sn: string, st: StationSession): void {
    if (st.idle) clearTimeout(st.idle);
    const idleMs = this.deps.idleCloseMs ?? 60_000;
    st.idle = setTimeout(() => this.drop(sn, st), idleMs);
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
