/* StreamDrop v5 — the transfer protocol, spoken directly between two devices.
 *
 * It is the same conversation the v4 relay used, minus the relay and minus HTTP: the receiver
 * asks for ranges, the sender answers with framed ciphertext. Both sides are plain code over an
 * abstract channel, so the whole protocol is unit-testable without a browser or a network.
 *
 *   receiver → sender   {"op":"begin"}                     open a download
 *   sender   → receiver {"op":"hello", …geometry, header}  what the receiver is about to pull
 *   receiver → sender   {"op":"read", id, off, len}        one range request
 *   sender   → receiver [u32 id][u32 off][payload]         ≤ 64 KiB frames of that range
 *   sender   → receiver {"op":"read-done", id, len}        that range is complete (len = bytes sent)
 *   receiver → sender   {"op":"end"}                       finished
 *   either   → other    {"op":"error", code, id?}          refusal
 */
import { CHUNK_SIZE } from "./crypto";
import type { CiphertextSource } from "./container";

/** One data-channel message: 64 KiB is the safe cross-browser ceiling. */
export const FRAME_CHUNK = 64 * 1024;
/**
 * Largest single range a receiver may request. A non-final ciphertext block is padded up to the
 * 256 KiB alignment (4 MiB + 28 bytes of GCM overhead rounds up to 4.25 MiB), so a cap of one
 * plaintext chunk would silently truncate every full block.
 */
export const MAX_RANGE = CHUNK_SIZE + 512 * 1024;
/** How long a range request may wait before the receiver gives up on the sender. */
export const READ_TIMEOUT_MS = 30_000;

export interface BlockChannel {
  readonly isOpen: boolean;
  send(frame: string | Uint8Array<ArrayBuffer>): void;
  /** Resolves once the channel's outbound queue is below `threshold` bytes. */
  waitForDrain(threshold: number): Promise<void>;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string | ArrayBuffer) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

/** Shared, mutable, and deliberately global to the session: the cap counts every download. */
export interface Budget {
  dlCount: number;
  maxDownloads: number | null;
  expiresAt: number;
}

export interface HelloFrame {
  op: "hello";
  shareId: string;
  codeFp: string;
  publicLabel: string | null;
  expiresAt: number;
  maxDownloads: number | null;
  dlCount: number;
  headerLen: number;
  sizeBytes: number;
  sizePlain: number;
  sealedManifest: string;
}

export interface SenderOptions {
  shareId: string;
  codeFp: string;
  publicLabel: string | null;
  sealedManifestB64: string;
  source: CiphertextSource;
  budget: Budget;
  onDownloadStart?: (dlCount: number) => void;
  onBytesServed?: (bytes: number) => void;
  onFatal?: (code: string) => void;
}

export class SenderAgent {
  private channel: BlockChannel | null = null;

  constructor(private readonly opts: SenderOptions) {}

  attach(channel: BlockChannel): void {
    this.channel = channel;
    channel.onMessage((data) => void this.onMessage(data));
    channel.onClose(() => {
      this.channel = null;
    });
  }

  stop(reason: string): void {
    this.channel?.close();
    this.channel = null;
    void reason;
  }

  private async onMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return; // receivers speak JSON only
    let msg: { op?: string; id?: number; off?: number; len?: number };
    try {
      msg = JSON.parse(data) as typeof msg;
    } catch {
      return;
    }

    switch (msg.op) {
      case "begin": {
        const refusal = this.refusal();
        if (refusal) return this.refuse(undefined, refusal);
        this.opts.budget.dlCount++;
        this.opts.onDownloadStart?.(this.opts.budget.dlCount);
        const geom = this.opts.source.geom;
        const hello: HelloFrame = {
          op: "hello",
          shareId: this.opts.shareId,
          codeFp: this.opts.codeFp,
          publicLabel: this.opts.publicLabel,
          expiresAt: this.opts.budget.expiresAt,
          maxDownloads: this.opts.budget.maxDownloads,
          dlCount: this.opts.budget.dlCount,
          headerLen: geom.headerLen,
          sizeBytes: geom.sizeBytes,
          sizePlain: geom.sizePlain,
          sealedManifest: this.opts.sealedManifestB64,
        };
        this.sendJson(hello);
        return;
      }
      case "read": {
        const id = Math.floor(Number(msg.id) || 0) >>> 0;
        const off = Math.max(0, Math.floor(Number(msg.off) || 0));
        const len = Math.max(1, Math.min(Math.floor(Number(msg.len) || 0), MAX_RANGE));
        const refusal = this.refusal();
        if (refusal) return this.refuse(id, refusal);
        try {
          const bytes = await this.opts.source.range(off, len);
          const ok = await this.sendRange(id, bytes);
          if (ok) {
            // Always terminate a range explicitly: a clamped or empty range must not leave the
            // receiver waiting for bytes that will never come.
            this.sendJson({ op: "read-done", id, len: bytes.length });
            this.opts.onBytesServed?.(bytes.length);
          }
        } catch {
          this.refuse(id, "read_failed");
          this.opts.onFatal?.("read_failed");
        }
        return;
      }
      case "end":
        return;
      default:
        return;
    }
  }

  /** Null when the transfer may still be served, otherwise the refusal code. */
  private refusal(): string | null {
    if (!this.channel?.isOpen) return "sender_offline";
    if (Date.now() > this.opts.budget.expiresAt) return "expired";
    const { maxDownloads, dlCount } = this.opts.budget;
    if (maxDownloads != null && dlCount >= maxDownloads) return "consumed";
    return null;
  }

  private refuse(id: number | undefined, code: string): void {
    this.sendJson(id === undefined ? { op: "error", code } : { op: "error", code, id });
  }

  private sendJson(message: unknown): void {
    try {
      this.channel?.send(JSON.stringify(message));
    } catch {
      /* the channel is gone; its close handler will deal with it */
    }
  }

  /** Frames one range with backpressure. Returns false if the channel died mid-send. */
  private async sendRange(id: number, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
    const channel = this.channel;
    if (!channel) return false;
    for (let off = 0; off < bytes.length; off += FRAME_CHUNK) {
      const payload = bytes.subarray(off, Math.min(off + FRAME_CHUNK, bytes.length));
      const frame = new Uint8Array(8 + payload.length);
      const view = new DataView(frame.buffer);
      view.setUint32(0, id, true);
      view.setUint32(4, off, true);
      frame.set(payload, 8);
      await channel.waitForDrain(4 * 1024 * 1024);
      if (!this.channel || !this.channel.isOpen) return false;
      try {
        channel.send(frame);
      } catch {
        return false;
      }
    }
    return true;
  }
}

