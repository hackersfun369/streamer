/* StreamDrop — Send.
 *
 * The whole screen is built around one idea: the fewer decisions, the better the transfer. Pick a
 * file, press one button, show one code. The key rides inside that code by default, so the
 * receiver never types anything; anyone who wants the older "key on its own channel" behaviour can
 * switch it on under Options.
 *
 * The file stays on this device. This tab *is* the server, so the code that gets handed out is a
 * single-use invitation to stream from here — and Stop (or closing the tab) ends it instantly.
 */
import {
  CHUNK_SIZE, buildHeader, chunkCountFor, createSender, b64, toHex,
  type SenderSet, type Manifest,
} from "./crypto";
import { geometryFor } from "./container";
import { LiveSession, type ServeState, type ServeStats } from "./serve";
import { el, fmtBytes, fmtEta, fmtSpeed, note, toast } from "./ui";
import { cameraAvailable, importQrImage, qrDataUrl, scanQrCamera } from "./qr";
import { saveVaultRow, downloadKeyBackup } from "./vault";

interface ActiveShare {
  session: LiveSession;
  set: SenderSet;
  manifest: Manifest;
  expiresAt: number;
  stats: ServeStats;
  /** True when the key is inside the code, so the receiver needs nothing else. */
  embeddedKey: boolean;
}

/** Module-level so a running share survives switching tabs inside the app (it dies with the page). */
let active: ActiveShare | null = null;

/** Set by the live share card so a paste anywhere in the app can finish the handshake. */
let replySink: ((text: string) => void) | null = null;

export function stopShare(codeFp: string): boolean {
  if (!active || active.set.codeFp !== codeFp) return false;
  active.session.stop("stopped by the sender");
  active = null;
  replySink = null;
  void releaseWakeLock();
  return true;
}

/** Which share (if any) this tab is serving right now — the transfers list's honest status source. */
export function servingCodeFp(): string | null {
  return active?.set.codeFp ?? null;
}

/** Local window extension; returns the new expiry if this tab is the one serving it. */
export function extendShare(codeFp: string, hours: number): number | null {
  if (!active || active.set.codeFp !== codeFp) return null;
  active.expiresAt = active.session.extendBy(hours);
  return active.expiresAt;
}

/* ── keeping the sender awake ─────────────────────────────────────
 * A sleeping phone kills the transfer, and this device is the source. Holding a screen wake lock
 * is the honest fix: it does exactly one thing, and it is released the moment sharing stops. */
let wakeLock: { release: () => Promise<void> } | null = null;

async function holdWakeLock(): Promise<void> {
  const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock;
  if (!wl || wakeLock) return;
  try {
    wakeLock = await wl.request("screen");
  } catch {
    /* denied, or the tab is in the background — not worth telling the user about */
  }
}

async function releaseWakeLock(): Promise<void> {
  const held = wakeLock;
  wakeLock = null;
  try {
    await held?.release();
  } catch {
    /* already gone */
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && active) void holdWakeLock();
});

/* ── pasting the reply from anywhere ─────────────────────────────── */
const looksLikeCode = (text: string): boolean => /^SDC[01]\./.test(text.trim());

document.addEventListener("paste", (event) => {
  if (!replySink) return;
  const target = event.target as HTMLElement | null;
  // Inside a text field the field's own input handler takes it; this is for pasting anywhere else.
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
  const text = event.clipboardData?.getData("text") ?? "";
  if (!looksLikeCode(text)) return;
  event.preventDefault();
  replySink(text);
});

/* ── the picker ──────────────────────────────────────────────────── */

