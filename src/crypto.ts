/*
 * StreamDrop client crypto (see docs/DESIGN.md §6.2).
 * All key material is generated and used only in the browser; the Worker never
 * sees the transfer key, the raw share ID, or any plaintext.
 */
import { ed25519 } from "@noble/curves/ed25519.js";

export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base-32
export const CHUNK_SIZE = 4 * 1024 * 1024; // plaintext bytes per chunk
export const HKDF_SALT = "StreamDrop v1";

const enc = new TextEncoder();

export type Mode = "relay" | "direct";

export interface Manifest {
  v: 1;
  name: string;
  mime: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  createdAt: number;
  expiresAt: number;
  receiverAuth: string;      // hex64 — checked client-side per transfer
  mode: Mode;
  // No blob location: v4 streams live from the sender's device (the "direct" QR kinds below
  // are legacy v2/v3 shapes kept so old codes still parse)
}

export interface SenderSet {
  shareId: string;           // 7 chars: 6 data + 1 checksum
  codeFp: string;            // hex64
  uploadSecret: string;      // hex64
  fek: CryptoKey;
  manifestKey: CryptoKey;
  signPriv: Uint8Array<ArrayBuffer>;
  signPub: Uint8Array<ArrayBuffer>;
  receiverAuth: string;      // hex64
  transferKey: Uint8Array<ArrayBuffer>;   // 32 bytes
  halfA?: Uint8Array<ArrayBuffer>;
  halfB?: Uint8Array<ArrayBuffer>;
  recover?: { wrappedKey: Uint8Array<ArrayBuffer>; salt: Uint8Array<ArrayBuffer>; tokenHash: string };
}

/* ── small utilities ─────────────────────────────────────────────── */

export const toHex = (b: Uint8Array<ArrayBuffer>): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const fromHex = (s: string): Uint8Array<ArrayBuffer> => {
  const clean = s.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const b64 = (b: Uint8Array<ArrayBuffer> | ArrayBuffer): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
};

export const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const sha256hex = async (input: string | Uint8Array<ArrayBuffer>): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof input === "string" ? enc.encode(input) : input)));

export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
};

async function hkdf(ikm: Uint8Array<ArrayBuffer>, info: string, len = 32): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode(HKDF_SALT), info: enc.encode(info) },
      key,
      len * 8,
    ),
  );
  return bits;
}

async function importKey(raw: Uint8Array<ArrayBuffer>, name: "AES-GCM"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, name, false, ["encrypt", "decrypt"]);
}

/* ── share code (6 data chars + 1 checksum char) ──────────────────── */

const codeChar = (idx: number): string => CODE_ALPHABET[idx % 32]!;
const codeIdx = (c: string): number => CODE_ALPHABET.indexOf(c);
const data6of = (code7: string): string => code7.slice(0, 6);

export function checksumChar(data6: string): string {
  let sum = 0;
  for (let i = 0; i < data6.length; i++) sum += (i + 1) * codeIdx(data6[i]!);
  return codeChar(sum);
}

export const hkdfCodeFp = async (shareId7: string): Promise<string> => {
  const code6 = shareId7.replace(/[^A-Z0-9]/g, "").slice(0, 6);
  return sha256hex(await hkdf(enc.encode(code6), "sd-v1-id"));
};

export const makeShareId = (): string => {
  const chars: string[] = [];
  for (let i = 0; i < 6; i++) {
    let r = 0;
    do {
      r = randomBytes(1)[0]!;
    } while (r >= 256 - (256 % 32)); // rejection sampling: unbiased 5-bit draw
    chars.push(codeChar(r));
  }
  const data6 = chars.join("");
  return data6 + checksumChar(data6);
}

/** Normalizes typed input: upper-case, O/I/L/U confusion fixes, junk stripping. */
export function normalizeCode(input: string): string | null {
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  s = s.replace(/O/g, "0").replace(/I/g, "1").replace(/L/g, "1").replace(/U/g, "V");
  let keep = "";
  for (const c of s) if (CODE_ALPHABET.includes(c)) keep += c; // strip chars outside the alphabet
  s = keep;
  if (s.length < 6) return null;
  const data6 = s.slice(0, 6);
  const full = s.length >= 7 ? data6 + s.slice(6, 7) : data6 + checksumChar(data6);
  if (full.length !== 7) return null;
  if (checksumChar(data6) !== full[6]) return null;
  return full;
}

/** Validates a half-code for split-key mode (independent of checksum rules). */
export function normalizeHalf(input: string): Uint8Array<ArrayBuffer> | null {
  return /^[0-9a-fA-F]{64}$/.test(input.trim()) ? fromHex(input.trim()) : null;
}

/* ── sender-side: create a full transfer identity ─────────────────── */

