import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../../core/contracts.js";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter, type RtcIdentity, type RtcRoute } from "../command-router.js";
import { buildPortalHeader, buildPortalPacket, parsePortalHeader, PORTAL_HEADER_LENGTH } from "../portal-packet.js";
import type { RtcSession, RtcSessionOptions } from "../session.js";

/** Synthetic station and child identifiers for isolated router ownership. */
const STATION = "T9000P0000000000";
/** Caller-resolved route, with no device lookup in the transport. */
const ROUTE: RtcRoute = { stationSn: STATION, adminUserId: "synthetic-admin", attached: false };
/** A neutral payload read request with a station-local channel. */
const READ: Extract<Command, { kind: "set-payload" }> = {
  kind: "set-payload",
  cmd: 1307,
  channel: 0,
  mValue3: 0,
  payload: { version: 0, cmd: 11001 },
};
/** Ordinary control intent used only to establish an existing session and test its queue. */
const CONTROL: Command = {
  kind: "set-payload",
  cmd: 1224,
  channel: 0,
  payload: { mode_type: 1, user_name: "synthetic" },
};
/** Connected state and event frames are entirely controlled in memory. */
class SyntheticSession extends EventEmitter {
  /** The connection state exposed to router admission. */
  connected = false;
  /** Count owner shutdowns separately from connection state. */
  closes = 0;
  /** Delay synthetic connection completion to exercise acquisition deadlines. */
  connectionDelay = 0;
  /** Bootstrap controls receive an ACK without transport work. */
  autoAck = true;
  /** Every emitted outbound frame is retained for queue assertions. */
  sent: Buffer[] = [];
  /** The supplied session options make owner binding observable. */
  constructor(readonly options: RtcSessionOptions) {
    super();
  }
  /** Report the synthetic command channel state. */
  get isConnected(): boolean {
    return this.connected;
  }
  /** Open the synthetic channel immediately. */
  async connect(): Promise<void> {
    if (this.connectionDelay) await new Promise<void>((resolve) => setTimeout(resolve, this.connectionDelay));
    this.connected = true;
    this.emit("connected");
  }
  /** Store a frame and optionally acknowledge the exact outer envelope. */
  sendCommand(packet: Buffer): boolean {
    this.sent.push(packet);
    if (this.autoAck) queueMicrotask(() => this.ack(packet));
    return this.connected;
  }
  /** Emit a successful command-link ACK with the packet's correlation fields. */
  ack(packet = this.sent.at(-1)!): void {
    const header = parsePortalHeader(packet)!;
    this.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(header.commandId, 4, header.channel, header.segment, 1), Buffer.alloc(4)]),
      1,
    );
  }
  /** Emit a payload notification on the receiving session without claiming exact correlation. */
  notify(): void {
    this.emit(
      "commandData",
      buildPortalPacket({
        commandId: 1351,
        channel: 255,
        segment: 0,
        payload: { cmd: 1307, payload: { cmd: 11001, body: { sample: "synthetic" } } },
      }),
      3,
    );
  }
  /** Close the owned session without I/O. */
  close(): void {
    this.closes++;
    if (this.connected) {
      this.connected = false;
      this.emit("close");
    }
  }
}
/** Build a router with account ownership and caller-supplied record validity. */
function fixture(nestedFirmware = false, connectionDelay = 0) {
  const state = {
    identity: { authToken: "synthetic-token", userId: "synthetic-user", gtoken: "synthetic-gtoken" } as
      RtcIdentity | undefined,
    shard: "us-pr",
    current: true,
    adminUserId: "synthetic-admin",
    device: {
      sn: STATION,
      model: "T9000",
      stationSn: STATION,
      raw: {
        device_type: 27,
        member: { admin_user_id: "synthetic-admin" },
        ...(nestedFirmware ? { deviceParams: { main_sw_version: "4.4.0.4" } } : { main_sw_version: "4.4.0.4" }),
      },
    } as unknown as EufyDevice,
  };
  const sessions: SyntheticSession[] = [];
  const createSession = vi.fn((options: RtcSessionOptions) => {
    const session = new SyntheticSession(options);
    session.connectionDelay = connectionDelay;
    sessions.push(session);
    return session as unknown as RtcSession;
  });
  const router = new RtcCommandRouter({
    identity: () => state.identity,
    shard: () => state.shard,
    createSession,
  });
  routers.push(router);
  const connect = async () => {
    await router.dispatchCommand(ROUTE, CONTROL);
    const session = sessions[0]!;
    session.autoAck = false;
    return session;
  };
  const validities: ReturnType<typeof vi.fn<() => boolean>>[] = [];
  const read = (intent = READ, signal?: AbortSignal) => {
    const record = state.device;
    const model = record.model;
    const parent = record.stationSn;
    const firmware = (device: EufyDevice) => {
      const raw = device.raw as { main_sw_version?: string; deviceParams?: { main_sw_version?: string } };
      return raw.deviceParams?.main_sw_version ?? raw.main_sw_version;
    };
    const version = firmware(record);
    const isRecordCurrent = vi.fn(
      () =>
        state.current &&
        state.device === record &&
        state.device.sn === STATION &&
        state.device.model === model &&
        state.device.stationSn === parent &&
        firmware(state.device) === version,
    );
    validities.push(isRecordCurrent);
    return router.readPayload({ stationSn: STATION, adminUserId: state.adminUserId }, intent, isRecordCurrent, signal);
  };
  return { state, router, sessions, createSession, connect, read, validities };
}
/** Keep teardown independent of which assertion ends a case. */
const routers: RtcCommandRouter[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const router of routers.splice(0)) router.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("explicit shared-owner payload read routing", () => {
  it.each(["logout", "missing station", "missing admin", "invalid caller record"])(
    "does not acquire a station session for %s",
    async (change) => {
      const f = fixture();
      if (change === "logout") f.state.identity = undefined;
      if (change === "missing admin") f.state.adminUserId = "";
      if (change === "invalid caller record") f.state.current = false;
      const pending =
        change === "missing station" ? f.router.readPayload({ ...ROUTE, stationSn: "" }, READ, () => true) : f.read();
      await expect(pending).rejects.toThrow("known logged-in station");
      expect(f.createSession).not.toHaveBeenCalled();
    },
  );

  it("acquires one station session for an explicit read without an unrelated control write", async () => {
    const f = fixture();
    const read = f.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sessions).toHaveLength(1);
    const session = f.sessions[0]!;
    expect(session.sent).toHaveLength(1);
    session.notify();
    await read;
    expect(f.createSession).toHaveBeenCalledTimes(1);
    expect(f.validities[0]).toHaveBeenCalled();
  });

  it("uses caller validity without interpreting the caller's device metadata", async () => {
    const f = fixture();
    f.state.device.model = "T8030";
    f.state.device.raw = { device_type: 26, main_sw_version: "synthetic-other" };
    const read = f.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sessions).toHaveLength(1);
    f.sessions[0]!.notify();
    await expect(read).resolves.toMatchObject({ exactlyCorrelated: false });
    expect(f.validities[0]).toHaveBeenCalled();
  });

  it("acquires nothing for a pre-aborted explicit read", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(f.read(READ, abort.signal)).rejects.toThrow("aborted");
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it("replaces a disconnected existing owner through the normal station acquisition path", async () => {
    const f = fixture();
    const session = await f.connect();
    session.connected = false;
    const read = f.read();
    await vi.advanceTimersByTimeAsync(0);
    f.sessions[1]!.notify();
    await read;
    expect(session.sent).toHaveLength(1);
    expect(f.createSession).toHaveBeenCalledTimes(2);
  });

  it("sends one read envelope on the requested channel with the existing admin owner", async () => {
    const f = fixture();
    const session = await f.connect();
    const read = f.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sent).toHaveLength(2);
    const packet = session.sent[1]!;
    expect(parsePortalHeader(packet)).toMatchObject({ commandId: 1350, channel: 0, isResponse: 0 });
    expect(JSON.parse(packet.subarray(PORTAL_HEADER_LENGTH).toString())).toEqual({
      account_id: "synthetic-admin",
      cmd: 1307,
      mChannel: 0,
      mValue3: 0,
      payload: { version: 0, cmd: 11001 },
    });
    session.notify();
    session.ack();
    await expect(read).resolves.toMatchObject({ correlation: "time-associated", exactlyCorrelated: false });
    expect(session.listenerCount("commandData")).toBe(0);
    expect(f.createSession).toHaveBeenCalledTimes(1);
  });

  it("refuses concurrent reads while queuing ordinary writes after the active read", async () => {
    const f = fixture();
    const session = await f.connect();
    const read = f.read();
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.read()).rejects.toThrow("idle station session");
    const write = f.router.dispatchCommand(ROUTE, CONTROL);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sent).toHaveLength(2);
    session.notify();
    session.ack();
    await read;
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sent).toHaveLength(3);
    expect(parsePortalHeader(session.sent[2]!)!.segment).not.toBe(parsePortalHeader(session.sent[1]!)!.segment);
    session.ack();
    await write;
    expect(session.listenerCount("commandData")).toBe(0);
  });

  it("refuses a read while an ordinary control is awaiting its ACK", async () => {
    const f = fixture();
    const session = await f.connect();
    const write = f.router.dispatchCommand(ROUTE, CONTROL);
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.read()).rejects.toThrow("idle station session");
    expect(session.sent).toHaveLength(2);
    session.ack();
    await write;
  });

  it.each(["authToken", "userId", "gtoken", "admin", "shard", "logout"])(
    "refuses an idle read after the %s owner changes",
    async (change) => {
      const f = fixture();
      const session = await f.connect();
      if (change === "logout") f.state.identity = undefined;
      else if (change === "admin") f.state.adminUserId = "synthetic-other-admin";
      else if (change === "shard") f.state.shard = "eu-pr";
      else f.state.identity![change as keyof RtcIdentity] = "synthetic-other";
      await expect(f.read()).rejects.toThrow(change === "logout" ? "known logged-in station" : "owner changed");
      expect(session.sent).toHaveLength(1);
      expect(f.createSession).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["model", "firmware", "nested firmware", "identity", "disconnect", "record removed", "caller invalid"])(
    "invalidates an active read when %s changes",
    async (change) => {
      const f = fixture(change === "nested firmware");
      const session = await f.connect();
      const read = f.read();
      const assertion = expect(read).rejects.toThrow("owner changed");
      await vi.advanceTimersByTimeAsync(0);
      session.notify();
      if (change === "model") f.state.device.model = "T9000-synthetic-other";
      if (change === "firmware")
        f.state.device.raw = { ...(f.state.device.raw as object), main_sw_version: "synthetic-other" };
      if (change === "nested firmware")
        f.state.device.raw = {
          member: { admin_user_id: "synthetic-admin" },
          deviceParams: { main_sw_version: "synthetic-other" },
        };
      if (change === "identity") f.state.identity!.authToken = "synthetic-other";
      if (change === "caller invalid") f.state.current = false;
      if (change === "disconnect") session.connected = false;
      if (change === "record removed") f.state.device = { ...f.state.device, sn: "T9000P0000000099", model: "T8030" };
      session.ack();
      await assertion;
      expect(session.listenerCount("commandData")).toBe(0);
      expect(session.listenerCount("close")).toBe(1);
      expect(session.listenerCount("error")).toBe(1);
      expect(session.sent).toHaveLength(2);
    },
  );

  it.each([
    "model",
    "firmware",
    "nested firmware",
    "authToken",
    "admin",
    "shard",
    "logout",
    "record replacement",
    "caller invalid",
  ])("rejects an acquisition-time %s change before sending any payload", async (change) => {
    const f = fixture(change === "nested firmware", 5_000);
    const read = f.read();
    const assertion = expect(read).rejects.toThrow("owner changed");
    await vi.advanceTimersByTimeAsync(0);
    const session = f.sessions[0]!;
    expect(session.isConnected).toBe(false);
    expect(session.sent).toHaveLength(0);
    if (change === "model") f.state.device.model = "T9000-synthetic-other";
    if (change === "firmware")
      f.state.device.raw = { ...(f.state.device.raw as object), main_sw_version: "synthetic-other" };
    if (change === "nested firmware")
      f.state.device.raw = {
        member: { admin_user_id: "synthetic-admin" },
        deviceParams: { main_sw_version: "synthetic-other" },
      };
    if (change === "authToken") f.state.identity!.authToken = "synthetic-other";
    if (change === "caller invalid") f.state.current = false;
    if (change === "admin") {
      f.state.adminUserId = "synthetic-other-admin";
      f.state.current = false;
    }
    if (change === "shard") f.state.shard = "eu-pr";
    if (change === "logout") f.state.identity = undefined;
    if (change === "record replacement") f.state.device = { ...f.state.device };
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(session.sent).toHaveLength(0);
    expect(f.createSession).toHaveBeenCalledTimes(1);
    expect(session.isConnected).toBe(true);
    expect(session.closes).toBe(0);
    expect(session.listenerCount("commandData")).toBe(0);
    expect(session.listenerCount("close")).toBe(1);
    expect(session.listenerCount("error")).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("refuses a shared acquisition read when an ordinary waiting write wins admission", async () => {
    const f = fixture(false, 5_000);
    const write = f.router.dispatchCommand(ROUTE, CONTROL);
    const session = f.sessions[0]!;
    session.autoAck = false;
    const read = f.read();
    const assertion = expect(read).rejects.toThrow("idle station session");
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(f.createSession).toHaveBeenCalledTimes(1);
    expect(session.sent).toHaveLength(1);
    expect(JSON.parse(session.sent[0]!.subarray(PORTAL_HEADER_LENGTH).toString())).toMatchObject({ cmd: 1224 });
    expect(session.isConnected).toBe(true);
    expect(session.closes).toBe(0);
    session.ack();
    await write;
    expect(session.listenerCount("commandData")).toBe(0);
  });

  it("releases the queue after cancellation so a later read can succeed", async () => {
    const f = fixture();
    const session = await f.connect();
    const abort = new AbortController();
    const first = f.read(READ, abort.signal);
    const assertion = expect(first).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await assertion;
    const next = f.read();
    await vi.advanceTimersByTimeAsync(0);
    session.ack(session.sent[1]!);
    session.notify();
    await Promise.resolve();
    expect(session.listenerCount("commandData")).toBe(1);
    session.ack();
    await next;
    expect(session.sent).toHaveLength(3);
  });

  it.each([-1, 1.5, 256, NaN])("refuses invalid read channel %s before sending", async (channel) => {
    const f = fixture();
    const session = await f.connect();
    await expect(f.read({ ...READ, channel })).rejects.toThrow("valid channel");
    expect(session.sent).toHaveLength(1);
  });

  it("admits only one concurrent cold read on the shared owner", async () => {
    const f = fixture();
    const first = f.read();
    const second = f.read();
    const refusal = expect(second).rejects.toThrow("idle station session");
    await vi.advanceTimersByTimeAsync(0);
    await refusal;
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.sent).toHaveLength(1);
    f.sessions[0]!.notify();
    await first;
  });

  it("bounds connection plus exchange to 15 seconds rather than resetting the deadline after acquisition", async () => {
    const f = fixture(false, 11_900);
    const read = f.read();
    const assertion = expect(read).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(11_900);
    const session = f.sessions[0]!;
    expect(session.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_099);
    expect(session.listenerCount("commandData")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(session.listenerCount("commandData")).toBe(0);
    expect(session.closes).toBe(0);
    expect(f.createSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing 12-second connection bound inside the read budget", async () => {
    const f = fixture(false, 20_000);
    const read = f.read();
    const assertion = expect(read).rejects.toThrow("did not come up within 12000ms");
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    expect(f.sessions[0]!.sent).toHaveLength(0);
    expect(f.sessions[0]!.closes).toBeGreaterThan(0);
  });

  it("cancels one acquisition wait without closing the shared owner or an ordinary waiting write", async () => {
    const f = fixture(false, 5_000);
    const abort = new AbortController();
    const read = f.read(READ, abort.signal);
    const assertion = expect(read).rejects.toThrow("aborted");
    const write = f.router.dispatchCommand(ROUTE, CONTROL);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await assertion;
    expect(f.sessions[0]!.closes).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await write;
    expect(f.createSession).toHaveBeenCalledTimes(1);
    expect(f.sessions[0]!.closes).toBe(0);
    expect(f.sessions[0]!.sent).toHaveLength(1);
    expect(JSON.parse(f.sessions[0]!.sent[0]!.subarray(PORTAL_HEADER_LENGTH).toString())).toMatchObject({ cmd: 1224 });
  });
});
