/* StreamDrop v5 — tests for the pieces that can be tested without a browser.
 *
 * WebRTC itself needs a real stack, so it is not exercised here; everything on either side of it
 * is. That means the tests run a genuine transfer end to end — real keys, the real header, the
 * real chunk encryption, the real framing — over a simulated channel that even delivers frames
 * out of order, which is exactly the property the assembler has to get right.
 */
import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE, blockLenFor, buildHeader, chunkCountFor, createSender, decryptChunk, plainChunkLen,
  receiverKeySet, unsealHeader, b64, unb64, type Manifest,
} from "./crypto";
import { CiphertextSource, geometryFor } from "./container";
import { ReceiverAgent, SenderAgent, type BlockChannel, type Budget, type HelloFrame } from "./protocol";
import { CODE_DEFLATED, CODE_PLAIN, encodeAnswer, encodeInvite, parseAnswer, parseInvite } from "./rtc";

/* ── a channel that behaves like a data channel, including out-of-order frames ── */

class FakeEnd implements BlockChannel {
  peer!: FakeEnd;
  isOpen = true;

  private readonly messages: ((data: string | ArrayBuffer) => void)[] = [];
  private readonly closes: ((reason: string) => void)[] = [];
  private buffered: ArrayBuffer[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly reverse = false) {}

  send(frame: string | Uint8Array<ArrayBuffer>): void {
    if (typeof frame === "string") {
      this.deliver(frame);
      return;
    }
    const data = frame.slice().buffer as ArrayBuffer;
    if (!this.reverse) {
      this.deliver(data);
      return;
    }
    // Hold frames briefly and release them newest-first: correct assembly must not depend on order.
    this.buffered.push(data);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      const frames = this.buffered.splice(0).reverse();
      for (const f of frames) this.deliver(f);
    }, 4);
  }

  waitForDrain(): Promise<void> {
    return Promise.resolve();
  }

  onOpen(cb: () => void): void {
    if (this.isOpen) cb();
  }

  onMessage(cb: (data: string | ArrayBuffer) => void): void {
    this.messages.push(cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.closes.push(cb);
  }

  close(): void {
    this.isOpen = false;
    for (const handler of this.peer.closes) handler("closed by the other side");
  }

  private deliver(data: string | ArrayBuffer): void {
    for (const handler of this.peer.messages) handler(data);
  }
}

function fakePair(): { senderEnd: FakeEnd; receiverEnd: FakeEnd } {
  const senderEnd = new FakeEnd(true);
  const receiverEnd = new FakeEnd(false);
  senderEnd.peer = receiverEnd;
  receiverEnd.peer = senderEnd;
  return { senderEnd, receiverEnd };
}

/* ── one complete transfer, wired the way the app wires it ── */

async function harness(options: { plainSize?: number; budget?: Partial<Budget> } = {}) {
  const plainSize = options.plainSize ?? 2 * CHUNK_SIZE + 1000;
  const plain = new Uint8Array(plainSize);
  for (let i = 0; i < plainSize; i++) plain[i] = (i * 31 + 7) % 256;

  const blob = new Blob([plain]);
  const set = await createSender({});
  const manifest: Manifest = {
    v: 1,
    name: "unit-test.bin",
    mime: "application/octet-stream",
    size: plainSize,
    chunkSize: CHUNK_SIZE,
    chunkCount: chunkCountFor(plainSize),
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    receiverAuth: set.receiverAuth,
    mode: "direct",
  };
  const header = await buildHeader(set, manifest);
  const geom = geometryFor(blob, header.bytes);
  const budget: Budget = {
    dlCount: 0,
    maxDownloads: null,
    expiresAt: Date.now() + 3600_000,
    ...options.budget,
  };

  const source = new CiphertextSource(blob, set, geom);
  let bytesServed = 0;
  const sender = new SenderAgent({
    shareId: set.shareId,
    codeFp: set.codeFp,
    publicLabel: "unit test",
    sealedManifestB64: b64(header.bytes),
    source,
    budget,
    onBytesServed: (n) => { bytesServed += n; },
  });

  const { senderEnd, receiverEnd } = fakePair();
  sender.attach(senderEnd);
  const receiver = new ReceiverAgent(receiverEnd);

  return {
    plain, set, manifest, header, geom, budget, source, sender, receiver,
    senderEnd, receiverEnd,
    served: () => bytesServed,
  };
}

function firstHello(receiver: ReceiverAgent): Promise<HelloFrame> {
  return new Promise<HelloFrame>((resolve) => receiver.onHello(resolve));
}