function xor32(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (a.length !== 32 || b.length !== 32) throw new Error("halves must be 32 bytes");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

export async function createSender(opts: {
  split?: boolean;
  recoveryPassphrase?: string;
}): Promise<SenderSet> {
  const shareId = makeShareId();
  let transferKey = randomBytes(32);
  let halfA: Uint8Array<ArrayBuffer> | undefined;
  let halfB: Uint8Array<ArrayBuffer> | undefined;
  if (opts.split) {
    halfA = randomBytes(32);
    halfB = xor32(halfA, transferKey);
  }

  const codeFp = await sha256hex(await hkdf(enc.encode(data6of(shareId)), "sd-v1-id"));
  const uploadSecret = toHex(await hkdf(transferKey, "sd-v1-upload"));
  const fek = await importKey(await hkdf(transferKey, "sd-v1-file"), "AES-GCM");
  const manifestKey = await importKey(await hkdf(transferKey, "sd-v1-manifest"), "AES-GCM");
  const signPriv = await hkdf(transferKey, "sd-v1-sign");
  const signPub = ed25519.getPublicKey(signPriv) as Uint8Array<ArrayBuffer>;
  const receiverAuth = toHex(await hkdf(transferKey, "sd-v1-receiver"));

  let recover: SenderSet["recover"];
  if (opts.recoveryPassphrase) {
    const salt = randomBytes(16);
    const wrapRaw = await pbkdf2(opts.recoveryPassphrase, salt);
    const wrapKey = await crypto.subtle.importKey("raw", wrapRaw, "AES-GCM", false, ["encrypt", "decrypt"]);
    const iv = randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, transferKey));
    // bundle layout: [wrapSalt(16)][iv(12)][ct]
    const wrappedKey = new Uint8Array(salt.length + iv.length + ct.length);
    wrappedKey.set(salt);
    wrappedKey.set(iv, salt.length);
    wrappedKey.set(ct, salt.length + iv.length);
    const tokenHash = await recoverTokenHash(opts.recoveryPassphrase);
    recover = { wrappedKey, salt, tokenHash };
  }

  return { shareId, codeFp, uploadSecret, fek, manifestKey, signPriv, signPub, receiverAuth, transferKey, halfA, halfB, recover };
}

async function pbkdf2(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations = 250_000): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      32 * 8,
    ),
  );
}

/* ── receiver-side: rebuild identities from ID + KEY ──────────────── */

export async function receiverKeySet(shareId7: string, transferKeyOrHalves: Uint8Array<ArrayBuffer> | [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>]) {
  let transferKey: Uint8Array<ArrayBuffer>;
  if (Array.isArray(transferKeyOrHalves)) {
    transferKey = xor32(transferKeyOrHalves[0]!, transferKeyOrHalves[1]!);
  } else {
    transferKey = transferKeyOrHalves;
  }
  const fek = await importKey(await hkdf(transferKey, "sd-v1-file"), "AES-GCM");
  const manifestKey = await importKey(await hkdf(transferKey, "sd-v1-manifest"), "AES-GCM");
  const signSeed = await hkdf(transferKey, "sd-v1-sign");
  const signPub = ed25519.getPublicKey(signSeed) as Uint8Array<ArrayBuffer>;
  const receiverAuth = toHex(await hkdf(transferKey, "sd-v1-receiver"));
  const codeFp = await sha256hex(await hkdf(enc.encode(data6of(shareId7)), "sd-v1-id"));
  return { transferKey, fek, manifestKey, signPub, receiverAuth, codeFp };
}

/* ── recovery token (fixed salt so the client can authenticate before seeing the bundle) ── */

const RECOVER_FIXED_SALT = new Uint8Array(16).fill(0);
RECOVER_FIXED_SALT.set(enc.encode("sd-v-recfx"));

export async function recoverTokenHash(passphrase: string): Promise<string> {
  const raw = await pbkdf2(passphrase, RECOVER_FIXED_SALT);
  return sha256hex(raw);
}

export async function unwrapTransferKey(wrapped: Uint8Array<ArrayBuffer>, passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const wrapRaw = await pbkdf2(passphrase, salt);
  const wrapKey = await crypto.subtle.importKey("raw", wrapRaw, "AES-GCM", false, ["decrypt"]);
  const iv = wrapped.slice(0, 12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, wrapKey, wrapped.slice(12)));
}

/* ── header building (sealed manifest + Ed25519 signature) ────────── */

export interface HeaderBlob {
  bytes: Uint8Array<ArrayBuffer>;         // full header to prepend to ciphertext
  headerLen: number;
  headerDigestHex: string;   // sha256 over header bytes without the 4-byte length prefix
  manifest: Manifest;
}

/** Header layout: [u32 LE hdrLen][manifestIv(12)][sealed manifest][sig(64)] */
export async function buildHeader(
  keys: Pick<SenderSet, "manifestKey" | "signPriv">,
  manifest: Manifest,
): Promise<HeaderBlob> {
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keys.manifestKey,
      enc.encode(JSON.stringify(manifest)),
    ),
  );

  const sealedLen = sealed.length;
  const headerLen = 4 + 12 + sealedLen + 64;
  const bytes = new Uint8Array(headerLen);

  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, headerLen, true);
  bytes.set(iv, 4);
  bytes.set(sealed, 16);
  const payload = new Uint8Array(sealed.length);
  payload.set(sealed);
  const signature = ed25519.sign(payload, keys.signPriv);
  bytes.set(signature, 16 + sealedLen);

  const digest = await sha256hex(bytes.slice(4));
  return { bytes, headerLen, headerDigestHex: digest, manifest };
}

