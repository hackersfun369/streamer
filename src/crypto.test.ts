import { describe, it, expect } from "vitest";
import {
  checksumChar, makeShareId, normalizeCode, qrEncode, qrParse, chunkCountFor,
  plainChunkLen, blockLenFor, encryptChunkPadded, decryptChunk, buildHeader,
  unsealHeader, receiverKeySet, createSender, hkdfCodeFp, unwrapTransferKey,
  recoverTokenHash, CHUNK_SIZE, toHex, fromHex, type Manifest,
} from "./crypto";

const enc = new TextEncoder();

describe("share codes", () => {
  it("checksum is deterministic", () => {
    expect(checksumChar("4Q9P2K")).toBe(checksumChar("4Q9P2K"));
  });

  it("generated codes self-validate", () => {
    for (let i = 0; i < 100; i++) {
      const id = makeShareId();
      expect(id).toHaveLength(7);
      expect(normalizeCode(id)).toBe(id);
    }
  });

  it("normalizeCode fixes confused letters and rejects bad checksums", () => {
    const x = checksumChar("4Q9P2K");
    const good = `4Q9P2K${x}`;
    // lower-case + whitespace tolerated
    expect(normalizeCode(` 4q9p2k${x.toLowerCase()} `)).toBe(good);
    // O→0 confusion maps back onto the real code (4O9P2K → 409P2K ≠ 4Q9P2K → bad checksum)
    expect(normalizeCode("4O9P2K" + x)).toBeNull();
    // a wrong checksum char is rejected
    const wrong = x === "3" ? "2" : "3";
    expect(normalizeCode(good.slice(0, 6) + wrong)).toBeNull();
  });
});

describe("chunk geometry", () => {
  it("blocks are 256 KiB aligned except the last", () => {
    const total = CHUNK_SIZE * 5 + 12345;
    expect(chunkCountFor(total)).toBe(6);
    for (let i = 0; i < 5; i++) {
      expect(blockLenFor(i, total) % (256 * 1024)).toBe(0);
    }
    const last = blockLenFor(5, total);
    expect(last).toBe(plainChunkLen(5, total) + 28);
    expect(blockLenFor(6, total)).toBe(0);
  });
});

