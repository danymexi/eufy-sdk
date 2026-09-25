// One-shot RTC validation against the HomeBase S1 Pro, using the OWNER account.
//
// Reuses an existing portal auth token (like a second browser tab — WebRTC is multi-viewer, so it does
// NOT log in and does NOT disturb the app or the add-on). The token is read from the environment; it is
// never written to disk by this script and never leaves this machine.
//
//   RTC_TOKEN=<x-auth-token from the portal>  node owner-rtc-probe.mjs
//
// Stages it reports, in order — the first that fails is the answer:
//   SIGN+WS+AUTH ok   → connect() resolved: the sign host, region, headers and gtoken are all correct
//   CONNECTED         → the full WebRTC handshake (ICE+DTLS) came up and the command channel opened
//   MEDIA             → video frames arrived on a per-camera session

import { RtcSession, parsePortalHeader } from "./dist/index.js";

const TOKEN = process.env.RTC_TOKEN;
if (!TOKEN) {
  console.error("set RTC_TOKEN to the portal x-auth-token first");
  process.exit(1);
}

// Non-secret, from the owner's live portal session (an account id and its md5-derived gtoken):
const GTOKEN = process.env.RTC_GTOKEN ?? "005b52205c1187c88c797e0ea9e88e5e";
const AUID = process.env.RTC_AUID ?? "7765c5ef3879628bdceb261202a5d02382a7bd3f";
const STATION = "T9000P2026220AA6";
const CAMERA = "T8410P422338553A"; // subSn unused for the hub session
const CAM_CHANNEL = process.env.RTC_CAM_CHANNEL ? Number(process.env.RTC_CAM_CHANNEL) : undefined;
const BIND = process.env.RTC_BIND; // LAN interface toward the hub, e.g. 192.168.178.162

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const hard = setTimeout(() => {
  log("HARD STOP");
  process.exit(2);
}, 120_000);

const base = {
  authToken: TOKEN,
  userId: AUID,
  accountUserId: AUID,
  gtoken: GTOKEN, // sent verbatim — matches the portal's stored gtoken exactly
  stationSn: STATION,
  adminUserId: AUID,
  shard: "ie-pr",
  country: "CH",
  peer: BIND ? { bindAddress: BIND } : {},
};

async function run(tag, opts, observeMs) {
  const s = new RtcSession({ ...base, ...opts });
  let cmd = 0;
  let media = 0;
  let connected = false;
  s.on("turn", (t) => log(`[${tag}] TURN ${t.turn_addr}:${t.turn_port}`));
  s.on("connected", () => {
    connected = true;
    log(`[${tag}] CONNECTED (WebRTC up, command channel open)`);
  });
  s.on("error", (e) => log(`[${tag}] error: ${e.message}`));
  s.on("commandData", (f, lt) => {
    cmd++;
    if (cmd <= 3) log(`[${tag}] cmd frame lt=${lt} ${f.length}B cmd=${parsePortalHeader(f)?.commandId}`);
  });
  s.on("mediaData", (f, lt) => {
    media++;
    if (media <= 3) {
      const body = f.subarray(16);
      const sc = body.indexOf(Buffer.from([0, 0, 0, 1]));
      log(`[${tag}] MEDIA lt=${lt} ${f.length}B startcode@${sc} head=${f.subarray(0, 32).toString("hex")}`);
    }
  });
  try {
    await s.connect();
    log(`[${tag}] SIGN+WS+AUTH ok (connect resolved)`);
  } catch (e) {
    log(`[${tag}] connect FAILED: ${e.message}`);
    s.close();
    return { tag, sign: false, connected: false, cmd, media };
  }
  await new Promise((r) => {
    const t = setTimeout(r, observeMs);
    s.once("connected", () => {}); // already logged
    setTimeout(() => connected && r(), observeMs);
    void t;
  });
  s.close();
  return { tag, sign: true, connected, cmd, media };
}

const results = [];
log("=== HUB (channel 0) ===");
results.push(await run("hub", { channelId: 0 }, 15_000));

if (CAM_CHANNEL !== undefined) {
  log(`=== CAMERA Orto (channel ${CAM_CHANNEL}) ===`);
  results.push(await run("cam", { channelId: CAM_CHANNEL, subSn: CAMERA }, 25_000));
}

clearTimeout(hard);
console.log("\n==== RESULT ====");
for (const r of results) {
  console.log(`${r.tag}: sign=${r.sign} connected=${r.connected} cmdFrames=${r.cmd} mediaFrames=${r.media}`);
}
process.exit(0);
