/* StreamDrop v5 — Send: the file stays on THIS device, and this device IS the server.
 *
 * Nothing is uploaded and nothing is registered anywhere. The sender hands out a "connection
 * code" (QR and/or text) that lets one receiver's device find this one directly; the receiver's
 * reply comes back, and from then on ciphertext is encrypted per request and streamed
 * device-to-device. Stop closes every connection at once, and there is no leftover copy.
 */
import {
  CHUNK_SIZE, buildHeader, chunkCountFor, createSender, b64, toHex,
  type SenderSet, type Manifest,
} from "./crypto";
import { geometryFor } from "./container";
import { LiveSession, type ServeState, type ServeStats } from "./serve";
import { announce, el, fmtBytes } from "./ui";
import { cameraAvailable, importQrImage, qrCard, scanQrCamera } from "./qr";
import { saveVaultRow, renderRecoveryCard, downloadKeyBackup } from "./vault";

interface ActiveShare {
  session: LiveSession;
  set: SenderSet;
  manifest: Manifest;
  expiresAt: number;
  stats: ServeStats;
}

/** Module-level so a running share survives switching tabs inside the app (it dies with the page). */
let active: ActiveShare | null = null;

/** Used by the dashboard's Kill button when the killed transfer is being served from here. */
export function stopShare(codeFp: string): boolean {
  if (!active || active.set.codeFp !== codeFp) return false;
  active.session.stop("stopped by the sender");
  active = null;
  return true;
}

/** Which share (if any) this tab is serving right now — the dashboard's honest status source. */
export function servingCodeFp(): string | null {
  return active?.set.codeFp ?? null;
}

/** Local window extension; returns the new expiry if this tab is the one serving it. */
export function extendShare(codeFp: string, hours: number): number | null {
  if (!active || active.set.codeFp !== codeFp) return null;
  active.expiresAt = active.session.extendBy(hours);
  return active.expiresAt;
}

