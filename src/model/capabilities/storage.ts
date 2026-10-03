import type { PortalPayloadObservation } from "../../core/contracts.js";
import type { CapabilityActions, CapabilityModule } from "./types.js";

/** The observed T9000 HDD read dialect. */
const STORAGE_COMMAND = 1307;
const HDD_READ_COMMAND = 11001;
const BYTES_PER_MIB = 1_048_576;

/**
 * HDD quantities on T9000 firmware 4.4.0.4. The reported component scale is supported by the app's
 * usable-capacity formula and its rounded decimal capacity display, not universal byte precision.
 * Used and available quantities and percentage are derived from the reported components.
 */
export interface HddTelemetry {
  /** Usable HDD capacity, from disk_size_1024 in MiB. */
  totalBytes: number;
  /** Video plus system usage in bytes. */
  usedBytes: number;
  /** Usable total minus video and system usage in bytes. */
  availableBytes: number;
  /** Reported video_used in MiB converted to bytes. */
  videoBytes: number;
  /** Reported system_size plus system_size_data in MiB converted to bytes. */
  systemBytes: number;
  /** Derived usage percentage, from video plus system usage over usable capacity. */
  usedPercent: number;
  /** Local arrival of the storage notification in Unix milliseconds. */
  observedAtMs: number;
  correlation: "time-associated";
  exactlyCorrelated: false;
}

/** Explicit storage reads, present only with the qualified dialect and an injected payload reader. */
export interface StorageActions {
  /**
   * Explicitly read one HDD observation. Incomplete, invalid or inconsistent samples
   * answer undefined; session, cancellation and transport failures reject. No polling or caching.
   */
  getHddTelemetry?: (signal?: AbortSignal) => Promise<HddTelemetry | undefined>;
}

/** Narrow a decoded object without accepting arrays or null. */
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reported nonnegative MiB quantities, including the observed numeric-string form. */
function quantity(value: unknown): number | undefined {
  if (typeof value === "string" && value.length <= 64 && /^\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isSafeInteger(value * BYTES_PER_MIB)
    ? value * BYTES_PER_MIB
    : undefined;
}

/**
 * Project a complete qualified HDD notification, preserving its temporal correlation and arrival.
 * The nominal disk_size and alternate disk_used pair do not represent the usable-capacity formula.
 */
function hddTelemetry(observation: PortalPayloadObservation): HddTelemetry | undefined {
  if (
    observation.correlation !== "time-associated" ||
    observation.exactlyCorrelated !== false ||
    !Number.isSafeInteger(observation.receivedAtMs) ||
    observation.receivedAtMs <= 0
  )
    return undefined;
  const envelope = object(observation.payload);
  const payload = object(envelope?.payload);
  if (
    envelope?.cmd !== STORAGE_COMMAND ||
    !payload ||
    (payload.cmd !== undefined && payload.cmd !== HDD_READ_COMMAND) ||
    (payload.mIntRet !== undefined && payload.mIntRet !== 0)
  )
    return undefined;
  const direct = Object.hasOwn(payload, "hdd_info") || Object.hasOwn(payload, "emmc_info");
  if (direct && Object.hasOwn(payload, "body")) return undefined;
  const body = direct ? payload : object(payload.body);
  const hdd = object(body?.hdd_info);
  if (!hdd) return undefined;
  const totalBytes = quantity(hdd.disk_size_1024);
  const videoBytes = quantity(hdd.video_used);
  const system = quantity(hdd.system_size);
  const systemData = quantity(hdd.system_size_data);
  if (totalBytes === undefined || videoBytes === undefined || system === undefined || systemData === undefined)
    return undefined;
  const systemBytes = system + systemData;
  const usedBytes = videoBytes + systemBytes;
  if (totalBytes <= 0 || !Number.isSafeInteger(usedBytes) || usedBytes > totalBytes) return undefined;
  return {
    totalBytes,
    usedBytes,
    availableBytes: totalBytes - usedBytes,
    videoBytes,
    systemBytes,
    usedPercent: (usedBytes / totalBytes) * 100,
    observedAtMs: observation.receivedAtMs,
    correlation: observation.correlation,
    exactlyCorrelated: observation.exactlyCorrelated,
  };
}

/**
 * On-device storage remains a station baseline with no capacity parameters. HDD reads use the
 * qualified T9000 firmware 4.4.0.4 dialect explicitly; parameter 1131 reports unrelated device status.
 */
export const STORAGE: CapabilityModule = {
  capability: "storage",
  description: "Local storage with explicit qualified HDD reads on supported stations.",
  properties: [],
  detection: { codecs: ["station"] },
  actions({ ctx, portalPayload }): CapabilityActions {
    if (ctx.model !== "T9000" || ctx.homeBaseAttached || ctx.firmwareVersion !== "4.4.0.4" || !portalPayload) return {};
    return {
      getHddTelemetry: async (signal?: AbortSignal) =>
        hddTelemetry(
          await portalPayload.readPayload(
            {
              kind: "set-payload",
              cmd: STORAGE_COMMAND,
              channel: 0,
              mValue3: 0,
              payload: { version: 0, cmd: HDD_READ_COMMAND },
            },
            signal,
          ),
        ),
    };
  },
};
