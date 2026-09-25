import { describe, expect, it } from "vitest";
import { resolveDevice } from "../registry.js";
import { writeOnlySettingsOf } from "../capabilities/members.js";
import { SIREN } from "../capabilities/siren.js";
import { DeviceType } from "../device-types.js";

/** A HomeBase reporting its alarm tone — the evidence the hub alarm members are gated on. */
const HOMEBASE = { deviceType: DeviceType.STATION, model: "T8030", params: { 1281: "1" } };

describe("write-only settings", () => {
  it("publishes a HomeBase's volumes, which the property schema deliberately omits", () => {
    const hub = resolveDevice(HOMEBASE);
    const names = hub.writeOnlySettings.map((s) => s.name);
    expect(names).toContain("alarmVolume");
    expect(names).toContain("promptVolume");
    // The whole point of the separate list: these are NOT properties, because the hub never reports them.
    expect(hub.properties.map((p) => p.name)).not.toContain("alarmVolume");

    const volume = hub.writeOnlySettings.find((s) => s.name === "alarmVolume");
    expect(volume).toMatchObject({ paramType: 1235, type: "number", kind: "percent", unit: "%", min: 0, max: 100 });
    expect(volume?.provenance).toBe("verified");
  });

  it("applies the setter's gates, not the getter's", () => {
    // A battery camera is not a HomeBase: `available: isHomeBase` keeps the hub volume off it.
    const cam = resolveDevice({ deviceType: DeviceType.CAMERA, model: "T8114", params: { 1101: "80" } });
    expect(cam.writeOnlySettings.map((s) => s.name)).not.toContain("alarmVolume");

    // Same station family, but no alarm evidence reported — `requires` is unmet, so nothing is published.
    const bare = resolveDevice({ deviceType: DeviceType.STATION, model: "T8030", params: {} });
    expect(bare.writeOnlySettings.map((s) => s.name)).not.toContain("alarmVolume");
  });

  it("lists every write-only member with a write, and nothing else", () => {
    const declared = Object.entries(SIREN.members ?? {}).filter(
      ([, m]) => "type" in m && (m as { writeOnly?: true }).writeOnly && (m as { write?: unknown }).write !== undefined,
    );
    const listed = writeOnlySettingsOf(SIREN.members ?? {});
    expect(listed).toHaveLength(declared.length);
    // A member declared write-only but with no write installed would advertise a control that does nothing.
    for (const spec of listed) expect(spec.name).not.toBe("");
  });
});