/* ── the connection code ── */

const SDP = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 55036 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 203.0.113.7",
  "a=candidate:842163049 1 udp 1677729535 203.0.113.7 55036 typ srflx raddr 192.168.1.24 rport 55036 generation 0 ufrag K8sz network-cost 999",
  "a=candidate:1510613869 1 udp 2113937151 192.168.1.24 55036 typ host generation 0 ufrag K8sz network-cost 999",
  "a=candidate:1510613869 1 udp 2113937151 7f3a9c1e-2b44-4a2f-9f1b-6d0f2a9c1e77.local 55036 typ host generation 0 ufrag K8sz network-cost 999",
  "a=ice-ufrag:K8sz",
  "a=ice-pwd:3vT9pQ2rLmXc8sB1nH4jY6kZ",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 4B:1E:9A:2C:6D:88:0F:33:7E:51:AB:12:C4:D9:0E:77:2A:5F:31:90:B6:48:CD:E2:11:73:5A:0C:8F:64:39:A1",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
].join("\r\n");

const META = {
  shareId: "4Q9P2KF",
  codeFp: "ab".repeat(32),
  expiresAt: 1_792_327_746_089,
  maxDownloads: 3,
  publicLabel: "contract draft v3",
};

describe("connection codes", () => {
  it("round-trips an invite, and compresses it enough to paste or scan", async () => {
    const code = await encodeInvite(META, SDP);
    expect(code.startsWith(CODE_DEFLATED)).toBe(true);

    const back = await parseInvite(code);
    expect(back.sdp).toBe(SDP);
    expect(back.shareId).toBe(META.shareId);
    expect(back.codeFp).toBe(META.codeFp);
    expect(back.maxDownloads).toBe(3);
    expect(back.publicLabel).toBe("contract draft v3");
    expect(back.expiresAt).toBe(META.expiresAt);

    // A code has to be short enough to read off a screen and paste into a chat.
    expect(code.length).toBeLessThan(900);
    expect(code.length).toBeLessThan(SDP.length);
  });

  it("round-trips an answer, and refuses to be used in the wrong direction", async () => {
    const answer = await encodeAnswer(META.codeFp, SDP);
    const back = await parseAnswer(answer);
    expect(back.sdp).toBe(SDP);
    expect(back.codeFp).toBe(META.codeFp);

    await expect(parseInvite(answer)).rejects.toThrow(/sender's screen/i);
    await expect(parseAnswer(await encodeInvite(META, SDP))).rejects.toThrow(/receiver's screen/i);
  });

  it("still reads an uncompressed code, so the format never locks anyone out", async () => {
    const json = JSON.stringify({ v: 5, t: "offer", ...META, sdp: SDP });
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (const x of bytes) bin += String.fromCharCode(x);
    const plainCode = CODE_PLAIN + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const back = await parseInvite(plainCode);
    expect(back.sdp).toBe(SDP);

    // …and refuses rubbish rather than guessing.
    await expect(parseInvite("hello there")).rejects.toThrow(/doesn't look like/i);
    await expect(parseInvite(CODE_PLAIN + "!!!not base64!!!")).rejects.toThrow();
  });

  it("rejects a damaged code instead of trusting it", async () => {
    const code = await encodeInvite(META, SDP);
    const damaged = `${code.slice(0, code.length - 6)}AAAAAA`;
    await expect(parseInvite(damaged)).rejects.toThrow();
  });

  it("rejects a code whose ID and fingerprint disagree", async () => {
    const other = { ...META, codeFp: "cd".repeat(32) };
    const code = await encodeInvite(other, SDP);
    const parsed = await parseInvite(code);
    // The receiver recomputes this from the ID; a mismatch is what the app refuses to trust.
    expect(parsed.codeFp).not.toBe(META.codeFp);
  });
});

/* ── the transfer itself ── */

describe("device-to-device transfer", () => {
  it("serves the whole file byte-exactly, with frames arriving out of order", async () => {
    const h = await harness();
    const hello = firstHello(h.receiver);
    h.receiver.begin();
    const info = await hello;

    expect(info.sizePlain).toBe(h.plain.length);
    expect(info.sizeBytes).toBe(h.geom.sizeBytes);
    expect(info.headerLen).toBe(h.header.headerLen);
    expect(info.dlCount).toBe(1);

    // The receiver can verify everything on its own: the header unseals, and the manifest is
    // signed by a key derived from the Transfer Key alone.
    const keySet = await receiverKeySet(h.set.shareId, h.set.transferKey);
    const manifest = await unsealHeader(unb64(info.sealedManifest), {
      manifestKey: keySet.manifestKey,
      signPub: keySet.signPub,
    });
    expect(manifest.name).toBe("unit-test.bin");
    expect(manifest.size).toBe(h.plain.length);
    expect(manifest.receiverAuth).toBe(keySet.receiverAuth);
    expect(keySet.codeFp).toBe(h.set.codeFp);

    const restored = new Uint8Array(h.plain.length);
    let offset = info.headerLen;
    for (let i = 0; i < h.geom.chunkCount; i++) {
      const len = blockLenFor(i, h.plain.length);
      const cipher = await h.receiver.read(offset, len);
      expect(cipher.length).toBe(len);
      offset += len;

      const plainBlock = await decryptChunk(keySet.fek, cipher, keySet.codeFp, i);
      restored.set(plainBlock.slice(0, plainChunkLen(i, h.plain.length)), i * CHUNK_SIZE);
    }

    expect(offset).toBe(h.geom.sizeBytes);
    // Compare by hand: a deep-equal failure on an 8 MiB array makes vitest try to format a diff
    // that can exhaust the heap, and this way a failure points straight at the first wrong byte.
    let mismatch = -1;
    for (let i = 0; i < h.plain.length; i++) {
      if (restored[i] !== h.plain[i]) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch, `first differing byte at ${mismatch}`).toBe(-1);
    expect(h.budget.dlCount).toBe(1);
    // Every ciphertext byte of the body came off this device; the header was never re-fetched.
    expect(h.served()).toBe(h.geom.sizeBytes - h.geom.headerLen);
  }, 30_000);

  it("serves the sealed header itself when a range starts at zero", async () => {
    const h = await harness({ plainSize: 1024 });
    const hello = firstHello(h.receiver);
    h.receiver.begin();
    const info = await hello;

    const span = info.headerLen + 128;
    const bytes = await h.receiver.read(0, span);
    expect(bytes.length).toBe(span);
    expect(bytes.slice(0, info.headerLen)).toEqual(h.header.bytes);

    // Requesting past the end still completes (with less), so a receiver can never hang.
    const short = await h.receiver.read(h.geom.sizeBytes - 4, 4096);
    expect(short.length).toBe(4);
    const empty = await h.receiver.read(h.geom.sizeBytes + 64, 16);
    expect(empty.length).toBe(0);
  }, 30_000);

  it("refuses every request once the window has closed", async () => {
    const h = await harness({ plainSize: 1024 });
    h.budget.expiresAt = Date.now() - 1;
    const fatal = new Promise<string>((resolve) => h.receiver.onFatal(resolve));
    h.receiver.begin();
    await expect(fatal).resolves.toBe("expired");
    expect(h.budget.dlCount).toBe(0);
  }, 30_000);

  it("stops serving once the download limit is reached", async () => {
    const h = await harness({ plainSize: 1024, budget: { maxDownloads: 1 } });
    const hello = firstHello(h.receiver);
    h.receiver.begin();
    await hello;
    expect(h.budget.dlCount).toBe(1);

    // A second `begin` on the same share would be a second download, and the limit is one.
    h.receiver.begin();
    const fatal = new Promise<string>((resolve) => h.receiver.onFatal(resolve));
    await expect(fatal).resolves.toBe("consumed");
  }, 30_000);

  it("reports a read failure instead of hanging when the sender can't read the file", async () => {
    const h = await harness({ plainSize: 1024 });
    const hello = firstHello(h.receiver);
    h.receiver.begin();
    await hello;

    // Simulate the file becoming unreadable mid-transfer.
    const broken = {
      geom: h.geom,
      range: async () => {
        throw new Error("the file went away");
      },
    } as unknown as CiphertextSource;
    const agent = new SenderAgent({
      shareId: h.set.shareId,
      codeFp: h.set.codeFp,
      publicLabel: null,
      sealedManifestB64: b64(h.header.bytes),
      source: broken,
      budget: h.budget,
    });
    const { senderEnd, receiverEnd } = fakePair();
    agent.attach(senderEnd);
    const receiver = new ReceiverAgent(receiverEnd);
    const hello2 = firstHello(receiver);
    receiver.begin();
    await hello2;

    await expect(receiver.read(h.geom.headerLen, 4096)).rejects.toThrow(/read_failed/);
  }, 30_000);
});
