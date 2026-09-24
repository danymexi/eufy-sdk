/**
 * The T9000's signalling does not carry SDP text: an `info` message carries a small JSON — DTLS setup
 * role, ICE ufrag/pwd, fingerprint and candidates — and each side rebuilds the one-m-line SDP from it.
 * This is the portal's own translation (security.eufy.com), reproduced so what we hand libdatachannel
 * is the SDP the hub meant, and what we send back is the JSON the hub parses.
 */

export interface ScallSdpJson {
  setup?: string;
  ice?: {
    ufrag?: string;
    pwd?: string;
    fingerprint_type?: string;
    fingerprint?: string;
  };
  candidate?: string[];
}

/** The hub's SDP is one SCTP application m-line bundled under mid 2, as the portal template has it. */
export const HUB_SDP_MID = "2";
/** The hub advertises this max message size and libdatachannel must be told the same. */
export const ANKER_MAX_MESSAGE_SIZE = 262144;

/** Rebuild the hub's offer (or answer) SDP from its scall JSON. */
export function scallJsonToSdp(json: ScallSdpJson, now: () => number = Date.now): string {
  let sdp = "";
  sdp += "v=0\r\n";
  sdp += `o=- ${Math.floor(now())} 1 IN IP4 127.0.0.1\r\n`;
  sdp += "s=Anker Webrtc Stream\r\n";
  sdp += "t=0 0\r\n";
  sdp += `a=group:BUNDLE ${HUB_SDP_MID}\r\n`;
  sdp += "a=msid-semantic: WMS\r\n";
  sdp += "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
  sdp += "c=IN IP4 127.0.0.1\r\n";
  sdp += `a=mid:${HUB_SDP_MID}\r\n`;
  sdp += "a=ice-options:trickle\r\n";
  if (json.ice?.ufrag) sdp += `a=ice-ufrag:${json.ice.ufrag}\r\n`;
  if (json.ice?.pwd) sdp += `a=ice-pwd:${json.ice.pwd}\r\n`;
  if (json.ice?.fingerprint) {
    // The JSON carries the fingerprint as bare hex; SDP wants colon-separated byte pairs.
    const fp = json.ice.fingerprint.replace(/(.{2})(?=.)/g, "$1:");
    sdp += `a=fingerprint:${json.ice.fingerprint_type ?? "sha-256"} ${fp}\r\n`;
  }
  sdp += `a=setup:${json.setup ?? "actpass"}\r\n`;
  sdp += "a=sctp-port:5000\r\n";
  sdp += `a=max-message-size:${ANKER_MAX_MESSAGE_SIZE}\r\n`;
  for (const c of json.candidate ?? []) sdp += `a=candidate:${c}\r\n`;
  return sdp;
}

/** Reduce our local SDP to the JSON the hub parses. `actpass` is left out: the hub wants a concrete role. */
export function sdpToScallJson(sdp: string): ScallSdpJson {
  const json: ScallSdpJson = { ice: { ufrag: "", pwd: "", fingerprint: "" } };
  const setup = sdp.match(/a=setup:([^\r\n]+)/)?.[1];
  if (setup && setup !== "actpass") json.setup = setup;
  const ufrag = sdp.match(/a=ice-ufrag:([^\r\n]+)/)?.[1];
  if (ufrag) json.ice!.ufrag = ufrag;
  const pwd = sdp.match(/a=ice-pwd:([^\r\n]+)/)?.[1];
  if (pwd) json.ice!.pwd = pwd;
  const fp = sdp.match(/a=fingerprint:([^\s]+)\s+([^\r\n]+)/);
  if (fp?.[2]) {
    json.ice!.fingerprint_type = fp[1];
    json.ice!.fingerprint = fp[2].replace(/:/g, "");
  }
  const candidates: string[] = [];
  for (const line of sdp.split(/\r\n|\r|\n/)) {
    const m = line.match(/^a=candidate:(.+)/);
    if (m?.[1]) candidates.push(m[1]);
  }
  if (candidates.length) json.candidate = candidates;
  return json;
}

/** The candidate type (`host` / `srflx` / `relay`) named inside an ICE candidate line. */
export function iceCandidateType(candidate: string): string {
  return candidate.match(/typ (\w+)/)?.[1] ?? "unknown";
}

/** Drop every candidate line whose type isn't `host` — the LAN-only ICE policy. */
export function keepHostCandidates(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const kept = sdp
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("a=candidate:") || iceCandidateType(line) === "host");
  return kept.join(eol) + (kept.length > 0 && kept[kept.length - 1] !== "" ? eol : "");
}

/** Pin `a=max-message-size` to what the hub advertises, whatever libdatachannel wrote. */
export function pinMaxMessageSize(sdp: string): string {
  return sdp.replace(/a=max-message-size:\d+/g, `a=max-message-size:${ANKER_MAX_MESSAGE_SIZE}`);
}
