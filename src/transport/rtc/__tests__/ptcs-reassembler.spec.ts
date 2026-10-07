import { describe, expect, it } from "vitest";
import { PTCS_HEADER_LENGTH, PTCS_STALE_MS, PtcsReassembler, packetize } from "../ptcs-framer.js";

/** Synthetic fragment with independent declared length and position. */
function fragment(id: number, length: number, index = 0, bytes = 1, last = false): Buffer {
  const packet = Buffer.alloc(PTCS_HEADER_LENGTH + bytes);
  packet.write("PTCS");
  packet[4] = 3;
  packet.writeUInt32LE(id, 8);
  packet.writeUInt32LE(length, 12);
  packet.writeUInt16LE(index, 16);
  packet.writeUInt16LE(0x4000 | (last ? 0x0400 : 0) | bytes, 18);
  packet.fill(0x41, PTCS_HEADER_LENGTH);
  return packet;
}

/** Fill one incomplete frame without marking a final fragment. */
function retain(r: PtcsReassembler, id: number, bytes: number): void {
  let remaining = bytes;
  for (let index = 0; remaining > 0; index++) {
    const size = Math.min(1023, remaining);
    expect(r.push(fragment(id, 8 * 1024 * 1024, index, size))).toBe(true);
    remaining -= size;
  }
}