/** Receiver parses + unseals + verifies a header. */
export async function unsealHeader(
  headerBytes: Uint8Array<ArrayBuffer>,
  keys: { manifestKey: CryptoKey; signPub: Uint8Array<ArrayBuffer> },
): Promise<Manifest> {
  const dv = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  const headerLen = dv.getUint32(0, true);
  if (headerLen !== headerBytes.byteLength) throw new Error("header length mismatch");
  const iv = headerBytes.slice(4, 16);
  const sig = headerBytes.slice(headerBytes.byteLength - 64);
  const sealed = headerBytes.slice(16, headerBytes.byteLength - 64);

  const ok = ed25519.verify(sig, sealed, keys.signPub);
  if (!ok) throw new Error("signature verification failed");

  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, keys.manifestKey, sealed),
  );
  const manifest = JSON.parse(new TextDecoder().decode(plain)) as Manifest;
  if (manifest.v !== 1) throw new Error("unsupported manifest version");
  return manifest;
}

/* ── chunk encryption / decryption ─────────────────────────────────── */

/* ── chunk geometry: GCM blocks padded to the 256 KiB Google-alignment ── */

const GCM_OVERHEAD = 12 + 16; // per-chunk iv + auth tag
const DRIVE_ALIGN = 256 * 1024; // every non-final upload block must be a multiple of this

export const plainChunkLen = (index: number, total: number): number =>
  Math.min(CHUNK_SIZE, Math.max(0, total - index * CHUNK_SIZE));

export const chunkCountFor = (total: number): number => Math.max(1, Math.ceil(total / CHUNK_SIZE));

/** Ciphertext-block length for chunk `index` of `total` (padding included, iv/tag included). */
export function blockLenFor(index: number, total: number): number {
  const plain = plainChunkLen(index, total);
  const raw = plain + GCM_OVERHEAD;
  if (plain === 0) return 0;
  const isLast = (index + 1) * CHUNK_SIZE >= total;
  return isLast ? raw : Math.ceil(raw / DRIVE_ALIGN) * DRIVE_ALIGN;
}

export function chunkAad(codeFp: string, index: number): Uint8Array<ArrayBuffer> {
  return enc.encode(`sd-v1-chunk|${codeFp}|${index}`);
}

export async function encryptChunkPadded(
  fek: CryptoKey,
  chunk: Uint8Array<ArrayBuffer>,
  codeFp: string,
  index: number,
  blockLen: number,
): Promise<Uint8Array<ArrayBuffer>> {
  // zero-pad the plaintext so the ciphertext block is 256 KiB aligned (Google requirement)
  const padded = new Uint8Array(blockLen - GCM_OVERHEAD);
  padded.set(chunk);
  return encryptChunk(fek, padded, codeFp, index);
}

export async function encryptChunk(
  fek: CryptoKey,
  chunk: Uint8Array<ArrayBuffer>,
  codeFp: string,
  index: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: chunkAad(codeFp, index) }, fek, chunk));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function decryptChunk(
  fek: CryptoKey,
  block: Uint8Array<ArrayBuffer>,
  codeFp: string,
  index: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = block.slice(0, 12);
  const ct = block.slice(12);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: chunkAad(codeFp, index) }, fek, ct),
  );
}

/* ── deep link / QR payloads ──────────────────────────────────────── */

export type QrPayload =
  | { kind: "plain"; shareId: string; keyHex: string }
  | { kind: "split"; shareId: string; halfAHex: string; halfBHex: string }
  | { kind: "direct"; shareId: string; keyHex: string; driveFileId: string }
  | { kind: "directSplit"; shareId: string; halfAHex: string; halfBHex: string; driveFileId: string };

export const qrEncode = (p: QrPayload): string => {
  switch (p.kind) {
    case "plain": return `SD|1|${p.shareId}|${p.keyHex}`;
    case "split": return `SD|2|${p.shareId}|${p.halfAHex}|${p.halfBHex}`;
    case "direct": return `SD|3|${p.shareId}|${p.keyHex}|${p.driveFileId}`;
    case "directSplit": return `SD|4|${p.shareId}|${p.halfAHex}|${p.halfBHex}|${p.driveFileId}`;
  }
};

export const qrParse = (s: string): QrPayload | null => {
  const parts = s.trim().split("|");
  if (parts[0] !== "SD") return null;
  const [, v, shareId, k1, k2, k3] = parts as unknown as [string, string, string, string, string, string];
  switch (v) {
    case "1": return { kind: "plain", shareId, keyHex: k1 };
    case "2": return { kind: "split", shareId, halfAHex: k1, halfBHex: k2 };
    case "3": return { kind: "direct", shareId, keyHex: k1, driveFileId: k2 };
    case "4": return { kind: "directSplit", shareId, halfAHex: k1, halfBHex: k2, driveFileId: k3 };
  }
  return null;
};
