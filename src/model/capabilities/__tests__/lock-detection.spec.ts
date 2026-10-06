import { Device } from "../../device.js";

const serial = "T8000P0000000000";

describe("lock detection uses device facts", () => {
  it.each(["name", "device_name", "alias", "product_name"])(
    "does not infer a lock from the owner-assigned %s",
    (field) => {
      const dev = Device.fromRecord(serial, { model: "T8416", [field]: "Synthetic safe view" });
      expect(dev.has("camera")).toBe(true);
      expect(dev.has("lock")).toBe(false);
      expect(dev.hasProperty("locked")).toBe(false);
    },
  );

  it.each([
    { model: "T8531" },
    { model: "Synthetic lock" },
    { model: "T8416", category: "safe" },
    { model: "T8416", params: { 6000: "4" } },
  ])("retains lock evidence from model, category, codec or reported state: %j", (record) => {
    expect(Device.fromRecord(serial, record).has("lock")).toBe(true);
  });
});