export function initSend(root: HTMLElement = document.getElementById("screen-send") as HTMLElement): void {
  root.textContent = "";

  if (active) {
    const card = el("div", {});
    root.append(hero(active.manifest.name), card);
    renderShare(card, active);
    return;
  }

  const state = { file: null as File | null, busy: false };

  const drop = el("div", {
    class: "drop",
    role: "button",
    tabindex: "0",
    "aria-label": "Choose a file to send",
  },
    el("span", { class: "ico", text: "📄" }),
    el("span", { class: "t", text: "Choose a file" }),
    el("span", { class: "d", text: "or drop it here" }),
  );
  const fileInput = el("input", { type: "file", hidden: true, "aria-hidden": "true" });
  const chosen = el("div", { hidden: true });
  const sendBtn = el("button", { class: "btn primary block big", type: "button", text: "Create transfer", disabled: true });

  const pickCard = el("div", { class: "card stack" },
    drop, fileInput, chosen, sendBtn,
    el("p", { class: "hint tiny", text: "Your file is never uploaded — receivers stream the encrypted bytes from this tab." }),
  );

  /* ── options (everything that is not the happy path lives in here) ── */

  const windowSelect = el("select", null,
    el("option", { value: "1", text: "1 hour" }),
    el("option", { value: "6", text: "6 hours" }),
    el("option", { value: "24", text: "24 hours", selected: true }),
    el("option", { value: "168", text: "7 days" }),
  );
  const limitSelect = el("select", null,
    el("option", { value: "", text: "Unlimited", selected: true }),
    el("option", { value: "1", text: "One download" }),
    el("option", { value: "3", text: "3 downloads" }),
    el("option", { value: "10", text: "10 downloads" }),
  );
  const label = el("input", { type: "text", maxlength: "60", placeholder: "e.g. contract draft" });
  const split = el("input", { type: "checkbox" });
  const passphrase = el("input", { type: "password", placeholder: "at least 12 characters" });
  const separateKey = el("input", { type: "checkbox" });

  const options = el("details", { class: "advanced" },
    el("summary", { text: "Options" }),
    el("div", { class: "body" },
      el("div", { class: "row" },
        el("div", { class: "field grow" },
          el("label", { for: "opt-window", text: "Available for" }),
          windowSelect,
        ),
        el("div", { class: "field grow" },
          el("label", { for: "opt-limit", text: "Downloads" }),
          limitSelect,
        ),
      ),
      el("div", { class: "field" },
        el("label", { for: "opt-label", text: "Note for the receiver (optional)" }),
        label,
      ),
      el("label", { class: "check" },
        split,
        el("span", null,
          el("span", { class: "t", text: "Split key in two (2-of-2)" }),
          el("span", { class: "d", text: "Both halves are needed to open the file. Send them over two different channels." }),
        ),
      ),
      el("div", { class: "field" },
        el("label", { for: "opt-pass", text: "Backup passphrase (optional)" }),
        passphrase,
        el("p", { class: "hint tiny", text: "Writes a sealed copy of the key you can keep, in case you need to reopen this transfer later." }),
      ),
      el("label", { class: "check" },
        separateKey,
        el("span", null,
          el("span", { class: "t", text: "Keep the key out of the code" }),
          el("span", { class: "d", text: "Stronger: the code alone then cannot open the file, so the receiver has to receive the key on a second channel and type it in." }),
        ),
      ),
    ),
  );

  root.append(hero(), pickCard, options);

  const pick = (): void => fileInput.click();
  drop.addEventListener("click", pick);
  drop.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      e.preventDefault();
      pick();
    }
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) setFile(file);
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) setFile(file);
  });

  function setFile(file: File): void {
    state.file = file;
    drop.hidden = true;
    chosen.hidden = false;
    chosen.textContent = "";
    const change = el("button", { class: "btn ghost small", type: "button", text: "Change" });
    change.addEventListener("click", (e) => {
      e.stopPropagation();
      drop.hidden = false;
      chosen.hidden = true;
      state.file = null;
      sendBtn.disabled = true;
      fileInput.value = "";
    });
    chosen.append(
      el("div", { class: "file-row" },
        el("span", { class: "ico", text: "📦" }),
        el("div", { class: "grow" },
          el("div", { class: "name", text: file.name }),
          el("div", { class: "meta", text: `${fmtBytes(file.size)}${file.type ? ` · ${file.type}` : ""}` }),
        ),
        change,
      ),
    );
    sendBtn.disabled = file.size === 0;
    if (file.size === 0) note("That file is empty — pick one with content.", "err");
  }

  sendBtn.addEventListener("click", () => void start());

  async function start(): Promise<void> {
    if (state.busy || !state.file) return;
    const pw = passphrase.value;
    if (pw && pw.length < 12) {
      note("The backup passphrase needs at least 12 characters.", "err");
      passphrase.focus();
      return;
    }
    state.busy = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "Preparing…";

    try {
      const embeddedKey = !separateKey.checked;
      const set = await createSender({ split: split.checked, recoveryPassphrase: pw || undefined });
      const file = state.file;
      const expiresAt = Date.now() + Number(windowSelect.value) * 3600_000;
      const maxDownloads = limitSelect.value === "" ? null : Number(limitSelect.value);
      const manifest: Manifest = {
        v: 1,
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        chunkSize: CHUNK_SIZE,
        chunkCount: chunkCountFor(file.size),
        createdAt: Date.now(),
        expiresAt,
        receiverAuth: set.receiverAuth,
        mode: "direct",
      };
      const header = await buildHeader(set, manifest);
      const geom = geometryFor(file, header.bytes);

      const session = new LiveSession(file, set, geom, {
        expiresAt,
        maxDownloads,
        publicLabel: label.value.trim() || null,
        sealedManifestB64: b64(header.bytes),
        embeddedKey,
      });

      saveVaultRow({
        shareId: set.shareId,
        codeFp: set.codeFp,
        tkHex: toHex(set.transferKey),
        halfA: set.halfA ? toHex(set.halfA) : undefined,
        halfB: set.halfB ? toHex(set.halfB) : undefined,
        name: manifest.name,
        mime: manifest.mime,
        size: manifest.size,
        mode: "direct",
        createdAt: manifest.createdAt,
        expiresAt,
        maxDownloads,
        hasRecovery: !!set.recover,
      });

      active = { session, set, manifest, expiresAt, stats: { ...session.stats }, embeddedKey };
      await session.start();
      void holdWakeLock();

      root.textContent = "";
      const card = el("div", {});
      root.append(hero(file.name), card);
      renderShare(card, active);
      note("Transfer created — show the code to your receiver.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't create the transfer.";
      note(msg, "err");
      sendBtn.disabled = false;
      sendBtn.textContent = "Create transfer";
    } finally {
      state.busy = false;
    }
  }
}

