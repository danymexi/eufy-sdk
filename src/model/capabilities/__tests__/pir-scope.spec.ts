import { Device } from "../../device.js";
import { MOTION_CMD, type MotionActions } from "../motion.js";
import { bind } from "./bind.js";

const serial = "T8000P0000000000";
const params = { [MOTION_CMD.SENSOR_PIR_SENSITIVITY]: "37", [MOTION_CMD.SENSOR_WORK_MODE]: "1" };

describe("standalone PIR member applicability", () => {
  it.each(["T8416", "T8426", "T8170"])("does not publish sensor-only fields on %s even when reported", (model) => {
    const dev = Device.fromRecord(serial, { model, params });
    for (const name of ["sensorPirSensitivity", "testMode"]) {
      expect(dev.hasProperty(name), name).toBe(false);
      expect(dev.getProperties()).not.toHaveProperty(name);
    }
    const { acts } = bind<MotionActions>("motion", {
      codec: "camera",
      model,
      channel: 0,
      paramIds: new Set(Object.keys(params).map(Number)),
    });
    expect("testMode" in acts).toBe(false);
    expect("setTestMode" in acts).toBe(false);
  });

  it("retains the sensor schema, test-mode read, and existing enter/exit commands", async () => {
    const dev = Device.fromRecord(serial, { model: "T8910", deviceType: 10, params });
    for (const name of ["sensorPirSensitivity", "testMode"]) expect(dev.hasProperty(name)).toBe(true);
    const { acts, sent } = bind<MotionActions>(
      "motion",
      {
        codec: "sensor",
        model: "T8910",
        channel: 2,
        paramIds: new Set(Object.keys(params).map(Number)),
      },
      { read: (name) => (name === "testMode" ? { value: true } : undefined) },
    );
    expect(acts.testMode).toBe(true);
    await acts.setTestMode!(true);
    await acts.setTestMode!(false);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      kind: "set-payload",
      cmd: MOTION_CMD.SENSOR_ENTER_TEST_MODE,
      payload: { channel: 2 },
    });
    expect(sent[1]).toMatchObject({ kind: "set-param", param: MOTION_CMD.SENSOR_EXIT_TEST_MODE });
  });
});