export function parseFrame(data: ArrayBuffer | Uint8Array): { id: number; off: number; payload: Uint8Array<ArrayBuffer> } {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (view.length < 8) throw new Error("bad_frame");
  const head = new DataView(view.buffer, view.byteOffset, 8);
  return { id: head.getUint32(0, true), off: head.getUint32(4, true), payload: view.subarray(8) as Uint8Array<ArrayBuffer> };
}

interface PendingRead {
  buffer: Uint8Array<ArrayBuffer>;
  /** How many bytes this read should eventually hold — `buffer.length`, or less for a clamped range. */
  target: number;
  filled: number;
  resolve: (bytes: Uint8Array<ArrayBuffer>) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ReceiverAgent {
  hello: HelloFrame | null = null;
  fatal: string | null = null;

  private readonly pending = new Map<number, PendingRead>();
  private nextId = 1;
  private readonly helloWaiters: ((hello: HelloFrame) => void)[] = [];
  private readonly fatalHandlers: ((code: string) => void)[] = [];

  constructor(private readonly channel: BlockChannel) {
    channel.onMessage((data) => this.onMessage(data));
    channel.onClose(() => this.fail("sender_closed"));
  }

  onHello(cb: (hello: HelloFrame) => void): void {
    if (this.hello) cb(this.hello);
    else this.helloWaiters.push(cb);
  }

  isFatal(code: string): boolean {
    return this.fatal === code;
  }

  onFatal(cb: (code: string) => void): void {
    if (this.fatal) cb(this.fatal);
    else this.fatalHandlers.push(cb);
  }

  /** Open a download: the sender answers with `hello` (geometry + sealed header). */
  begin(): void {
    this.channel.send(JSON.stringify({ op: "begin" }));
  }

  end(): void {
    try {
      this.channel.send(JSON.stringify({ op: "end" }));
    } catch {
      /* already closed */
    }
  }

  read(off: number, len: number, timeoutMs = READ_TIMEOUT_MS): Promise<Uint8Array<ArrayBuffer>> {
    const id = this.nextId++ % 4_294_967_295;
    const buffer = new Uint8Array(len);
    return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("sender_timeout"));
      }, timeoutMs);
      this.pending.set(id, { buffer, target: len, filled: 0, resolve, reject, timer });
      try {
        this.channel.send(JSON.stringify({ op: "read", id, off, len }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("sender_offline"));
      }
    });
  }

  private onMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      let frame: ReturnType<typeof parseFrame>;
      try {
        frame = parseFrame(data);
      } catch {
        return;
      }
      const read = this.pending.get(frame.id);
      if (!read) return;
      read.buffer.set(frame.payload, frame.off);
      read.filled += frame.payload.length;
      if (read.filled >= read.target) this.settle(frame.id, read);
      return;
    }

    let msg: { op?: string; code?: string; id?: number; len?: number } & Partial<HelloFrame>;
    try {
      msg = JSON.parse(data) as typeof msg;
    } catch {
      return;
    }
    if (msg.op === "hello") {
      const hello = msg as HelloFrame;
      this.hello = hello;
      for (const cb of this.helloWaiters.splice(0)) cb(hello);
      return;
    }
    if (msg.op === "read-done") {
      const id = typeof msg.id === "number" ? msg.id : -1;
      const read = this.pending.get(id);
      if (!read) return;
      // `len` says how much the sender actually sent. It only ever shortens the target: frames
      // may still be in flight, and giving up on them would lose data that is on its way.
      if (typeof msg.len === "number") read.target = Math.max(0, Math.min(read.target, msg.len));
      if (read.filled >= read.target) this.settle(id, read);
      return;
    }
    if (msg.op === "error") {
      const code = typeof msg.code === "string" ? msg.code : "error";
      if (typeof msg.id === "number") {
        const read = this.pending.get(msg.id);
        if (read) {
          this.pending.delete(msg.id);
          clearTimeout(read.timer);
          read.reject(new Error(code));
        }
        return;
      }
      this.fail(code);
    }
  }

  /** Finishes a read: a short range resolves with what actually arrived, so the caller can tell. */
  private settle(id: number, read: PendingRead): void {
    this.pending.delete(id);
    clearTimeout(read.timer);
    const size = Math.min(read.filled, read.target);
    read.resolve(size === read.buffer.length ? read.buffer : read.buffer.slice(0, size));
  }

  private fail(code: string): void {
    if (!this.fatal) {
      this.fatal = code;
      for (const cb of this.fatalHandlers.splice(0)) cb(code);
    }
    for (const [, read] of this.pending) {
      clearTimeout(read.timer);
      read.reject(new Error(code));
    }
    this.pending.clear();
  }
}