function hero(fileName?: string): HTMLElement {
  return el("div", { class: "hero" },
    el("h1", null,
      fileName ? "Sending " : "Send a file. ",
      fileName
        ? el("span", { class: "accent", text: fileName })
        : el("span", { class: "accent", text: "Straight to them." }),
    ),
    el("p", {
      text: fileName
        ? "Show the code below to the person receiving it."
        : "No upload, no account, no copy left behind — the bytes go from this device to theirs.",
    }),
  );
}

/* ── the live share ──────────────────────────────────────────────── */

function renderShare(card: HTMLElement, share: ActiveShare): void {
  card.textContent = "";
  const { set, manifest, session } = share;

  const steps = el("div", { class: "steps" },
    el("div", { class: "seg active" }),
    el("div", { class: "seg" }),
    el("div", { class: "seg" }),
  );
  const segs = steps.children;
  const paintSteps = (n: 1 | 2 | 3): void => {
    for (let i = 0; i < 3; i++) {
      const seg = segs[i] as HTMLElement;
      seg.className = `seg${i + 1 < n ? " done" : ""}${i + 1 === n ? " active" : ""}`;
    }
  };

  const statusPill = el("span", { class: "pill live" }, el("span", { class: "pulse" }), el("span", { text: "Live" }));
  const statusText = el("span", { class: "hint" });
  const statsBox = el("div", { class: "stat-grid" });
  const stopBtn = el("button", { class: "btn danger", type: "button", text: "Stop sharing" });
  const backBtn = el("button", { class: "btn ghost", type: "button", text: "Send another file" });
  backBtn.addEventListener("click", () => {
    stopShare(set.codeFp);
    resetMeter();
    initSend();
  });

  const shareCard = el("div", { class: "card" },
    el("div", { class: "spread" },
      el("div", null,
        el("h2", { text: manifest.name }),
        el("p", { class: "hint", text: `${fmtBytes(manifest.size)} · ${manifest.mime}` }),
      ),
      statusPill,
    ),
    el("div", { class: "spread", style: "margin-top:14px" },
      el("span", { class: "share-id", text: set.shareId, "aria-label": `Transfer ${set.shareId}` }),
      el("span", { class: "hint", text: `open until ${new Date(share.expiresAt).toLocaleString()}` }),
    ),
    steps,
    el("div", { class: "status-line" }, statusText),
    statsBox,
    el("div", { class: "row", style: "margin-top:14px" },
      stopBtn,
      backBtn,
    ),
  );

  /* step 1 — the code that goes out */
  const qrHolder = el("div", { class: "qr-frame" });
  const codeField = el("textarea", { class: "code-box mono", rows: "3", readOnly: true, spellcheck: "false", "aria-label": "Connection code" });
  const codeHead = el("div", { class: "step-head active" },
    el("span", { class: "step-num", text: "1" }),
    el("div", { class: "step-text" },
      el("h3", { text: "Show this code to your receiver" }),
      el("p", { class: "hint", text: share.embeddedKey
        ? "They scan it with their camera — that is the whole setup. Treat it as the key to your file: anyone who gets it can download until you press Stop."
        : "They scan it with their camera. It only finds this device; the Transfer Key is separate and stays a secret." }),
    ),
  );
  const copyCode = el("button", { class: "btn", type: "button", text: "Copy code" });
  copyCode.addEventListener("click", () => void copyText(codeField.value, "Connection code copied"));
  const copyLink = el("button", { class: "btn ghost", type: "button", text: "Copy link" });
  copyLink.addEventListener("click", () => void copyText(
    `${location.origin}${location.pathname}#/receive?c=${encodeURIComponent(codeField.value)}`,
    "Link copied — send it however you like",
  ));

  const codeCard = el("div", { class: "card" },
    codeHead,
    qrHolder,
    codeField,
    el("div", { class: "row", style: "margin-top:12px" }, copyCode, copyLink),
  );

  /* step 2 — the reply that comes back */
  const answerField = el("textarea", {
    class: "code-box mono", rows: "3", spellcheck: "false",
    placeholder: "Paste their reply here", "aria-label": "Reply code from the receiver",
  });
  const answerStatus = el("p", { class: "hint" });
  const video = el("video", { hidden: true, playsinline: true, "aria-label": "Camera preview" });

  const scanBtn = el("button", { class: "btn primary", type: "button", text: "Scan their reply" });
  const pasteBtn = el("button", { class: "btn ghost small", type: "button", text: "Import a screenshot" });
  const hasCamera = cameraAvailable();
  if (!hasCamera) scanBtn.hidden = true;
  else scanBtn.addEventListener("click", () => void (async () => {
    try {
      const raw = await scanQrCamera(video);
      if (raw) await takeReply(raw);
    } catch {
      note("Camera unavailable — paste the reply instead.", "err");
    }
  })());
  pasteBtn.addEventListener("click", () => void (async () => {
    try {
      const raw = await importQrImage();
      if (raw) await takeReply(raw);
    } catch (e) {
      note(e instanceof Error ? e.message : "Couldn't read that image.", "err");
    }
  })());

  const step2Head = el("div", { class: "step-head active" },
    el("span", { class: "step-num", text: "2" }),
    el("div", { class: "step-text" },
      el("h3", { text: "Take their reply" }),
      el("p", { class: "hint", text: "They will show you a reply code. Scan it, or paste it here — it is not a secret." }),
    ),
  );
  const answerCard = el("div", { class: "card" },
    step2Head,
    answerField,
    el("div", { class: "row", style: "margin-top:12px" }, scanBtn, pasteBtn),
    video,
    answerStatus,
  );

  /* step 3 — only when the key travels separately */
  const keyCard = el("div", { class: "card", hidden: share.embeddedKey },
    el("div", { class: "step-head" },
      el("span", { class: "step-num", text: "3" }),
      el("div", { class: "step-text" },
        el("h3", { text: "Send the key on another channel" }),
        el("p", { class: "hint", text: "This is what opens the file, and it is deliberately not in the code. Send it by a different route than the code — a message, a call, in person." }),
      ),
    ),
  );
  if (share.set.halfA && share.set.halfB) {
    keyCard.append(
      keyLine("Half A", toHex(share.set.halfA)),
      keyLine("Half B", toHex(share.set.halfB)),
      el("p", { class: "hint tiny", text: "Split key: each half alone reveals nothing. Two different channels, please." }),
    );
  } else {
    keyCard.append(keyLine("Transfer Key", toHex(share.set.transferKey)));
  }

  /* advanced: the key, the backup, and the honest fine print */
  const advanced = el("details", { class: "advanced" },
    el("summary", { text: "Transfer details" }),
    el("div", { class: "body" },
      el("p", { class: "hint", text: "The file lives on this device only. Closing this tab, letting the phone sleep, or pressing Stop ends every download instantly — there is no server-side copy to fall back on." }),
    ),
  );
  const backupBtn = el("button", { class: "btn ghost small", type: "button", text: "Download key backup" });
  backupBtn.addEventListener("click", () => {
    if (!share.set.recover) return;
    downloadKeyBackup(set.shareId, share.set.recover.wrappedKey);
    toast("Backup saved — keep it wherever you keep secrets", "ok");
  });
  if (share.set.recover) (advanced.querySelector(".body") as HTMLElement).append(backupBtn);

  /* ── wiring ── */

  session.events = {
    onState: paintStatus,
    onStats: paintStats,
    onCode: (code) => void paintCode(code),
  };
  paintStats(share.stats);
  paintStatus(session.isServing ? "serving" : "waiting");
  void paintCode(session.code);

  replySink = (text) => void takeReply(text);

  stopBtn.addEventListener("click", () => {
    session.stop("stopped by the sender");
    active = null;
    replySink = null;
    void releaseWakeLock();
    statusPill.className = "pill bad";
    statusPill.textContent = "Stopped";
    stopBtn.disabled = true;
    note("Stopped — every connection is closed and the code is dead.");
  });

  function paintStatus(state: ServeState, detail?: string): void {
    const map: Record<ServeState, { text: string; pill: string; label: string; step: 1 | 2 | 3 }> = {
      waiting: {
        text: detail ?? (session.code ? "Waiting for a receiver to scan it." : "Preparing a fresh code…"),
        pill: "live",
        label: session.isServing ? "Connected" : "Live",
        step: session.peerCount > 0 ? 3 : 2,
      },
      serving: { text: "Connected — the bytes are on their way.", pill: "ok", label: "Transferring", step: 3 },
      stopped: { text: `Stopped${detail ? ` — ${detail}` : ""}.`, pill: "bad", label: "Stopped", step: 3 },
    };
    const view = map[state];
    statusText.textContent = view.text;
    statusPill.className = `pill ${view.pill}`;
    statusPill.textContent = "";
    if (view.pill === "live") statusPill.append(el("span", { class: "pulse" }));
    statusPill.append(el("span", { text: view.label }));
    paintSteps(view.step);
    if (state === "stopped") {
      stopBtn.disabled = true;
      answerCard.hidden = true;
      codeCard.hidden = true;
      keyCard.hidden = true;
    }
  }

  function paintStats(stats: ServeStats): void {
    const speed = meter(stats.bytesOut);
    statsBox.textContent = "";
    const add = (k: string, v: string): void => {
      statsBox.append(el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: v })));
    };
    add("Served", fmtBytes(stats.bytesOut));
    add("Speed", speed === null ? "—" : fmtSpeed(speed));
    add("Downloads", share.session.opts.maxDownloads != null ? `${stats.downloads} / ${share.session.opts.maxDownloads}` : String(stats.downloads));
    if (stats.bytesOut > 0 && manifest.size > 0) {
      const pct = Math.min(99.9, (stats.bytesOut / (manifest.size * 1.02)) * 100);
      const left = speed && speed > 0 ? Math.max(0, (manifest.size - stats.bytesOut) / speed) : NaN;
      add("Progress", `${pct.toFixed(0)} %${isFinite(left) ? ` · ${fmtEta(left)}` : ""}`);
    }
  }

  async function paintCode(code: string | null): Promise<void> {
    qrHolder.textContent = "";
    if (!code) {
      codeField.value = "";
      codeField.placeholder = session.isServing
        ? "A receiver is connected — a new code appears when they finish."
        : "Preparing a connection code…";
      return;
    }
    codeField.value = code;
    try {
      // 720 px of pixels shown at ~340 CSS px: crisp on any screen, still one small PNG.
      const dataUrl = await qrDataUrl(code, 720, "M");
      qrHolder.textContent = "";
      qrHolder.append(el("div", { class: "qr-tile" }, el("img", { src: dataUrl, alt: `Connection code for transfer ${set.shareId}` })));
    } catch {
      qrHolder.append(el("p", { class: "hint", text: "QR rendering unavailable — copy the code instead." }));
    }
  }

  async function takeReply(raw: string): Promise<void> {
    const text = (raw ?? "").trim();
    if (!text) return;
    answerField.value = text;
    answerStatus.textContent = "Checking that reply…";
    scanBtn.disabled = true;
    try {
      await session.acceptAnswer(text);
      answerStatus.textContent = "Connected — finishing the link to their device.";
      note("Reply accepted — connecting directly.", "ok");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "That reply code didn't work.";
      answerStatus.textContent = msg;
      note(msg, "err");
    } finally {
      scanBtn.disabled = false;
    }
  }

  answerField.addEventListener("input", () => {
    const value = answerField.value.trim();
    if (looksLikeCode(value)) void takeReply(value);
  });

  card.append(shareCard, codeCard, answerCard, keyCard, advanced);
}