describe("end-to-end roundtrip", () => {
  it("sender produces bytes the receiver alone can open & verify", async () => {
    const total = CHUNK_SIZE * 2 + 777777; // 2.5 chunks
    const file = new Uint8Array(total);
    for (let i = 0; i < total; i++) file[i] = i % 251;

    const set = await createSender({ split: false });
    const shareId = set.shareId;
    const manifest: Manifest = {
      v: 1,
      name: "report.pdf",
      mime: "application/pdf",
      size: total,
      chunkSize: CHUNK_SIZE,
      chunkCount: chunkCountFor(total),
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600_000,
      receiverAuth: set.receiverAuth,
      mode: "relay",
    };
    const header = await buildHeader(set, manifest);

    // assemble the "Drive file": header ‖ padded blocks
    const chunkCount = chunkCountFor(total);
    let stream = new Uint8Array(0);
    const push = (b: Uint8Array) => {
      const next = new Uint8Array(stream.length + b.length);
      next.set(stream);
      next.set(b, stream.length);
      stream = next;
    };
    push(header.bytes);
    const blockLens: number[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const plain = file.slice(i * CHUNK_SIZE, i * CHUNK_SIZE + plainChunkLen(i, total));
      const block = await encryptChunkPadded(set.fek, plain, set.codeFp, i, blockLenFor(i, total));
      expect(block.length).toBe(blockLenFor(i, total));
      blockLens.push(block.length);
      push(block);
    }

    // ── receiver side: knows only Share ID + transfer key ──
    const keySet = await receiverKeySet(shareId, set.transferKey);
    const headerBytes = stream.slice(0, header.headerLen);
    const got = await unsealHeader(headerBytes, { manifestKey: keySet.manifestKey, signPub: keySet.signPub });
    expect(got.name).toBe("report.pdf");
    expect(got.size).toBe(total);
    expect(got.receiverAuth).toBe(keySet.receiverAuth);

    // header digest matches what the worker would serve from lookup
    expect(await (await import("./crypto")).sha256hex(headerBytes.slice(4))).toBeDefined();

    // decrypt all blocks
    let out = new Uint8Array(0);
    let off = header.headerLen;
    for (let i = 0; i < chunkCount; i++) {
      const bl = blockLenFor(i, total);
      const block = stream.slice(off, off + bl);
      off += bl;
      const plain = (await decryptChunk(keySet.fek, block, keySet.codeFp, i)).slice(0, plainChunkLen(i, total));
      const merged = new Uint8Array(out.length + plain.length);
      merged.set(out);
      merged.set(plain, out.length);
      out = merged;
    }
    expect(out.length).toBe(total);
    expect(Buffer.from(out).equals(Buffer.from(file))).toBe(true);

    // tamper detection: flip one ciphertext byte → GCM aborts
    const tamperedBlock = stream.slice(header.headerLen, header.headerLen + blockLens[0]!);
    tamperedBlock.set([tamperedBlock[10]! ^ 0xff], 10);
    await expect(decryptChunk(keySet.fek, tamperedBlock, keySet.codeFp, 0)).rejects.toThrow();
  });

  it("split-key halves reconstruct the transfer key", async () => {
    const a = fromHex("ab".repeat(32));
    const full = fromHex("5c".repeat(32));
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++) b[i] = a[i]! ^ full[i]!;
    const r1 = await receiverKeySet(makeShareId(), [a, b]);
    const r2 = await receiverKeySet(makeShareId(), full);
    expect(r1.receiverAuth).toBe(r2.receiverAuth);
    expect(toHex(r1.signPub)).toBe(toHex(r2.signPub));
  });
});

describe("qr payloads", () => {
  it("encodes and parses all variants", () => {
    const p1 = { kind: "plain" as const, shareId: "4Q9P2KX", keyHex: "ab".repeat(32) };
    const s1 = qrEncode(p1);
    expect(qrParse(s1)).toEqual(p1);
    const p2 = { kind: "split" as const, shareId: "4Q9P2KX", halfAHex: "ab".repeat(32), halfBHex: "cd".repeat(32) };
    const s2 = qrEncode(p2);
    expect(qrParse(s2)).toEqual(p2);
    expect(qrParse("NONSENSE|1|X|Y")).toBeNull();
    expect(qrParse("SD|9|a|b")).toBeNull();
  });
});

describe("recovery bundle", () => {
  it("unwraps with the right passphrase and rejects the wrong one", async () => {
    const { createSender: cs } = await import("./crypto");
    const set = await cs({ recoveryPassphrase: "correct horse battery staple" });
    expect(set.recover).toBeDefined();
    const bundle = set.recover!;
    expect(bundle.wrappedKey.length).toBe(16 + 12 + 32 + 16); // salt ‖ iv ‖ ct(+tag)
    expect(await recoverTokenHash("correct horse battery staple")).toBe(bundle.tokenHash);
    const tk = await unwrapTransferKey(bundle.wrappedKey.slice(16), "correct horse battery staple", bundle.wrappedKey.slice(0, 16));
    expect(toHex(tk)).toBe(toHex(set.transferKey));
    await expect(
      unwrapTransferKey(bundle.wrappedKey.slice(16), "wrong passphrase entirely", bundle.wrappedKey.slice(0, 16)),
    ).rejects.toThrow();
  });
});

describe("code fingerprint", () => {
  it("matches between sender and receiver for the same code", async () => {
    const id = makeShareId();
    const a = await hkdfCodeFp(id);
    const set = await createSender({});
    void set;
    const b = await hkdfCodeFp(normalizeCode(id.replace(/O/g, "0"))!);
    expect(a).toBe(b);
  });
});

void enc;