export function initSend(root: HTMLElement = document.getElementById("screen-send") as HTMLElement): void {
  root.textContent = "";

  const state = { file: null as File | null, retention: 24, busy: false };

  const fileInput = el("input", { type: "file", id: "file", "aria-describedby": "file-hint" });
  const fileMeta = el("p", {
    class: "hint",
    id: "file-hint",
    text: "Any size. The file never leaves this device — receivers stream the encrypted bytes from this tab while it stays open.",
  });

  const retention = el("input", { type: "range", min: "1", max: "72", value: "24", id: "retention" });
  const retentionOut = el("output", { for: "retention", text: "24 h" });
  retention.addEventListener("input", () => {
    state.retention = Number(retention.value);
    retentionOut.value = `${state.retention} h`;
    announce(`Receivers may download for ${state.retention} hours`);
  });

  const burn = el("select", { id: "burn" },
    el("option", { value: "", text: "No download limit (expires on its own)" }),
    el("option", { value: "1", text: "One receiver only" }),
    el("option", { value: "3", text: "Allow 3 downloads" }),
    el("option", { value: "10", text: "Allow 10 downloads" }),
    el("option", { value: "custom", text: "Custom…" }),
  );
  const burnCustom = el("input", { type: "number", min: "1", max: "10000", value: "2", hidden: true, "aria-label": "Custom download limit" });
  burn.addEventListener("change", () => {
    burnCustom.hidden = burn.value !== "custom";
  });

  const label = el("input", { type: "text", maxlength: "64", placeholder: "Optional note visible to receivers before the key (e.g. 'contract draft v3')" });

  const split = el("input", { type: "checkbox", id: "split", "aria-describedby": "split-hint" });
  const passphrase = el("input", { type: "password", placeholder: "min 12 chars — seals a key backup you keep yourself" });

  const sendBtn = el("button", { class: "btn primary", type: "button", text: "Start sharing" });
  const status = el("p", { class: "hint", role: "status" });
  const resultCard = el("div", {});
  const recovery = el("div", {});

  const form = el("div", { class: "card" },
    el("h2", { text: "Send a file" }),
    el("p", { class: "hint", text: "Your file stays on this device. Receivers pull the encrypted bytes straight from this tab — nothing is uploaded, no account is needed, and no copy is stored anywhere." }),
    el("label", { for: "file", text: "File" }),
    fileInput, fileMeta,
    el("label", { for: "retention", text: "Receivers may download for" }),
    retention, retentionOut,
    el("p", { class: "hint", text: "Keep this tab open while a receiver downloads: the window below is the promise, but this device is the source. Closing it, sleeping the phone, or pressing Stop ends every download immediately." }),
    el("label", { for: "burn", text: "Download limit" }),
    el("div", null, burn, burnCustom),
    el("label", { for: "label", text: "Receiver note (optional)" }),
    label,
    el("div", { class: "row" },
      el("div", { class: "card", style: "margin:0" },
        el("label", { class: "hint", for: "split", text: "Split-key (2-of-2)" }),
        split,
        el("p", { class: "hint", id: "split-hint", text: "Splits the key into two halves to send over different channels. Both halves are required to open." }),
      ),
      el("div", { class: "card", style: "margin:0" },
        el("label", { class: "hint", for: "recovery", text: "Key backup passphrase (optional)" }),
        passphrase,
        el("p", { class: "hint", text: "Seals a backup file of your key with the passphrase (PBKDF2 ×250k + AES-GCM). You keep the file; only the passphrase unwraps it." }),
      ),
    ),
    sendBtn, status,
  );
  root.append(form, resultCard);
  renderRecoveryCard(recovery);
  root.append(recovery);

  fileInput.addEventListener("change", () => {
    state.file = fileInput.files?.[0] ?? null;
    if (state.file) {
      fileMeta.textContent = `${state.file.name} — ${fmtBytes(state.file.size)} (${state.file.type || "unknown type"})`;
    }
  });

  sendBtn.addEventListener("click", () => void doSend());
  if (active) renderShare(resultCard, active);

  async function doSend(): Promise<void> {
    if (state.busy) return;
    if (!state.file) {
      announce("Choose a file first", true);
      fileInput.focus();
      return;
    }
    if (state.file.size === 0) {
      announce("Empty files can't be transferred — pick a file with content.", true);
      return;
    }
    const pw = passphrase.value;
    if (pw && pw.length < 12) {
      announce("Key backup passphrase must be at least 12 characters", true);
      passphrase.focus();
      return;
    }
    state.busy = true;
    sendBtn.disabled = true;
    status.textContent = "Generating keys in this tab…";

    try {
      const set = await createSender({ split: split.checked, recoveryPassphrase: pw || undefined });
      const file = state.file;
      const expiresAt = Date.now() + state.retention * 3600_000;
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
      status.textContent = "Sealing the manifest…";
      const header = await buildHeader(set, manifest);
      const geom = geometryFor(file, header.bytes);

      const session = new LiveSession(file, set, geom, {
        expiresAt,
        maxDownloads: burnValue(),
        publicLabel: label.value || null,
        sealedManifestB64: b64(header.bytes),
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
        maxDownloads: burnValue(),
        hasRecovery: !!set.recover,
      });

      active = { session, set, manifest, expiresAt, stats: { ...session.stats } };
      renderShare(resultCard, active);
      await session.start();
      status.textContent = "";
      announce("Sharing is live. Send the connection code to your receiver and keep this tab open.");
    } catch (e) {
      status.textContent = "";
      announce(e instanceof Error ? e.message : "Send failed", true);
      resultCard.textContent = "";
      resultCard.append(el("p", { class: "hint", role: "alert", text: e instanceof Error ? e.message : "Send failed — see console." }));
    } finally {
      state.busy = false;
      sendBtn.disabled = false;
    }
  }

  function burnValue(): number | null {
    if (burn.value === "") return null;
    if (burn.value === "custom") return Math.max(1, Number(burnCustom.value) || 2);
    return Number(burn.value);
  }
}

/* ── the live share card ─────────────────────────────────────────────────────────────
 * Three numbered steps, because the handshake is genuinely conversational: send a code out,
 * take a reply back, hand over the key separately. The card rebuilds only the parts that
 * change, so a half-typed reply is never lost when a new code is minted.
 */
