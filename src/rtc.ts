/* StreamDrop v5 — the WebRTC hop, and the connection code that starts it.
 *
 * There is no server, so the two devices have to be introduced to each other by the people
 * holding them. The introduction is a single compact string — the "connection code" — that the
 * sender shows (QR and/or copyable text) and the receiver pastes, scans, or imports from a
 * gallery image. The receiver's reply travels back the same way. After that the bytes flow
 * device to device and nothing else is involved.
 *
 * A code is JSON (SDP + the few numbers the receiver needs) → deflate-raw → base64url, tagged
 * `SDC1.`. If the browser cannot deflate we fall back to uncompressed `SDC0.`, and the parser
 * accepts both, so the format is self-describing and robust.
 *
 * One offer is bound to exactly one RTCPeerConnection, so one code admits exactly one receiver:
 * after a connection is up the sender is handed a fresh code for the next one.
 */
import type { BlockChannel } from "./protocol";

export interface InviteMeta {
  shareId: string;          // 7 chars — the human label for this transfer
  codeFp: string;           // hex64 — HKDF of the ID; lets the receiver check the ID travelled intact
  expiresAt: number;
  maxDownloads: number | null;
  publicLabel: string | null;
}

interface InviteWire extends InviteMeta {
  v: 5;
  t: "offer";
  sdp: string;
}

interface AnswerWire {
  v: 5;
  t: "answer";
  codeFp: string;
  sdp: string;
}

export const CODE_DEFLATED = "SDC1.";
export const CODE_PLAIN = "SDC0.";

/**
 * Public STUN only. STUN never sees file data — it answers one question, "what is my address as
 * seen from outside?", which is what lets two home/mobile networks find a direct path. Clearing
 * this list still works on the same Wi-Fi (host candidates) but removes the internet path.
 */
export const DEFAULT_ICE: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

/* ── base64url / deflate plumbing ─────────────────────────────────── */

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Codec = new (format: string) => TransformStream<Uint8Array, Uint8Array>;

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
  const CS = (globalThis as { CompressionStream?: Codec }).CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CS("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const DS = (globalThis as { DecompressionStream?: Codec }).DecompressionStream;
  if (!DS) throw new Error("This browser cannot read compressed connection codes.");
  const stream = new Blob([bytes]).stream().pipeThrough(new DS("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The SDP is long and highly repetitive; deflating it takes a code from ~1.4 KB to ~450 chars. */
async function packCode(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const packed = await deflateRaw(bytes);
  if (packed && packed.length < bytes.length) return CODE_DEFLATED + b64url(packed);
  return CODE_PLAIN + b64url(bytes);
}

async function unpackCode(text: string): Promise<unknown> {
  const s = text.trim().replace(/\s+/g, "");
  if (s.startsWith(CODE_DEFLATED)) {
    return JSON.parse(new TextDecoder().decode(await inflateRaw(unb64url(s.slice(CODE_DEFLATED.length)))));
  }
  if (s.startsWith(CODE_PLAIN)) {
    return JSON.parse(new TextDecoder().decode(unb64url(s.slice(CODE_PLAIN.length))));
  }
  throw new Error("That doesn't look like a StreamDrop connection code.");
}

/* ── invite / answer ─────────────────────────────────────────────── */

export async function encodeInvite(meta: InviteMeta, sdp: string): Promise<string> {
  const wire: InviteWire = { v: 5, t: "offer", ...meta, sdp };
  return packCode(wire);
}

export async function parseInvite(code: string): Promise<InviteWire> {
  const wire = (await unpackCode(code)) as Partial<InviteWire> & { t?: string };
  if (wire.v !== 5) throw new Error("This connection code is from a different version of StreamDrop.");
  if (wire.t !== "offer") throw new Error("That is a reply code — paste it on the sender's screen instead.");
  if (typeof wire.sdp !== "string" || !wire.sdp.includes("v=0")) throw new Error("The connection code is damaged (no session description).");
  if (typeof wire.codeFp !== "string" || !/^[0-9a-f]{64}$/.test(wire.codeFp)) throw new Error("The connection code is damaged (bad fingerprint).");
  if (typeof wire.shareId !== "string" || wire.shareId.length !== 7) throw new Error("The connection code is damaged (bad ID).");
  return {
    v: 5,
    t: "offer",
    sdp: wire.sdp,
    shareId: wire.shareId,
    codeFp: wire.codeFp,
    expiresAt: typeof wire.expiresAt === "number" ? wire.expiresAt : 0,
    maxDownloads: typeof wire.maxDownloads === "number" ? wire.maxDownloads : null,
    publicLabel: typeof wire.publicLabel === "string" ? wire.publicLabel : null,
  };
}

export async function encodeAnswer(codeFp: string, sdp: string): Promise<string> {
  const wire: AnswerWire = { v: 5, t: "answer", codeFp, sdp };
  return packCode(wire);
}

export async function parseAnswer(code: string): Promise<AnswerWire> {
  const wire = (await unpackCode(code)) as Partial<AnswerWire> & { t?: string };
  if (wire.v !== 5) throw new Error("This reply code is from a different version of StreamDrop.");
  if (wire.t !== "answer") throw new Error("That is a connection code — paste it on the receiver's screen instead.");
  if (typeof wire.sdp !== "string" || !wire.sdp.includes("v=0")) throw new Error("The reply code is damaged.");
  if (typeof wire.codeFp !== "string" || !/^[0-9a-f]{64}$/.test(wire.codeFp)) throw new Error("The reply code is damaged (bad fingerprint).");
  return { v: 5, t: "answer", codeFp: wire.codeFp, sdp: wire.sdp };
}

/* ── the channel adapter ─────────────────────────────────────────── */

export class RtcChannel implements BlockChannel {
  constructor(private readonly dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
  }

  get isOpen(): boolean {
    return this.dc.readyState === "open";
  }

  send(frame: string | Uint8Array<ArrayBuffer>): void {
    if (typeof frame === "string") this.dc.send(frame);
    else this.dc.send(frame);
  }

  waitForDrain(threshold: number): Promise<void> {
    if (this.dc.bufferedAmount <= threshold) return Promise.resolve();
    this.dc.bufferedAmountLowThreshold = 256 * 1024;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.dc.removeEventListener("bufferedamountlow", done);
        resolve();
      };
      this.dc.addEventListener("bufferedamountlow", done);
    });
  }

  onOpen(cb: () => void): void {
    if (this.isOpen) cb();
    else this.dc.addEventListener("open", () => cb(), { once: true });
  }

  onMessage(cb: (data: string | ArrayBuffer) => void): void {
    this.dc.addEventListener("message", (event: MessageEvent) => {
      cb(event.data as string | ArrayBuffer);
    });
  }

  onClose(cb: (reason: string) => void): void {
    this.dc.addEventListener("close", () => cb("the direct connection closed"));
  }

  close(): void {
    try {
      this.dc.close();
    } catch {
      /* already closed */
    }
  }
}

