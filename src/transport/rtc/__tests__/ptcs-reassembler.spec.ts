import { describe, expect, it, vi } from "vitest";
import { packetize, PtcsFramer, PtcsReassembler } from "../ptcs-framer.js";

/** Deterministic synthetic frames, split into small fragments to exercise assembly boundaries. */
function packets(length = 6, frameId = 1, channel = 0, sequence = 0): Buffer[] {
  return packetize(Buffer.alloc(length, frameId), { frameId, channel, sequence, payloadBytes: 2 });
}

describe("PTCS reassembly bounds", () => {
  it("rejects an oversized declaration before retaining any payload", () => {
    const frame = vi.fn();
    const r = new PtcsReassembler(frame, { maxFrameBytes: 4 });
    const packet = packets(2)[0]!;
    packet.writeUInt32LE(0xffffffff, 12);
    expect(r.push(packet)).toBe(false);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
    expect(frame).not.toHaveBeenCalled();
    for (const valid of packets(4)) expect(r.push(valid)).toBe(true);
    expect(frame).toHaveBeenCalledWith(Buffer.alloc(4, 1), 0);
    expect(r.bufferedBytes).toBe(0);
  });

  it("rejects excess pending frames without evicting an accepted frame", () => {
    const frame = vi.fn();
    const r = new PtcsReassembler(frame, { maxPendingFrames: 1 });
    const first = packets(4, 1);
    const second = packets(4, 2);
    expect(r.push(first[0]!)).toBe(true);
    expect(r.push(second[0]!)).toBe(false);
    expect(r.pending).toBe(1);
    expect(r.bufferedBytes).toBe(2);
    expect(r.push(first[1]!)).toBe(true);
    for (const packet of second) expect(r.push(packet)).toBe(true);
    expect(frame).toHaveBeenCalledTimes(2);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
  });

  it("bounds aggregate payload and releases only the assembly that exceeds it", () => {
    const frame = vi.fn();
    const r = new PtcsReassembler(frame, { maxBufferedBytes: 5 });
    const first = packets(4, 1);
    const second = packets(4, 2);
    r.push(first[0]!);
    r.push(second[0]!);
    expect(r.bufferedBytes).toBe(4);
    expect(r.push(first[1]!)).toBe(false);
    expect(r.pending).toBe(1);
    expect(r.bufferedBytes).toBe(2);
    expect(r.push(packetize(Buffer.alloc(3, 3), { frameId: 3 })[0]!)).toBe(true);
    expect(r.bufferedBytes).toBe(2);
    expect(r.push(second[1]!)).toBe(true);
    expect(frame.mock.calls.map(([bytes]) => bytes)).toEqual([Buffer.alloc(3, 3), Buffer.alloc(4, 2)]);
    expect(r.bufferedBytes).toBe(0);
  });

  it("bounds fragment indexes even when the last fragment arrives first", () => {
    const frame = vi.fn();
    const r = new PtcsReassembler(frame, { maxFragmentsPerFrame: 2 });
    expect(r.push(packets(6)[2]!)).toBe(false);
    expect(r.pending).toBe(0);
    for (const packet of packets(4).reverse()) expect(r.push(packet)).toBe(true);
    expect(frame).toHaveBeenCalledWith(Buffer.alloc(4, 1), 0);
  });

  it("drops an assembly as soon as its payload exceeds the declared length", () => {
    const r = new PtcsReassembler(vi.fn());
    const [first, last] = packets(4);
    first!.writeUInt32LE(3, 12);
    last!.writeUInt32LE(3, 12);
    expect(r.push(first!)).toBe(true);
    expect(r.push(last!)).toBe(false);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
  });

  it("accepts an empty frame only as a single final fragment", () => {
    const frame = vi.fn();
    const r = new PtcsReassembler(frame);
    const empty = packets(0)[0]!;
    expect(r.push(empty)).toBe(true);
    expect(frame).toHaveBeenCalledWith(Buffer.alloc(0), 0);
    empty.writeUInt16LE(1, 16);
    expect(r.push(empty)).toBe(false);
    empty.writeUInt16LE(0, 16);
    empty.writeUInt16LE(0x4000, 18);
    expect(r.push(empty)).toBe(false);
    expect(r.pending).toBe(0);
  });

  it("rejects empty fragments in nonempty frames and truncated payloads", () => {
    const r = new PtcsReassembler(vi.fn());
    const empty = packets(2)[0]!;
    empty.writeUInt16LE(0x4400, 18);
    expect(r.push(empty)).toBe(false);
    expect(r.push(packets(2)[0]!.subarray(0, 29))).toBe(false);
    expect(r.pending).toBe(0);
  });

  it.each(["maxFrameBytes", "maxPendingFrames", "maxBufferedBytes", "maxFragmentsPerFrame", "maxAgeMs", "staleMs"])(
    "requires a positive finite integer for %s",
    (option) => {
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
        expect(() => new PtcsReassembler(vi.fn(), { [option]: value })).toThrow(RangeError);
      }
    },
  );

  it("rejects a fragment limit wider than the index field", () => {
    expect(() => new PtcsReassembler(vi.fn(), { maxFragmentsPerFrame: 65_537 })).toThrow(RangeError);
  });

  it("releases capacity before a delivery callback throws", () => {
    const frame = vi.fn().mockImplementationOnce(() => {
      throw new Error("delivery failed");
    });
    const r = new PtcsReassembler(frame, { maxBufferedBytes: 2, maxPendingFrames: 1 });
    expect(() => r.push(packets(2)[0]!)).toThrow("delivery failed");
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
    expect(r.push(packets(2, 2)[0]!)).toBe(true);
    expect(frame).toHaveBeenLastCalledWith(Buffer.alloc(2, 2), 0);
  });

  it("keeps budgets bounded through interleaved incomplete traffic and recovers capacity", () => {
    let now = 0;
    const frame = vi.fn();
    const r = new PtcsReassembler(frame, {
      now: () => now,
      maxFrameBytes: 8,
      maxPendingFrames: 3,
      maxBufferedBytes: 10,
      maxFragmentsPerFrame: 4,
      staleMs: 4,
      maxAgeMs: 7,
    });
    for (let i = 0; i < 256; i++) {
      now = Math.floor(i / 3);
      r.push(packets(8, 1 + (i % 19), i % 3, Math.floor(i / 19))[i % 4]!);
      expect(r.pending).toBeLessThanOrEqual(3);
      expect(r.bufferedBytes).toBeGreaterThanOrEqual(0);
      expect(r.bufferedBytes).toBeLessThanOrEqual(10);
    }
    now += 7;
    r.expire();
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
    for (const packet of packets(6)) expect(r.push(packet)).toBe(true);
    expect(frame).toHaveBeenLastCalledWith(Buffer.alloc(6, 1), 0);
    expect(r.bufferedBytes).toBe(0);
  });
});

