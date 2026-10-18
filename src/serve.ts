/* StreamDrop v5 — the sender's live session.
 *
 * This class is the whole "server": it owns the file, the keys, and the policy (window, caps,
 * Stop). Receivers reach it over a direct WebRTC channel, and every byte they get was encrypted
 * on this device the moment it was asked for. Nothing is stored anywhere else, so there is
 * nothing left over when the session stops.
 */
import { toHex, type SenderSet } from "./crypto";
import { CiphertextSource, type Geometry } from "./container";
import { SenderAgent, type BlockChannel, type Budget } from "./protocol";
import { applyAnswer as foldAnswer, createInvite, type InviteMeta, type SenderPeer } from "./rtc";

export type ServeState = "waiting" | "serving" | "stopped";

export interface ServeStats {
  downloads: number;
  requests: number;
  bytesOut: number;
  lastAt: number | null;
}

export interface ServeEvents {
  onState?: (state: ServeState, detail?: string) => void;
  onStats?: (stats: ServeStats) => void;
  /** A fresh connection code for the next receiver, or null while none is available. */
  onCode?: (code: string | null) => void;
}

export interface LiveOptions {
  expiresAt: number;
  maxDownloads: number | null;
  publicLabel: string | null;
  sealedManifestB64: string;
  /**
   * Put the key inside the connection code (the simple one-code flow) instead of leaving the
   * receiver to type it. Defaults to false so the safer two-channel behaviour is what you get
   * unless it is asked for explicitly.
   */
  embeddedKey?: boolean;
}

export class LiveSession {
  readonly source: CiphertextSource;
  readonly stats: ServeStats = { downloads: 0, requests: 0, bytesOut: 0, lastAt: null };
  events: ServeEvents = {};

  private readonly budget: Budget;
  private pending: SenderPeer | null = null;
  private readonly peers = new Map<RTCPeerConnection, SenderAgent>();
  private stopped = false;

  constructor(
    file: Blob,
    private readonly set: SenderSet,
    readonly geom: Geometry,
    readonly opts: LiveOptions,
  ) {
    this.source = new CiphertextSource(file, set, geom);
    this.budget = { dlCount: 0, maxDownloads: opts.maxDownloads, expiresAt: opts.expiresAt };
  }

  get isServing(): boolean {
    return this.peers.size > 0;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get code(): string | null {
    return this.pending?.invite ?? null;
  }

  get expiresAt(): number {
    return this.budget.expiresAt;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    this.events.onState?.("waiting");
    await this.rotateCode();
  }

  /**
   * A connection code admits exactly one receiver (one WebRTC offer is bound to one peer), so a
   * new code is minted after every connection and after every failed attempt.
   */
  async rotateCode(): Promise<void> {
    if (this.stopped) return;
    this.pending?.close();
    this.pending = null;
    this.events.onCode?.(null);

    if (Date.now() > this.budget.expiresAt) {
      this.stop("the download window closed");
      return;
    }
    if (this.budget.maxDownloads != null && this.budget.dlCount >= this.budget.maxDownloads) {
      this.stop("the download limit was reached");
      return;
    }

    const peer = await createInvite({
      shareId: this.set.shareId,
      codeFp: this.set.codeFp,
      expiresAt: this.budget.expiresAt,
      maxDownloads: this.budget.maxDownloads,
      publicLabel: this.opts.publicLabel,
      ...this.keyMeta(),
    });
    if (this.stopped) {
      peer.close();
      return;
    }
    this.pending = peer;
    this.events.onCode?.(peer.invite);
    peer.channel.onOpen(() => this.onPeerReady(peer));
    peer.pc.addEventListener("connectionstatechange", () => {
      const state = peer.pc.connectionState;
      if (this.pending !== peer) return;
      if (state === "failed") {
        this.pending = null;
        this.events.onState?.("waiting", "that receiver couldn't reach this device directly — a new code is ready");
        void this.rotateCode();
      }
      if (state === "closed") {
        this.pending = null;
        this.events.onCode?.(null);
      }
    });
  }

  /** Folds in the receiver's reply code. The human carried it back; now ICE does the rest. */
  async acceptAnswer(code: string): Promise<void> {
    const peer = this.pending;
    if (!peer) throw new Error("No connection code is waiting — press “New code” and send that one.");
    await foldAnswer(peer.pc, code, this.set.codeFp);
    this.events.onState?.("waiting", "reply accepted — connecting directly to the receiver");
  }

  /** Extends the promise the same way the sender's own dashboard does. */
  extendBy(hours: number): number {
    this.budget.expiresAt = Math.max(this.budget.expiresAt, Date.now()) + hours * 3600_000;
    return this.budget.expiresAt;
  }

  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending?.close();
    this.pending = null;
    for (const [pc] of this.peers) {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    }
    this.peers.clear();
    this.events.onCode?.(null);
    this.events.onState?.("stopped", reason);
  }

  private onPeerReady(peer: SenderPeer): void {
    if (this.stopped) {
      peer.close();
      return;
    }
    if (this.pending === peer) this.pending = null;

    const agent = new SenderAgent({
      shareId: this.set.shareId,
      codeFp: this.set.codeFp,
      publicLabel: this.opts.publicLabel,
      sealedManifestB64: this.opts.sealedManifestB64,
      source: this.source,
      budget: this.budget,
      onDownloadStart: (count) => {
        this.stats.downloads = count;
        this.stats.lastAt = Date.now();
        this.paint();
      },
      onBytesServed: (bytes) => {
        this.stats.requests++;
        this.stats.bytesOut += bytes;
        this.stats.lastAt = Date.now();
        this.paint();
      },
    });
    agent.attach(peer.channel);

    this.peers.set(peer.pc, agent);
    peer.channel.onClose(() => {
      this.peers.delete(peer.pc);
      this.paint();
    });
    peer.pc.addEventListener("connectionstatechange", () => {
      const state = peer.pc.connectionState;
      if (state === "failed" || state === "closed") {
        this.peers.delete(peer.pc);
        this.paint();
      }
    });

    this.paint();
    // Ready for the next receiver straight away: the code just used admits only its own peer.
    void this.rotateCode();
  }

  /** Key material for the next code: only when the one-code flow is on. */
  private keyMeta(): Pick<InviteMeta, "keyHex" | "halfAHex" | "halfBHex"> {
    if (!this.opts.embeddedKey) return {};
    const { halfA, halfB, transferKey } = this.set;
    if (halfA && halfB) return { halfAHex: toHex(halfA), halfBHex: toHex(halfB) };
    return { keyHex: toHex(transferKey) };
  }

  private paint(): void {
    this.events.onStats?.({ ...this.stats });
    this.events.onState?.(this.peers.size > 0 ? "serving" : "waiting");
  }
}

export type { BlockChannel };
