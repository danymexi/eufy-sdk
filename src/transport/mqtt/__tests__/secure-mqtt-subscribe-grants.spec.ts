import { describe, it, expect, vi } from "vitest";
import { nextClient } from "./lazy-engine.js";
import { EventEmitter } from "node:events";

/**
 * A device whose SUBACK carries a `0x80` (denied) grant on one leg must keep the legs it WAS granted —
 * the old `subscribeAsync` path rejected the whole Promise on any denial, so partitionGrants never ran
 * and the device's realtime state silently fell back to the slow poll. We use the callback subscribe.
 */
const fakeClients: Array<EventEmitter & { end: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }> = [];

vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn(() => {
      const client = new EventEmitter() as EventEmitter & {
        end: ReturnType<typeof vi.fn>;
        subscribe: ReturnType<typeof vi.fn>;
      };
      client.end = vi.fn();
      client.subscribe = vi.fn();
      fakeClients.push(client);
      return client;
    }),
  },
}));

const { SecureMqtt } = await import("../secure-mqtt.js");

const CREDS = {
  endpoint_addr: "aiot-mqtt-us.anker.com",
  certificate_pem: "cert",
  private_key: "key",
  aws_root_ca1_pem: "ca",
  thing_name: "u123-eufy_security",
  app_name: "eufy_mega",
};

async function connected() {
  const m = new SecureMqtt({ credentials: CREDS });
  m.on("error", () => {});
  const p = m.connect();
  const client = await nextClient(fakeClients);
  client.emit("connect");
  await p;
  return { m, client };
}

const DEVICE = { sn: "T8030X", deviceType: 0 } as never;

describe("SecureMqtt.subscribeDevice — partial-denial grants", () => {
  it("keeps a granted leg when another is denied (0x80), via the callback grants", async () => {
    fakeClients.length = 0;
    const { m, client } = await connected();
    // The callback hands over grants even when one is a failure — mqtt.js's Promise form would reject.
    client.subscribe.mockImplementation((topics: string[], _opts: unknown, cb: (e: unknown, g: unknown) => void) => {
      cb(null, [
        { topic: topics[0], qos: 1 },
        { topic: topics[1], qos: 0x80 },
      ]);
    });
    // The public `subscribe` returns only the granted legs — a denied one is dropped, not thrown.
    await expect(m.subscribe(["state/leg", "ota/leg"])).resolves.toEqual(["state/leg"]);
  });

  it("recovers grants from err.packet.granted when mqtt.js reports them there", async () => {
    fakeClients.length = 0;
    const { m, client } = await connected();
    client.subscribe.mockImplementation((topics: string[], _opts: unknown, cb: (e: unknown, g: unknown) => void) => {
      const err = Object.assign(new Error("Unspecified error"), {
        packet: { granted: [{ topic: topics[0], qos: 1 }] },
      });
      const err2 = Object.assign(new Error("Unspecified error"), {
        packet: { granted: [{ topic: topics[0], qos: 1 }] },
      });
      cb(err2, undefined);
    });
    await expect(m.subscribe(["state/leg", "ota/leg"])).resolves.toEqual(["state/leg"]);
  });

  it("still throws when EVERY leg is denied", async () => {
    fakeClients.length = 0;
    const { m, client } = await connected();
    client.subscribe.mockImplementation((topics: string[], _opts: unknown, cb: (e: unknown, g: unknown) => void) => {
      cb(
        null,
        topics.map((t) => ({ topic: t, qos: 0x80 })),
      );
    });
    await expect(m.subscribeDevice(DEVICE)).rejects.toThrow(/every topic denied/);
  });
});