describe("PTCS conflicting fragments", () => {
  it.each(["length", "sequence"])("rejects a colliding frame with a different %s", (field) => {
    const frame = vi.fn();
    const r = new PtcsReassembler(frame);
    const [first, next] = packets();
    r.push(first!);
    if (field === "length") next!.writeUInt32LE(7, 12);
    else next!.writeUInt16LE(1, 6);
    expect(r.push(next!)).toBe(false);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
    expect(frame).not.toHaveBeenCalled();
  });

  it("ignores identical duplicates without charging their bytes twice", () => {
    const frame = vi.fn();
    const r = new PtcsReassembler(frame, { maxBufferedBytes: 6 });
    const chunks = packets();
    r.push(chunks[2]!);
    expect(r.push(chunks[2]!)).toBe(true);
    expect(r.bufferedBytes).toBe(2);
    r.push(chunks[0]!);
    expect(r.push(chunks[0]!)).toBe(true);
    r.push(chunks[1]!);
    expect(frame).toHaveBeenCalledExactlyOnceWith(Buffer.alloc(6, 1), 0);
    expect(r.bufferedBytes).toBe(0);
  });

  it("drops an assembly when a duplicate index carries different bytes", () => {
    const frame = vi.fn();
    const r = new PtcsReassembler(frame);
    const packet = packets()[0]!;
    r.push(packet);
    packet[28] = 2;
    expect(r.push(packet)).toBe(false);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
    expect(frame).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects a duplicate that changes its final flag from %s", (last) => {
    const r = new PtcsReassembler(vi.fn());
    const packet = packets()[last ? 2 : 0]!;
    r.push(packet);
    packet.writeUInt16LE(last ? 0x4002 : 0x4402, 18);
    expect(r.push(packet)).toBe(false);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
  });

  it("rejects conflicting final indexes", () => {
    const r = new PtcsReassembler(vi.fn());
    const chunks = packets();
    r.push(chunks[2]!);
    chunks[1]!.writeUInt16LE(0x4402, 18);
    expect(r.push(chunks[1]!)).toBe(false);
    expect(r.pending).toBe(0);
  });

  it.each([false, true])("rejects an index beyond the final index, final arrives first: %s", (lastFirst) => {
    const r = new PtcsReassembler(vi.fn());
    const chunks = packets(8);
    chunks[1]!.writeUInt16LE(0x4402, 18);
    const pair = lastFirst ? [chunks[1]!, chunks[2]!] : [chunks[2]!, chunks[1]!];
    expect(r.push(pair[0]!)).toBe(true);
    expect(r.push(pair[1]!)).toBe(false);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
  });

  it("separates channels with the same frame id and permits id reuse after completion", () => {
    const frame = vi.fn();
    const r = new PtcsReassembler(frame);
    const command = packets(4, 1, 0, 2);
    const notify = packets(4, 1, 2, 3);
    r.push(command[0]!);
    r.push(notify[1]!);
    r.push(command[1]!);
    r.push(notify[0]!);
    for (const packet of packets(4, 1, 0, 4)) r.push(packet);
    expect(frame.mock.calls.map(([, channel]) => channel)).toEqual([0, 2, 0]);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
  });
});

