import type { Command, PortalPayloadObservation } from "../../core/contracts.js";
import type { RtcSession } from "./session.js";
import { parsePortalHeader, parsePortalPacket, PortalLinkType, PORTAL_HEADER_LENGTH } from "./portal-packet.js";

/** A payload exchange is bounded independently of the station session's idle lifetime. */
const READ_TIMEOUT_MS = 15_000;
/** Reject oversized or incomplete frames before parsing untrusted JSON. */
const MAX_FRAME_BYTES = 65_536;

interface PayloadReadOptions {
  session: RtcSession;
  packet: Buffer;
  stationSn: string;
  intent: Extract<Command, { kind: "set-payload" }>;
  segment: number;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}

/** Cancel one caller's wait without cancelling the shared station session bring-up. */
export function awaitPayloadOwner<T>(ready: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("rtc: payload read aborted or timed out"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    ready.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Narrow structured-object check; capability-specific values remain opaque here. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Explicit station tags may disqualify a notification, but their absence is not exact correlation. */
function tagsMatch(data: Record<string, unknown>, stationSn: string): boolean {
  for (const key of ["station_sn", "stationSn"]) if (key in data && data[key] !== stationSn) return false;
  return true;
}

/**
 * One send on an already-owned session. Requires both a successful correlated envelope ACK and a
 * matching payload notification. Notification segment/channel are not guaranteed to echo the request,
 * so its receipt is time-associated only. The model validates the returned payload and units.
 */
export function readPortalPayload(opts: PayloadReadOptions): Promise<PortalPayloadObservation> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let acked = false;
    let sendAccepted = false;
    let observation: PortalPayloadObservation | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      if (!error && !opts.isCurrent()) error = new Error("rtc: payload read session owner changed");
      settled = true;
      clearTimeout(timer);
      opts.session.off("commandData", onData);
      opts.session.off("close", onClose);
      opts.session.off("error", onError);
      opts.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(observation!);
    };
    const onClose = () => finish(new Error("rtc: payload read session closed"));
    const onError = () => finish(new Error("rtc: payload read session failed"));
    const onAbort = () => finish(new Error("rtc: payload read aborted"));
    const onData = (frame: Buffer, link: number) => {
      const receivedAtMs = Date.now();
      if (settled) return;
      if (!opts.isCurrent()) return finish(new Error("rtc: payload read session owner changed"));
      if (frame.length > MAX_FRAME_BYTES) return;
      const header = parsePortalHeader(frame);
      if (!header || header.paramLength !== frame.length - PORTAL_HEADER_LENGTH) return;
      const parsed = parsePortalPacket(frame, link);
      if (!parsed) return;
      if (
        link === PortalLinkType.COMMAND &&
        parsed.commandId === 1350 &&
        parsed.isResponse === 1 &&
        parsed.channel === opts.intent.channel &&
        parsed.segment === opts.segment
      ) {
        if (parsed.errCode !== 0) return finish(new Error("rtc: payload read rejected"));
        acked = true;
      } else if (
        link === PortalLinkType.NOTIFY &&
        parsed.commandId === 1351 &&
        parsed.isResponse === 0 &&
        record(parsed.data) &&
        parsed.data.cmd === opts.intent.cmd &&
        record(parsed.data.payload)
      ) {
        const payload = parsed.data.payload;
        const innerCmd = opts.intent.payload.cmd;
        if (
          !tagsMatch(parsed.data, opts.stationSn) ||
          !tagsMatch(payload, opts.stationSn) ||
          (record(payload.body) && !tagsMatch(payload.body, opts.stationSn))
        )
          return;
        if (typeof innerCmd === "number" && "cmd" in payload && payload.cmd !== innerCmd) return;
        if ("mIntRet" in payload && (!Number.isInteger(payload.mIntRet) || payload.mIntRet !== 0))
          return finish(new Error("rtc: payload read result rejected"));
        observation ??= {
          payload: parsed.data,
          receivedAtMs,
          correlation: "time-associated",
          exactlyCorrelated: false,
        };
      }
      if (sendAccepted && acked && observation) finish();
    };
    const timer = setTimeout(() => finish(new Error("rtc: payload read timed out after 15000ms")), READ_TIMEOUT_MS);
    if (opts.signal?.aborted) return onAbort();
    if (!opts.isCurrent()) return finish(new Error("rtc: payload read session owner changed"));
    opts.session.on("commandData", onData);
    opts.session.on("close", onClose);
    opts.session.on("error", onError);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (!opts.session.sendCommand(opts.packet))
        return finish(new Error("rtc: payload read command channel not open"));
      sendAccepted = true;
      if (acked && observation) finish();
    } catch {
      finish(new Error("rtc: payload read send failed"));
    }
  });
}
