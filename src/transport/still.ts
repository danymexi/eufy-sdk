/**
 * Stills: one JPEG decoded from an Annex B burst through ffmpeg, and the geometry a JPEG declares.
 */
import { LiveSnapshotUnavailableError } from "../core/contracts.js";
import { spawnFfmpeg, type FfmpegSpawnOptions } from "./ffmpeg.js";

/** Marker bytes that stand alone: TEM, SOI, EOI and the eight restart markers carry no length field. */
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

/** Marker bytes in the `SOFn` range that are NOT frame headers: DHT, JPG and DAC share it. */
const JPEG_NOT_FRAME_HEADERS = new Set([0xc4, 0xc8, 0xcc]);

/**
 * The geometry a JPEG declares in its own frame header (`SOFn`), or `undefined` when it carries none.
 *
 * Walks the marker segments from the SOI rather than searching for the marker bytes: a `0xffc0` pair
 * occurs inside quantization tables and entropy-coded data, and the first one found there would answer
 * with two bytes of image content. Every `SOFn` puts precision, then height, then width at the same
 * offset past its length field, so one read serves all of them. Any number of `0xff` fill bytes may
 * precede a marker, and the standalone markers carry no length to skip by — both are what a naive walk
 * gets wrong, and either would make a perfectly good image read as having no geometry.
 *
 * Decoding the image (the `jpeg-js` path the v2 thumbnail decoder needs) would answer the same question,
 * but it is synchronous pure JS over every pixel: this needs a dozen bytes of header, so it reads them.
 */
export function jpegGeometry(jpeg: Buffer): { width: number; height: number } | undefined {
  let at = 2;
  while (at + 1 < jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && !JPEG_NOT_FRAME_HEADERS.has(marker)) {
      if (at + 9 > jpeg.length) return undefined;
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    }
    if (JPEG_STANDALONE_MARKERS.has(marker)) at += 2;
    else if (at + 4 <= jpeg.length) at += 2 + jpeg.readUInt16BE(at + 2);
    else return undefined;
  }
  return undefined;
}

/**
 * Decode an Annex-B buffer (H.264 or H.265, starting at a keyframe) to a single JPEG via ffmpeg, with
 * the geometry read back out of the image the encoder produced.
 *
 * `-pix_fmt yuvj420p` pins the JPEG-range output the encoder requires. Camera streams signal limited
 * ("tv") range, and the mjpeg encoder refuses a non-full-range input under default compliance — whether
 * it sees one depends on which pixel format format-negotiation happens to settle on, so leaving it
 * unpinned makes the decode fail on some bursts and not others from the same camera. Verified against a
 * captured live burst: the flag produces byte-identical output where negotiation already chose this
 * format, so it constrains only the case that would otherwise error.
 *
 * A burst can also yield no image while ffmpeg exits 0 — asked for one frame, it finds no complete frame
 * in the data and reports success having encoded none. That is a property of the burst, so it carries the
 * same reason as a refused one, but it is described as such rather than as an ffmpeg failure. Bytes that
 * pass the SOI check but declare no frame header land there too: they describe no geometry, and answering
 * with the stream's would reinstate the disagreement reading it back exists to remove.
 *
 * `spawn` carries the ffmpeg dials straight through to {@link spawnFfmpeg} — they are its options, not this
 * function's, so they travel as one bag rather than accumulating as positionals here.
 */
export function annexbToJpeg(
  annexb: Buffer,
  codec: "hevc" | "h264",
  spawn: FfmpegSpawnOptions,
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  return new Promise<{ jpeg: Buffer; width: number; height: number }>((resolve, reject) => {
    const ff = spawnFfmpeg(
      [
        // prettier-ignore
        "-f",
        codec,
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuvj420p",
        "-f",
        "image2",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      spawn,
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout!.on("data", (d) => out.push(d));
    ff.stderr!.on("data", (d) => err.push(d));
    ff.on("error", (e) =>
      reject(
        new LiveSnapshotUnavailableError(
          "decoder-unavailable",
          `ffmpeg not runnable: ${e instanceof Error ? e.message : e}`,
          { cause: e },
        ),
      ),
    );
    ff.on("close", (code) => {
      const jpeg = Buffer.concat(out);
      const encoded = jpeg.length >= 3 && jpeg.subarray(0, 3).toString("hex") === "ffd8ff";
      const geometry = encoded ? jpegGeometry(jpeg) : undefined;
      if (geometry) return resolve({ jpeg, ...geometry });
      const diagnostics = Buffer.concat(err).toString().slice(0, 200).trim();
      const what =
        code !== 0
          ? `ffmpeg exited ${code}`
          : encoded
            ? "encoded image declares no frame header"
            : "no complete frame in the burst";
      reject(new LiveSnapshotUnavailableError("undecodable-burst", diagnostics ? `${what}: ${diagnostics}` : what));
    });
    ff.stdin!.on("error", () => {});
    ff.stdin!.write(annexb);
    ff.stdin!.end();
  });
}