describe("PTCS assembly expiry", () => {
  it("expires a last-first assembly whose missing fragments never arrive", () => {
    let now = 0;
    const r = new PtcsReassembler(vi.fn(), { now: () => now, staleMs: 10, maxAgeMs: 100 });
    r.push(packets()[2]!);
    now = 10;
    expect(r.expire()).toBe(1);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
    expect(r.expire()).toBe(0);
  });

  it("does not let duplicate fragments extend idle expiry", () => {
    let now = 0;
    const r = new PtcsReassembler(vi.fn(), { now: () => now, staleMs: 10, maxAgeMs: 100 });
    const packet = packets()[0]!;
    r.push(packet);
    now = 9;
    expect(r.push(packet)).toBe(true);
    now = 10;
    expect(r.expire()).toBe(1);
    expect(r.bufferedBytes).toBe(0);
  });

  it("enforces absolute age even when new fragments keep making progress", () => {
    let now = 0;
    const frame = vi.fn();
    const r = new PtcsReassembler(frame, { now: () => now, staleMs: 8, maxAgeMs: 10 });
    const chunks = packets(8);
    for (let i = 0; i < 4; i++) {
      now = i * 4;
      r.push(chunks[i]!);
    }
    expect(frame).not.toHaveBeenCalled();
    expect(r.pending).toBe(1);
    expect(r.bufferedBytes).toBe(2);
    now = 22;
    expect(r.expire()).toBe(1);
    expect(r.bufferedBytes).toBe(0);
  });

  it("reclaims expired capacity on push without waiting for a sweep", () => {
    let now = 0;
    const frame = vi.fn();
    const r = new PtcsReassembler(frame, { now: () => now, staleMs: 10, maxPendingFrames: 1, maxBufferedBytes: 2 });
    r.push(packets()[0]!);
    now = 10;
    expect(r.push(packets(2, 2)[0]!)).toBe(true);
    expect(frame).toHaveBeenCalledExactlyOnceWith(Buffer.alloc(2, 2), 0);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
  });
});

describe("PtcsFramer receive limits", () => {
  it("applies configured limits through the session framer", async () => {
    const frame = vi.fn();
    const f = new PtcsFramer({ maxFrameBytes: 3 });
    try {
      await f.init(vi.fn(), frame);
      for (const packet of packets(4)) f.recvPacket(packet);
      expect(frame).not.toHaveBeenCalled();
      for (const packet of packets(3, 2)) f.recvPacket(packet);
      expect(frame).toHaveBeenCalledExactlyOnceWith(Buffer.alloc(3, 2), 1);
    } finally {
      f.destroy();
    }
  });
});
