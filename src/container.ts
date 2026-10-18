/* StreamDrop v5 — the ciphertext container.
 *
 * The sender's file is never copied anywhere. We hold the original Blob and produce any
 * ciphertext range on demand: read that slice, encrypt it, hand it over, forget it. The
 * layout is the same container every earlier version used — `[header][block 0][block 1]…`
 * with the sealed manifest and an Ed25519 signature in the header — so the crypto core is
 * untouched and byte-compatibility is preserved.
 */
import {
  CHUNK_SIZE, blockLenFor, chunkCountFor, encryptChunkPadded, plainChunkLen, type SenderSet,
} from "./crypto";

export interface Geometry {
  header: Uint8Array<ArrayBuffer>;
  headerLen: number;
  sizeBytes: number;
  sizePlain: number;
  chunkCount: number;
  blockLens: number[];
  blockOffsets: number[];
}

/** Computes — never materialises — the ciphertext geometry a receiver will walk. */
export function geometryFor(source: Blob, header: Uint8Array<ArrayBuffer>): Geometry {
  const chunkCount = chunkCountFor(source.size);
  const blockLens: number[] = [];
  const blockOffsets: number[] = [];
  let acc = header.length;
  for (let i = 0; i < chunkCount; i++) {
    const len = blockLenFor(i, source.size);
    blockLens.push(len);
    blockOffsets.push(acc);
    acc += len;
  }
  return {
    header,
    headerLen: header.length,
    sizeBytes: acc,
    sizePlain: source.size,
    chunkCount,
    blockLens,
    blockOffsets,
  };
}

const MAX_CACHED_BLOCKS = 3; // ≤ 12 MiB of ciphertext in memory, worst case

export class CiphertextSource {
  private readonly cache = new Map<number, Uint8Array<ArrayBuffer>>();

  constructor(
    private readonly blob: Blob,
    private readonly set: SenderSet,
    readonly geom: Geometry,
  ) {}

  /** A byte range of the ciphertext, computed on the spot (header bytes come from memory). */
  async range(off: number, len: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!Number.isFinite(off) || !Number.isFinite(len) || off < 0 || len <= 0) {
      throw new Error("bad_range");
    }
    const start = Math.min(off, this.geom.sizeBytes);
    const end = Math.min(off + len, this.geom.sizeBytes);
    const out = new Uint8Array(Math.max(0, end - start));
    let cursor = start;
    let written = 0;

    if (cursor < this.geom.headerLen) {
      const take = Math.min(end, this.geom.headerLen) - cursor;
      out.set(this.geom.header.subarray(cursor, cursor + take), written);
      written += take;
      cursor += take;
    }

    while (cursor < end) {
      const index = this.blockAt(cursor);
      const block = await this.block(index);
      const blockStart = this.geom.blockOffsets[index] ?? 0;
      const localOff = cursor - blockStart;
      const take = Math.min(block.length - localOff, end - cursor);
      out.set(block.subarray(localOff, localOff + take), written);
      written += take;
      cursor += take;
    }
    return out;
  }

  /** Receivers walk a transfer front to back; a binary search finds the block in O(log n). */
  private blockAt(offset: number): number {
    const offsets = this.geom.blockOffsets;
    let lo = 0;
    let hi = offsets.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((offsets[mid] ?? 0) <= offset) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  private async block(index: number): Promise<Uint8Array<ArrayBuffer>> {
    const cached = this.cache.get(index);
    if (cached) return cached;
    const blockLen = this.geom.blockLens[index] ?? 0;
    const plainLen = plainChunkLen(index, this.geom.sizePlain);
    const start = index * CHUNK_SIZE;
    const raw = new Uint8Array(await this.blob.slice(start, start + plainLen).arrayBuffer());
    const cipher = await encryptChunkPadded(this.set.fek, raw, this.set.codeFp, index, blockLen);
    this.cache.set(index, cipher);
    while (this.cache.size > MAX_CACHED_BLOCKS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return cipher;
  }
}