function keyLine(title: string, value: string): HTMLElement {
  const field = el("textarea", { class: "code-box mono", rows: "2", readOnly: true, spellcheck: "false", "aria-label": title });
  field.value = value;
  const copy = el("button", { class: "btn small", type: "button", text: `Copy ${title}` });
  copy.addEventListener("click", () => void copyText(value, `${title} copied`));
  return el("div", { class: "stack", style: "margin-bottom:12px" },
    el("span", { class: "hint", text: title }),
    field, copy,
  );
}

async function copyText(text: string, message: string): Promise<void> {
  if (!text) {
    note("Nothing to copy yet.", "err");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(message, "ok");
  } catch {
    note("Copying failed — select the text and copy it manually.", "err");
  }
}

/* A tiny speed meter: bytes over time, smoothed, and honestly blank when nothing is moving. */
let meterAt = 0;
let meterBytes = 0;
let meterRate = 0;

function meter(bytes: number): number | null {
  const now = Date.now();
  if (meterAt === 0 || bytes < meterBytes) {
    meterAt = now;
    meterBytes = bytes;
    meterRate = 0;
    return null;
  }
  const dt = now - meterAt;
  if (dt >= 500) {
    const rate = ((bytes - meterBytes) / dt) * 1000;
    meterRate = meterRate === 0 ? rate : meterRate * 0.6 + rate * 0.4;
    meterAt = now;
    meterBytes = bytes;
  }
  return meterRate > 0 ? meterRate : null;
}

function resetMeter(): void {
  meterAt = 0;
  meterBytes = 0;
  meterRate = 0;
}

/* Closing the tab ends every download, so give the sender a chance to think twice. */
window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
  if (!active) return;
  e.preventDefault();
  e.returnValue = "";
});