function renderShare(card: HTMLElement, share: ActiveShare): void {
  card.textContent = "";
  const { set, manifest, session } = share;

  const stateLine = el("p", { class: "hint", role: "status" });
  const statsLine = el("p", { class: "hint mono" });
  const stopBtn = el("button", { class: "btn danger small", type: "button", text: "Stop sharing" });

  const paintStatus = (state: ServeState, detail?: string): void => {
    const text: Record<ServeState, string> = {
      waiting: detail ? `Waiting for a receiver — ${detail}.` : "Sharing is live — send the connection code to a receiver.",
      serving: "Serving directly to a receiver's device.",
      stopped: `Sharing stopped${detail ? ` (${detail})` : ""}.`,
    };
    stateLine.textContent = text[state];
    stateLine.className = state === "stopped" ? "hint" : "hint ok";
    if (state === "stopped") stopBtn.disabled = true;
  };
  const paintStats = (stats: ServeStats): void => {
    share.stats = stats;
    statsLine.textContent = `${stats.downloads} download${stats.downloads === 1 ? "" : "s"} started · ${stats.requests} range request${stats.requests === 1 ? "" : "s"} · ${fmtBytes(stats.bytesOut)} served${stats.lastAt ? ` · last ${new Date(stats.lastAt).toLocaleTimeString()}` : ""}`;
  };

  session.events = {
    onState: paintStatus,
    onStats: paintStats,
    onCode: (code) => void paintCode(code),
  };
  paintStats(share.stats);
  paintStatus(session.isServing ? "serving" : "waiting");

  stopBtn.addEventListener("click", () => {
    session.stop("stopped by the sender");
    active = null;
    announce("Sharing stopped — every connection is closed and the codes are dead.");
  });

  /* ── codes and keys ── */

  const copyRow = (value: string | (() => string), label: string, title?: string): HTMLElement => {
    const read = (): string => (typeof value === "function" ? value() : value);
    const btn = el("button", { class: "btn small", type: "button", text: `Copy ${label}` });
    btn.addEventListener("click", async () => {
      const text = read();
      if (!text) {
        announce("Nothing to copy yet.", true);
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        announce(`${title ?? label} copied`);
        btn.textContent = "Copied ✓";
        setTimeout(() => (btn.textContent = `Copy ${label}`), 2000);
      } catch {
        announce("Copying failed — select the text and copy it manually.", true);
      }
    });
    return btn;
  };

  /* step 1 — the connection code out */
  const codeField = el("textarea", { class: "mono", rows: "3", readOnly: true, spellcheck: "false", "aria-label": "Connection code for the receiver" });
  const codeQr = el("div", { class: "qr-wrap" });
  const codeNote = el("p", { class: "hint", text: "Codes are single-use: one code admits exactly one receiver, and a fresh one appears as soon as somebody connects." });
  const newCodeBtn = el("button", { class: "btn small", type: "button", text: "New code" });
  newCodeBtn.addEventListener("click", () => void session.rotateCode());

  let paintToken = 0;
  async function paintCode(code: string | null): Promise<void> {
    const token = ++paintToken;
    codeQr.textContent = "";
    if (!code) {
      codeField.value = "";
      codeField.placeholder = session.isServing
        ? "A receiver is connected. A new code appears when they finish."
        : "Generating a connection code…";
      codeQr.append(el("p", { class: "hint", text: "No code is available right now." }));
      return;
    }
    codeField.value = code;
    const qr = await qrCard(code, `streamdrop-${set.shareId}-code.png`, `Connection code QR for transfer ${set.shareId}`, 340);
    if (token !== paintToken) return; // a newer code arrived while we were drawing
    codeQr.append(qr);
  }

  /* step 2 — the receiver's reply back in */
  const answerField = el("textarea", { rows: "3", spellcheck: "false", placeholder: "Paste the receiver's reply code here", "aria-label": "Reply code from the receiver" });
  const answerBtn = el("button", { class: "btn primary", type: "button", text: "Connect receiver" });
  const answerNote = el("p", { class: "hint" });
  const video = el("video", { hidden: true, playsinline: true, "aria-label": "Camera preview" });
  video.style.width = "260px";

  const importBtn = el("button", { class: "btn small", type: "button", text: "Import QR image" });
  importBtn.addEventListener("click", () => void (async () => {
    try {
      const raw = await importQrImage();
      if (!raw) return;
      await takeReply(raw);
    } catch (e) {
      announce(e instanceof Error ? e.message : "Couldn't read that image.", true);
    }
  })());

  const scanBtn = el("button", { class: "btn small", type: "button", text: "Scan QR", disabled: !cameraAvailable() });
  scanBtn.addEventListener("click", () => void (async () => {
    try {
      const raw = await scanQrCamera(video);
      if (!raw) return;
      await takeReply(raw);
    } catch {
      announce("Camera unavailable — paste the reply code or import a screenshot instead.", true);
    }
  })());

  answerBtn.addEventListener("click", () => void takeReply(answerField.value));

  async function takeReply(raw: string): Promise<void> {
    const text = (raw ?? "").trim();
    if (!text) {
      announce("Paste the receiver's reply code first.", true);
      answerField.focus();
      return;
    }
    answerBtn.disabled = true;
    try {
      answerField.value = text;
      await session.acceptAnswer(text);
      answerNote.textContent = "Reply accepted — finishing the direct connection. The receiver's screen will move on by itself.";
      announce("Reply accepted — connecting directly to the receiver.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't use that reply code.";
      answerNote.textContent = msg;
      announce(msg, true);
    } finally {
      answerBtn.disabled = false;
    }
  }

  /* step 3 — the secret, on its own channel */
  const keyCard = el("div", { class: "card" },
    el("h2", { text: "3 · Transfer Key — send this separately" }),
    el("p", { class: "hint", text: "The key is what actually opens the file, and it never travels with the connection code. Send it over a different channel than the code (chat vs email, or handed over in person). It is shown only here — store it now if you may need it later." }),
  );
  if (set.halfA && set.halfB) {
    keyCard.append(
      el("div", { class: "key-display mono", text: toHex(set.halfA) }),
      copyRow(toHex(set.halfA), "half A"),
      el("div", { class: "key-display mono", text: toHex(set.halfB) }),
      copyRow(toHex(set.halfB), "half B"),
      el("p", { class: "hint", text: "Split-key: each half alone reveals nothing. Send the halves over two different channels (e.g. chat + email)." }),
    );
  } else {
    keyCard.append(
      el("div", { class: "key-display mono", text: toHex(set.transferKey) }),
      el("div", { class: "row" }, copyRow(toHex(set.transferKey), "key", "Transfer Key")),
    );
  }
  const keyQr = el("div", { class: "qr-wrap" });
  const keyPayload = set.halfA && set.halfB
    ? `SD|2|${set.shareId}|${toHex(set.halfA)}|${toHex(set.halfB)}`
    : `SD|1|${set.shareId}|${toHex(set.transferKey)}`;
  keyCard.append(keyQr);
  void qrCard(keyPayload, `streamdrop-${set.shareId}-key.png`, `Transfer key QR for ${set.shareId}`, 300)
    .then((qr) => keyQr.append(qr))
    .catch(() => keyQr.append(el("p", { class: "hint", text: "QR rendering unavailable — copy the key text instead." })));

  if (set.recover) {
    const backupBtn = el("button", { class: "btn small", type: "button", text: `Download key backup (${set.shareId}.keybackup.json)` });
    backupBtn.addEventListener("click", () => {
      downloadKeyBackup(set.shareId, set.recover!.wrappedKey);
      announce("Key backup saved — keep it somewhere only you can reach.");
    });
    keyCard.append(
      el("p", { class: "hint", text: "Your backup passphrase seals the key in this file. Nothing else can open it, and no server is involved: store the file wherever you keep your secrets." }),
      backupBtn,
    );
  }

  /* the one-step convenience link (explicitly a weaker two-channel story) */
  const linkBtn = el("button", { class: "btn small", type: "button", text: "Copy receive link (code + key together)" });
  linkBtn.addEventListener("click", async () => {
    const code = session.code;
    if (!code) {
      announce("Wait for a connection code first.", true);
      return;
    }
    const params = new URLSearchParams({ c: code });
    if (set.halfA && set.halfB) {
      params.set("k1", toHex(set.halfA));
      params.set("k2", toHex(set.halfB));
    } else {
      params.set("k", toHex(set.transferKey));
    }
    const url = `${location.origin}${location.pathname}#/receive?${params.toString()}`;
    try {
      await navigator.clipboard.writeText(url);
      announce("Receive link copied — it carries the key, so treat it as a secret.");
    } catch {
      announce("Copying failed — use the two-step codes instead.", true);
    }
  });

  card.append(
    el("div", { class: "card" },
      el("h2", { text: `Sharing ${manifest.name}` }),
      el("p", { class: "hint", text: `${fmtBytes(manifest.size)} · ${manifest.mime} · nothing leaves this device unencrypted.` }),
      el("div", { class: "code-display", text: set.shareId, "aria-label": `Share ID ${set.shareId}` }),
      stateLine,
      statsLine,
      el("p", { class: "hint", text: `Promised until ${new Date(share.expiresAt).toLocaleString()}${share.session.opts.maxDownloads != null ? ` · up to ${share.session.opts.maxDownloads} download(s)` : ""}. This device must stay awake and this tab open, or downloads stop immediately.` }),
      stopBtn,
    ),
    el("div", { class: "card" },
      el("h2", { text: "1 · Connection code — to the receiver" }),
      el("p", { class: "hint", text: "The receiver pastes this into their Receive tab, scans the QR, or imports a screenshot of it. It is not secret, but it is single-use." }),
      codeField,
      el("div", { class: "row" }, copyRow(() => codeField.value, "code", "Connection code"), newCodeBtn),
      codeQr, codeNote,
    ),
    el("div", { class: "card" },
      el("h2", { text: "2 · The receiver's reply — back from them" }),
      el("p", { class: "hint", text: "Paste the reply they send you (or scan / import its QR). That is what lets the two devices find each other directly." }),
      answerField,
      el("div", { class: "row" }, answerBtn, scanBtn, importBtn),
      video, answerNote,
    ),
    keyCard,
    el("div", { class: "card" },
      el("h2", { text: "One-step alternative" }),
      el("p", { class: "hint", text: "This puts the code and the key in the same link, which is the one thing the security model avoids — convenient, but anyone who sees that link can open the file. Prefer the two steps above." }),
      linkBtn,
    ),
  );

  void paintCode(session.code);
}

/* Closing the tab ends every download, so give the sender a chance to think twice. */
window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
  if (!active) return;
  e.preventDefault();
  e.returnValue = "";
});
