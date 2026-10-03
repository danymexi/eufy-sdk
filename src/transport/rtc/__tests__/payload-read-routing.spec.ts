import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../../core/contracts.js";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter, type RtcIdentity } from "../command-router.js";
import { buildPortalHeader, buildPortalPacket, parsePortalHeader, PORTAL_HEADER_LENGTH } from "../portal-packet.js";
import type { RtcSession, RtcSessionOptions } from "../session.js";

/** Synthetic station and child identifiers for isolated router ownership. */
const STATION = "T9000P0000000000";
/** Synthetic attached-device identifier. */
const CHILD = "T8000P0000000001";
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
/** Build a router over mutable synthetic account and device records. */
function fixture(nestedFirmware = false, connectionDelay = 0) {
  const state = {
    identity: { authToken: "synthetic-token", userId: "synthetic-user", gtoken: "synthetic-gtoken" } as
      RtcIdentity | undefined,
    shard: "us-pr",
    device: {
      sn: STATION,
      model: "T9000",
      stationSn: STATION,
      raw: {
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
    findDevice: (sn) =>
      sn === STATION
        ? state.device
        : sn === CHILD
          ? ({ sn: CHILD, model: "T8425", stationSn: STATION, raw: {} } as EufyDevice)
          : undefined,
    createSession,
  });
  routers.push(router);
  const connect = async () => {
    await router.dispatchCommand(STATION, CONTROL);
    const session = sessions[0]!;
    session.autoAck = false;
    return session;
  };
  return { state, router, sessions, createSession, connect };
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
  it.each([CHILD, "T9000P0000000099"])(
    "does not acquire a station session for an unsupported read of %s",
    async (sn) => {
      const f = fixture();
      await expect(f.router.readPayload(sn, READ)).rejects.toThrow("known logged-in station");
      expect(f.createSession).not.toHaveBeenCalled();
    },
  );

  it("acquires one station session for an explicit read without an unrelated control write", async () => {
    const f = fixture();
    const read = f.router.readPayload(STATION, READ);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sessions).toHaveLength(1);
    const session = f.sessions[0]!;
    expect(session.sent).toHaveLength(1);
    session.notify();
    await read;
    expect(f.createSession).toHaveBeenCalledTimes(1);
  });

  it("acquires nothing for a pre-aborted explicit read", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(f.router.readPayload(STATION, READ, abort.signal)).rejects.toThrow("aborted");
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it("replaces a disconnected existing owner through the normal station acquisition path", async () => {
    const f = fixture();
    const session = await f.connect();
    session.connected = false;
    const read = f.router.readPayload(STATION, READ);
    await vi.advanceTimersByTimeAsync(0);
    f.sessions[1]!.notify();
    await read;
    expect(session.sent).toHaveLength(1);
    expect(f.createSession).toHaveBeenCalledTimes(2);
  });

  it("sends one read envelope on the requested channel with the existing admin owner", async () => {
    const f = fixture();
    const session = await f.connect();
    const read = f.router.readPayload(STATION, READ);
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
    const read = f.router.readPayload(STATION, READ);
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.router.readPayload(STATION, READ)).rejects.toThrow("idle station session");
    const write = f.router.dispatchCommand(STATION, CONTROL);
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
    const write = f.router.dispatchCommand(STATION, CONTROL);
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.router.readPayload(STATION, READ)).rejects.toThrow("idle station session");
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
      else if (change === "admin")
        f.state.device.raw = { main_sw_version: "4.4.0.4", member: { admin_user_id: "synthetic-other-admin" } };
      else if (change === "shard") f.state.shard = "eu-pr";
      else f.state.identity![change as keyof RtcIdentity] = "synthetic-other";
      await expect(f.router.readPayload(STATION, READ)).rejects.toThrow(
        change === "logout" ? "known logged-in station" : "owner changed",
      );
      expect(session.sent).toHaveLength(1);
      expect(f.createSession).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["model", "firmware", "nested firmware", "identity", "disconnect", "record removed"])(
    "invalidates an active read when %s changes",
    async (change) => {
      const f = fixture(change === "nested firmware");
      const session = await f.connect();
      const read = f.router.readPayload(STATION, READ);
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

  it.each(["model", "firmware", "nested firmware", "authToken", "admin", "shard", "logout", "record replacement"])(
    "rejects an acquisition-time %s change before sending any payload",
    async (change) => {
      const f = fixture(change === "nested firmware", 5_000);
      const read = f.router.readPayload(STATION, READ);
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
      if (change === "admin")
        f.state.device.raw = { main_sw_version: "4.4.0.4", member: { admin_user_id: "synthetic-other-admin" } };
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
    },
  );

  it("refuses a shared acquisition read when an ordinary waiting write wins admission", async () => {
    const f = fixture(false, 5_000);
    const write = f.router.dispatchCommand(STATION, CONTROL);
    const session = f.sessions[0]!;
    session.autoAck = false;
    const read = f.router.readPayload(STATION, READ);
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
    const first = f.router.readPayload(STATION, READ, abort.signal);
    const assertion = expect(first).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await assertion;
    const next = f.router.readPayload(STATION, READ);
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
    await expect(f.router.readPayload(STATION, { ...READ, channel })).rejects.toThrow("valid channel");
    expect(session.sent).toHaveLength(1);
  });

  it("admits only one concurrent cold read on the shared owner", async () => {
    const f = fixture();
    const first = f.router.readPayload(STATION, READ);
    const second = f.router.readPayload(STATION, READ);
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
    const read = f.router.readPayload(STATION, READ);
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
    const read = f.router.readPayload(STATION, READ);
    const assertion = expect(read).rejects.toThrow("did not come up within 12000ms");
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    expect(f.sessions[0]!.sent).toHaveLength(0);
    expect(f.sessions[0]!.closes).toBeGreaterThan(0);
  });

  it("cancels one acquisition wait without closing the shared owner or an ordinary waiting write", async () => {
    const f = fixture(false, 5_000);
    const abort = new AbortController();
    const read = f.router.readPayload(STATION, READ, abort.signal);
    const assertion = expect(read).rejects.toThrow("aborted");
    const write = f.router.dispatchCommand(STATION, CONTROL);
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
