import { Device } from "../device.js";
import { CAMERA_CMD, CAMERA_MEMBERS, RECORDING_QUALITY_TIERS } from "../capabilities/camera.js";
import { BATTERY_PARAM } from "../capabilities/battery.js";
import { bindMembers, readMemberValue, scalarSpec } from "../capabilities/members.js";

import { VACUUM_CLEAN_MEMBERS, VACUUM_ACTIVITIES } from "../capabilities/vacuum-clean.js";

const synthetic = "T8000P0000000000";

describe("typed cached scalar properties", () => {
  it("keeps opaque string identifiers textual and refuses non-scalar decoder results", () => {
    const member = {
      type: "string" as const,
      description: "Synthetic scalar",
      param: 99998,
      decodedKind: "identifier",
      decode: () => ({ nested: "synthetic" }) as never,
    };
    expect(
      scalarSpec({ name: "example", type: "string", paramType: 99998, writable: false, raw: true }, member).type,
    ).toBe("string");
    expect(scalarSpec({ name: "example", type: "number", paramType: 99998, writable: false }, member).type).toBe(
      "number",
    );
    const dev = Device.fromRecord(synthetic, {
      model: "T8425",
      params: { [CAMERA_CMD.RECORDING_QUALITY_SET]: "synthetic" },
    });
    const decode = vi.spyOn(CAMERA_MEMBERS.recordingQuality, "decode");
    try {
      decode.mockReturnValue({ nested: "synthetic" } as never);
      expect(dev.getPropertyValue("recordingQuality")).toBeUndefined();
      decode.mockReturnValue(Number.NaN);
      expect(dev.getPropertyValue("recordingQuality")).toBeUndefined();
      decode.mockReturnValue(Number.POSITIVE_INFINITY);
      expect(dev.getPropertyValue("recordingQuality")).toBeUndefined();
    } finally {
      decode.mockRestore();
    }
  });
  it("decodes recording quality using the same member decoder as the fluent getter", () => {
    const params = {
      [CAMERA_CMD.RECORDING_QUALITY_SET]: Buffer.from(JSON.stringify({ cur_mode: 0, mode_0: { quality: 2 } })).toString(
        "base64",
      ),
    };
    const dev = Device.fromRecord(synthetic, { model: "T8425", params });
    dev.bindActions(
      { codec: "camera", model: "T8425", channel: 0, paramIds: new Set(Object.keys(params).map(Number)) },
      { dispatch: async () => {} },
    );
    expect(dev.getPropertyValue("recordingQuality")).toBe(2);
    expect(dev.getPropertyValue("recordingQuality")).toBe(dev.camera?.()?.recordingQuality);
    expect(dev.getPropertySpecs().find((s) => s.name === "recordingQuality")).toMatchObject({
      type: "enum",
      kind: "enum",
      enumValues: RECORDING_QUALITY_TIERS,
      values: [1, 2, 3],
      raw: undefined,
    });
    expect(dev.getProperties().recordingQuality.value).not.toBe(2);
  });

  it("reads event-updated state without triggering freshness, and invalidates a malformed decoded payload", () => {
    const dev = Device.fromRecord(synthetic, { model: "T8425" });
    const refresh = vi.fn(async () => {});
    dev.setFreshnessPolicy({ staleAfterMs: -1, refresh });
    dev.applyParams(
      {
        [CAMERA_CMD.RECORDING_QUALITY_SET]: Buffer.from(
          JSON.stringify({ cur_mode: 0, mode_0: { quality: 1 } }),
        ).toString("base64"),
      },
      0,
    );
    expect(dev.getPropertyValue("recordingQuality")).toBe(1);
    const changes = dev.announcements(dev.applyParams({ [CAMERA_CMD.RECORDING_QUALITY_SET]: "invalid" }, 0));
    expect(changes).toContainEqual({ property: "recordingQuality" });
    expect(dev.getPropertyValue("recordingQuality")).toBeUndefined();
    dev.getPropertyValues();
    dev.getPropertySpecs();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("marks diagnostic-only members explicitly and never projects their payloads or unknown parameters", () => {
    const dev = Device.fromRecord(synthetic, {
      model: "T9000",
      params: {
        [BATTERY_PARAM.BATTERY]: "0",
        [BATTERY_PARAM.BATTERY_STATUS]: "0",
        [BATTERY_PARAM.CAMERA_INFO]: '{"example":"synthetic"}',
        99999: "opaque",
      },
    });
    expect(dev.getPropertyValue("battery")).toBe(0);
    expect(dev.getPropertyValue("charging")).toBe(false);
    expect(dev.getPropertyValue("cameraInfo")).toBeUndefined();
    expect(dev.getPropertySpecs().find((s) => s.name === "cameraInfo")).toMatchObject({ unexposed: true });
    expect(dev.getPropertyValues()).not.toHaveProperty("unknown_99999");
    expect(dev.getPropertyValue("unknown_99999")).toBeUndefined();
    expect(JSON.stringify(dev.getPropertyValues())).not.toContain("synthetic");
  });

  it("keeps a backup battery and supported but not-yet-reported camera readings", () => {
    expect(
      Device.fromRecord(synthetic, { model: "T9000", params: { [BATTERY_PARAM.BATTERY]: "100" } }).getPropertyValue(
        "battery",
      ),
    ).toBe(100);
    const cam = Device.fromRecord(synthetic, { model: "T8170" });
    expect(cam.getPropertySpecs().some((s) => s.name === "recordingQuality")).toBe(true);
    expect(cam.getPropertyValue("recordingQuality")).toBeUndefined();
  });

  it("publishes a decoded string enum domain and preserves a fluent decoder's absent-value result", () => {
    const member = VACUUM_CLEAN_MEMBERS.activity;
    const dev = Device.fromRecord(synthetic, { model: "T2351" });
    expect(dev.getPropertySpecs().find((spec) => spec.name === "activity")).toMatchObject({
      type: "string",
      kind: "enum",
      values: VACUUM_ACTIVITIES,
    });
    expect(dev.getPropertyValue("activity")).toBeUndefined();
    const bound = bindMembers(
      { activity: member },
      {
        ctx: { channel: 0, paramIds: new Set([member.param]) },
        sink: { dispatch: async () => {} },
        read: () => undefined,
      },
    );
    expect(bound.activity).toBe("unknown");
    expect(bound.activity).toBe(member.decode(undefined, undefined));
  });

  it("shares the fluent borrowed-source and context handling without rereading plain scalars", () => {
    const members = {
      source: { param: 99996, property: "payload", type: "string" as const, description: "Synthetic payload" },
      value: {
        param: 99997,
        readsFrom: "source",
        type: "number" as const,
        description: "Synthetic scalar",
        decode: (raw: unknown, _codec: unknown, ctx: { model?: string }) =>
          ctx.model === "synthetic" && raw === "payload" ? 0 : undefined,
      },
    };
    const read = vi.fn((name: string) =>
      name === "payload" ? { name, value: "payload", paramType: 99996, ts: 0 } : undefined,
    );
    const ctx = { channel: 0, model: "synthetic", paramIds: new Set([99996]) };
    const bound = bindMembers(members, { ctx, read, sink: { dispatch: async () => {} } });
    expect(readMemberValue("value", members.value, members, read, ctx)).toBe(0);
    expect(bound.value).toBe(0);
    read.mockClear();
    expect(readMemberValue("source", members.source, members, read, ctx)).toBe("payload");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