/* ── peer wiring ─────────────────────────────────────────────────── */

async function waitForIce(pc: RTCPeerConnection, timeoutMs = 4_000): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (): void => {
      if (timer) clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = (): void => {
      if (pc.iceGatheringState === "complete") done();
    };
    // A code must be self-contained (no trickle), so we wait for gathering to finish — but a
    // browser that stalls must not stall the share; host/STUN candidates are usually in by now.
    timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export interface SenderPeer {
  pc: RTCPeerConnection;
  channel: BlockChannel;
  invite: string;
  close: () => void;
}

/** Sender side: build the offer and the code that hands it out. */
export async function createInvite(meta: InviteMeta, iceServers: RTCIceServer[] = DEFAULT_ICE): Promise<SenderPeer> {
  const pc = new RTCPeerConnection({ iceServers });
  const dc = pc.createDataChannel("streamdrop", { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce(pc);
  const sdp = pc.localDescription?.sdp ?? "";
  const invite = await encodeInvite(meta, sdp);
  return {
    pc,
    channel: new RtcChannel(dc),
    invite,
    close: () => {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export interface ReceiverPeer {
  pc: RTCPeerConnection;
  channel: Promise<BlockChannel>;
  answer: string;
  meta: InviteWire;
}

/** Receiver side: consume the code, produce the reply code. */
export async function acceptInvite(code: string, iceServers: RTCIceServer[] = DEFAULT_ICE): Promise<ReceiverPeer> {
  const meta = await parseInvite(code);
  const pc = new RTCPeerConnection({ iceServers });
  const channel = new Promise<BlockChannel>((resolve) => {
    pc.addEventListener(
      "datachannel",
      (event: RTCDataChannelEvent) => resolve(new RtcChannel(event.channel)),
      { once: true },
    );
  });
  await pc.setRemoteDescription({ type: "offer", sdp: meta.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForIce(pc);
  return { pc, channel, answer: await encodeAnswer(meta.codeFp, pc.localDescription?.sdp ?? ""), meta };
}

/** Sender side: fold in the receiver's reply and let ICE connect the two devices. */
export async function applyAnswer(pc: RTCPeerConnection, code: string, expectFp: string): Promise<void> {
  const answer = await parseAnswer(code);
  if (answer.codeFp !== expectFp) {
    throw new Error("That reply belongs to a different transfer (or a different connection code).");
  }
  await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
}
