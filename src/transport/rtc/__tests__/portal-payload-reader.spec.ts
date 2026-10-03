import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../../core/contracts.js";
import { readPortalPayload } from "../portal-payload-reader.js";
import { buildPortalHeader, buildPortalPacket, PortalLinkType } from "../portal-packet.js";
import type { RtcSession } from "../session.js";

/** Synthetic station identity used only in in-memory frames. */
const STATION = "T9000P0000000000";
/** Opaque payload request whose semantic projection belongs to the model. */
const INTENT: Extract<Command, { kind: "set-payload" }> = {
  kind: "set-payload",
  cmd: 1307,
  channel: 0,
  payload: { version: 0, cmd: 11001 },
};
/** In-memory channel with observable sends and explicit failure modes. */
class SyntheticSession extends EventEmitter {
  /** Sent frames never leave the process. */
  sent: Buffer[] = [];
  /** Failure modes cover both synchronous send failures. */
  mode: "open" | "refused" | "throw" | "sync-refused" | "sync-throw" = "open";
  /** Store one frame or reproduce a local send failure. */
  sendCommand(packet: Buffer): boolean {
    this.sent.push(packet);
    if (this.mode.startsWith("sync-")) {
      this.emit("commandData", acknowledgement(), PortalLinkType.COMMAND);
      this.emit("commandData", notification(), PortalLinkType.NOTIFY);
    }
    if (this.mode === "throw" || this.mode === "sync-throw") throw new Error("synthetic send failure");
    return this.mode !== "refused" && this.mode !== "sync-refused";
  }
}
/** Build a binary ACK with independently selectable correlation fields. */
function acknowledgement(
  over: Partial<{ command: number; channel: number; segment: number; response: number; result: number }> = {},
): Buffer {
  const cfg = { command: 1350, channel: 0, segment: 7, response: 1, result: 0, ...over };
  const body = Buffer.alloc(4);
  body.writeInt32LE(cfg.result);
  return Buffer.concat([buildPortalHeader(cfg.command, body.length, cfg.channel, cfg.segment, cfg.response), body]);
}
/** Build a synthetic notification with deliberately unrelated channel and segment. */
function notification(
  payload: Record<string, unknown> = { cmd: 11001, body: { sample: "first" } },
  envelope: Record<string, unknown> = {},
): Buffer {
  return buildPortalPacket({ commandId: 1351, channel: 99, segment: 0, payload: { cmd: 1307, payload, ...envelope } });
}
/** Start a bounded read with an observable owner and abort lifetime. */
function fixture(mode: SyntheticSession["mode"] = "open", aborted = false) {
  const session = new SyntheticSession();
  session.mode = mode;
  const abort = new AbortController();
  if (aborted) abort.abort();
  const removeAbort = vi.spyOn(abort.signal, "removeEventListener");
  const owner = { current: true };
  const operation = readPortalPayload({
    session: session as unknown as RtcSession,
    packet: buildPortalPacket({ commandId: 1350, channel: 0, segment: 7, payload: INTENT.payload }),
    stationSn: STATION,
    intent: INTENT,
    segment: 7,
    signal: abort.signal,
    isCurrent: () => owner.current,
  });
  const ack = (frame = acknowledgement(), link: number = PortalLinkType.COMMAND) =>
    session.emit("commandData", frame, link);
  const notify = (frame = notification(), link: number = PortalLinkType.NOTIFY) =>
    session.emit("commandData", frame, link);
  const cleaned = () => {
    expect(session.listenerCount("commandData")).toBe(0);
    expect(session.listenerCount("close")).toBe(0);
    expect(session.listenerCount("error")).toBe(0);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  };
  return { session, abort, owner, operation, ack, notify, cleaned };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded portal payload observation", () => {
  it.each(["ack", "notification"])(
    "does not complete from %s alone and sends only once within 15 seconds",
    async (only) => {
      const f = fixture();
      const assertion = expect(f.operation).rejects.toThrow("timed out after 15000ms");
      if (only === "ack") f.ack();
      else f.notify();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(f.session.listenerCount("commandData")).toBe(1);
      expect(f.session.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      f.cleaned();
    },
  );

  it("retains the first notification and arrival timestamp through duplicates and a delayed ACK", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(250);
    f.notify();
    await vi.advanceTimersByTimeAsync(2_000);
    f.notify(notification({ cmd: 11001, body: { sample: "duplicate" } }));
    f.ack();
    await expect(f.operation).resolves.toEqual({
      payload: { cmd: 1307, payload: { cmd: 11001, body: { sample: "first" } } },
      receivedAtMs: 1_800_000_000_250,
      correlation: "time-associated",
      exactlyCorrelated: false,
    });
    f.cleaned();
  });

  it("accepts absent station tags and preserves time association when the ACK arrives first", async () => {
    const f = fixture();
    f.ack();
    f.notify(notification({ body: { sample: "untagged" } }));
    await expect(f.operation).resolves.toMatchObject({ correlation: "time-associated", exactlyCorrelated: false });
    f.cleaned();
  });

  it.each([
    { name: "channel", fields: { channel: 1 }, link: 1 },
    { name: "segment", fields: { segment: 8 }, link: 1 },
    { name: "outer command", fields: { command: 1700 }, link: 1 },
    { name: "response flag", fields: { response: 0 }, link: 1 },
    { name: "link", fields: {}, link: 3 },
  ])("ignores an ACK with mismatched $name", async ({ fields, link }) => {
    const f = fixture();
    f.notify();
    f.ack(acknowledgement(fields), link);
    await Promise.resolve();
    expect(f.session.listenerCount("commandData")).toBe(1);
    f.ack();
    await f.operation;
    f.cleaned();
  });

  it.each([
    { name: "outer station_sn", envelope: { station_sn: "T9000P0000000001" }, payload: {} },
    { name: "outer stationSn", envelope: { stationSn: "T9000P0000000001" }, payload: {} },
    { name: "payload station", envelope: {}, payload: { station_sn: "T9000P0000000001" } },
    { name: "body station", envelope: {}, payload: { body: { stationSn: "T9000P0000000001" } } },
    { name: "inner command", envelope: {}, payload: { cmd: 11002 } },
    { name: "envelope command", envelope: { cmd: 1308 }, payload: {} },
  ])("ignores a notification with mismatched $name", async ({ envelope, payload }) => {
    const f = fixture();
    f.ack();
    f.notify(notification({ cmd: 11001, ...payload }, envelope));
    await Promise.resolve();
    expect(f.session.listenerCount("commandData")).toBe(1);
    f.notify();
    await f.operation;
    f.cleaned();
  });

  it("accepts explicit matching station tags at all supported levels", async () => {
    const f = fixture();
    f.ack();
    f.notify(notification({ cmd: 11001, station_sn: STATION, body: { stationSn: STATION } }, { station_sn: STATION }));
    await f.operation;
    f.cleaned();
  });

  it("ignores malformed, truncated, oversized and structurally invalid frames before a valid pair", async () => {
    const f = fixture();
    f.ack();
    const malformed = Buffer.from("{invalid", "utf8");
    const oversized = notification({ body: { sample: "x".repeat(65_536) } });
    const valid = notification();
    const frames = [
      Buffer.alloc(15),
      Buffer.alloc(20),
      valid.subarray(0, valid.length - 1),
      Buffer.concat([valid, Buffer.from("trailing")]),
      oversized,
      Buffer.concat([buildPortalHeader(1351, malformed.length, 0, 0), malformed]),
      buildPortalPacket({ commandId: 1351, channel: 0, segment: 0, payload: { cmd: 1307, payload: [] } }),
      buildPortalPacket({ commandId: 1351, channel: 0, segment: 0, payload: { cmd: 1307, payload: null } }),
      buildPortalPacket({ commandId: 1351, channel: 0, segment: 0, payload: { cmd: 1307 } }),
    ];
    for (const frame of frames) f.notify(frame);
    f.notify(valid, PortalLinkType.COMMAND);
    await Promise.resolve();
    expect(f.session.listenerCount("commandData")).toBe(1);
    f.notify(valid);
    await f.operation;
    f.cleaned();
  });

  it.each([1, -1, 0.5, "0", null])("rejects result %s and releases every listener", async (mIntRet) => {
    const f = fixture();
    const assertion = expect(f.operation).rejects.toThrow("result rejected");
    f.notify(notification({ cmd: 11001, mIntRet, body: {} }));
    await assertion;
    f.cleaned();
  });

  it("rejects a nonzero correlated ACK and releases every listener", async () => {
    const f = fixture();
    const assertion = expect(f.operation).rejects.toThrow("payload read rejected");
    f.ack(acknowledgement({ result: 1 }));
    await assertion;
    f.cleaned();
  });

  it.each(["abort", "close", "error", "owner"])("releases every listener after %s", async (failure) => {
    const f = fixture();
    const pattern =
      failure === "owner"
        ? "owner changed"
        : failure === "error"
          ? "session failed"
          : failure === "close"
            ? "session closed"
            : "aborted";
    const assertion = expect(f.operation).rejects.toThrow(pattern);
    f.notify();
    if (failure === "abort") f.abort.abort();
    if (failure === "close") f.session.emit("close");
    if (failure === "error") f.session.emit("error", new Error("synthetic channel failure"));
    if (failure === "owner") {
      f.owner.current = false;
      f.ack();
    }
    await assertion;
    f.cleaned();
  });

  it.each(["refused", "throw"] as const)("cleans up a %s send without replay", async (mode) => {
    const f = fixture(mode);
    await expect(f.operation).rejects.toThrow(mode === "refused" ? "command channel not open" : "send failed");
    expect(f.session.sent).toHaveLength(1);
    f.cleaned();
  });

  it.each(["sync-refused", "sync-throw"] as const)(
    "rejects %s despite synchronous ACK and notification events",
    async (mode) => {
      const f = fixture(mode);
      await expect(f.operation).rejects.toThrow(mode === "sync-refused" ? "command channel not open" : "send failed");
      expect(f.session.sent).toHaveLength(1);
      f.cleaned();
    },
  );

  it("sends nothing for an already aborted signal", async () => {
    const f = fixture("open", true);
    await expect(f.operation).rejects.toThrow("aborted");
    expect(f.session.sent).toHaveLength(0);
    f.cleaned();
  });
});