describe("bounded PTCS reassembly", () => {
  it("rejects oversized declared frames before a final fragment", () => {
    const r = new PtcsReassembler(() => {});
    expect(r.push(fragment(1, 8 * 1024 * 1024 + 1))).toBe(false);
  });

  it("bounds positions before a final fragment", () => {
    const r = new PtcsReassembler(() => {});
    expect(r.push(fragment(1, 8 * 1024 * 1024, 16_384))).toBe(false);
    expect(r.push(fragment(2, 8 * 1024 * 1024, 16_383))).toBe(true);
  });

  it("rejects cumulative non-final payload beyond the declared frame", () => {
    const got: Buffer[] = [];
    const r = new PtcsReassembler((f) => got.push(f));
    expect(r.push(fragment(1, 1000, 0, 600))).toBe(true);
    expect(r.push(fragment(1, 1000, 1, 600))).toBe(false);
    expect(r.push(fragment(1, 1000, 1, 400, true))).toBe(true);
    expect(got).toEqual([]);
    expect(r.push(fragment(1, 1000, 0, 600))).toBe(true);
    expect(got).toEqual([Buffer.alloc(1000, 0x41)]);
  });

  it("rejects a new frame at capacity while retaining admitted frames", () => {
    const got: Buffer[] = [];
    const r = new PtcsReassembler((f) => got.push(f));
    for (let id = 0; id < 32; id++) expect(r.push(fragment(id, 2))).toBe(true);
    expect(r.push(fragment(32, 2))).toBe(false);
    expect(r.push(fragment(0, 2, 1, 1, true))).toBe(true);
    expect(got).toEqual([Buffer.from("AA")]);
    expect(r.push(fragment(32, 2))).toBe(true);
  });

  it("bounds cumulative non-final retained bytes and releases expired capacity", () => {
    let now = 0;
    const r = new PtcsReassembler(
      () => {},
      () => now,
    );
    retain(r, 1, 8 * 1024 * 1024);
    retain(r, 2, 8 * 1024 * 1024);
    expect(r.push(fragment(3, 2))).toBe(false);
    now = PTCS_STALE_MS;
    r.expire();
    retain(r, 4, 8 * 1024 * 1024);
    retain(r, 5, 8 * 1024 * 1024);
    expect(r.push(fragment(6, 2))).toBe(false);
  });

  it("releases the receiving assembly when a fragment exceeds the retained-byte budget", () => {
    const r = new PtcsReassembler(() => {});
    retain(r, 1, 8 * 1024 * 1024);
    retain(r, 2, 8 * 1024 * 1024 - 1);
    expect(r.push(fragment(3, 3))).toBe(true);
    expect(r.push(fragment(3, 3, 1))).toBe(false);
    expect(r.push(fragment(4, 2))).toBe(true);
    expect(r.push(fragment(5, 2))).toBe(false);
  });

  it.each([false, true])("duplicates do not extend the deadline (explicit sweep %s)", (sweep) => {
    let now = 0;
    const got: Buffer[] = [];
    const r = new PtcsReassembler(
      (f) => got.push(f),
      () => now,
    );
    const first = fragment(1, 2);
    expect(r.push(first)).toBe(true);
    now = PTCS_STALE_MS - 1;
    expect(r.push(first)).toBe(true);
    now = PTCS_STALE_MS;
    if (sweep) r.expire();
    expect(r.push(fragment(1, 2, 1, 1, true))).toBe(true);
    expect(got).toEqual([]);
  });

  it("expires at the absolute deadline despite new fragment progress", () => {
    let now = 0;
    const got: Buffer[] = [];
    const r = new PtcsReassembler(
      (f) => got.push(f),
      () => now,
    );
    r.push(fragment(1, 3));
    now = PTCS_STALE_MS - 1;
    r.push(fragment(1, 3, 1));
    now = PTCS_STALE_MS;
    r.push(fragment(1, 3, 2, 1, true));
    expect(got).toEqual([]);
  });

  it("admits a new frame after implicit expiry at frame capacity", () => {
    let now = 0;
    const r = new PtcsReassembler(
      () => {},
      () => now,
    );
    for (let id = 0; id < 32; id++) r.push(fragment(id, 2));
    now = PTCS_STALE_MS;
    expect(r.push(fragment(32, 2))).toBe(true);
  });

  it.each(["payload", "sequence", "length", "last"])("drops conflicting duplicate %s", (field) => {
    const got: Buffer[] = [];
    const r = new PtcsReassembler((f) => got.push(f));
    const first = fragment(1, 2);
    const conflict = Buffer.from(first);
    if (field === "payload") conflict[PTCS_HEADER_LENGTH] = 0x42;
    if (field === "sequence") conflict.writeUInt16LE(1, 6);
    if (field === "length") conflict.writeUInt32LE(3, 12);
    if (field === "last") conflict.writeUInt16LE(0x4401, 18);
    expect(r.push(first)).toBe(true);
    expect(r.push(conflict)).toBe(false);
    expect(r.push(fragment(1, 2, 1, 1, true))).toBe(true);
    expect(got).toEqual([]);
  });

  it.each(["past last", "different last", "last before retained"])(
    "drops inconsistent fragment positions: %s",
    (shape) => {
      const got: Buffer[] = [];
      const r = new PtcsReassembler((f) => got.push(f));
      const first = fragment(1, 4, shape === "last before retained" ? 2 : 1, 1, shape !== "last before retained");
      const conflict = fragment(1, 4, shape === "past last" ? 2 : 0, 1, shape !== "past last");
      expect(r.push(first)).toBe(true);
      expect(r.push(conflict)).toBe(false);
      expect(got).toEqual([]);
    },
  );

  it.each(["empty body", "index beyond length", "truncated"])("rejects impossible fragments: %s", (shape) => {
    const r = new PtcsReassembler(() => {});
    const packet = fragment(1, 2, shape === "index beyond length" ? 2 : 0, shape === "empty body" ? 0 : 1);
    expect(r.push(shape === "truncated" ? packet.subarray(0, PTCS_HEADER_LENGTH) : packet)).toBe(false);
  });

  it("reassembles an empty frame", () => {
    const got: Buffer[] = [];
    const r = new PtcsReassembler((f) => got.push(f));
    expect(r.push(fragment(1, 0, 0, 0, true))).toBe(true);
    expect(got).toEqual([Buffer.alloc(0)]);
    expect(r.push(fragment(2, 0, 0, 0))).toBe(false);
  });

  it("retains a copy, permits identical duplicates and valid out-of-order variable fragments", () => {
    const got: Array<[Buffer, number]> = [];
    const r = new PtcsReassembler((f, ch) => got.push([f, ch]));
    const packets = packetize(Buffer.from("abcdefg"), { frameId: 1, channel: 2, payloadBytes: 3 });
    expect(r.push(packets[2]!)).toBe(true);
    expect(r.push(packets[0]!)).toBe(true);
    expect(r.push(packets[0]!)).toBe(true);
    packets[0]!.fill(0, PTCS_HEADER_LENGTH);
    expect(r.push(packets[1]!)).toBe(true);
    expect(got).toEqual([[Buffer.from("abcdefg"), 2]]);
  });

  it("releases completed frame capacity before invoking the receiver", () => {
    let admitted = false;
    const r = new PtcsReassembler(() => {
      admitted = r.push(fragment(33, 2));
    });
    for (let id = 0; id < 32; id++) r.push(fragment(id, 2));
    expect(r.push(fragment(0, 2, 1, 1, true))).toBe(true);
    expect(admitted).toBe(true);
  });
});
