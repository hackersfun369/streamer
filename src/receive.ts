/* StreamDrop v5 — Receive.
 *
 * Two things arrive separately, and that separation is the security model:
 *   1. a connection code  — finds the sender's device (not secret, single-use)
 *   2. a Transfer Key     — opens the file (secret, sent over a different channel)
 * The code goes in first and produces a reply code to send back; once the two devices are
 * talking directly, the receiver asks for one encrypted block at a time and verifies each one
 * with GCM before it is written anywhere.
 */
import {
  normalizeCode, receiverKeySet, unsealHeader, decryptChunk, hkdfCodeFp,
  plainChunkLen, blockLenFor, fromHex, unb64, qrParse,
  type Manifest,
} from "./crypto";
import { ReceiverAgent, type BlockChannel, type HelloFrame } from "./protocol";
import { acceptInvite } from "./rtc";
import { announce, el, fmtBytes, downloadBlob } from "./ui";
import { cameraAvailable, importQrImage, qrCard, scanQrCamera } from "./qr";

export function initReceive(root: HTMLElement = document.getElementById("screen-receive") as HTMLElement): void {
  root.textContent = "";

  const state = {
    agent: null as ReceiverAgent | null,
    hello: null as HelloFrame | null,
    headerBytes: null as Uint8Array<ArrayBuffer> | null,
    manifest: null as Manifest | null,
    keySet: null as Awaited<ReturnType<typeof receiverKeySet>> | null,
    shareId: "",
    codeFp: "",
    expiresAt: 0,
    pendingKeyText: null as string | null,
  };

  /** Set once the transfer card exists, so a deep link can fill the key field. */
  let pendingKey: { field: HTMLTextAreaElement; halfA: HTMLInputElement; halfB: HTMLInputElement } | null = null;

  /* ── step 1: the connection code ── */
  const codeField = el("textarea", {
    rows: "3", spellcheck: "false",
    placeholder: "Paste the connection code the sender gave you",
    "aria-label": "Connection code from the sender",
  });
  const useBtn = el("button", { class: "btn primary", type: "button", text: "Use this code" });
  const scanBtn = el("button", { class: "btn small", type: "button", text: "Scan QR", disabled: !cameraAvailable() });
  const importBtn = el("button", { class: "btn small", type: "button", text: "Import QR image" });
  const video = el("video", { hidden: true, playsinline: true, "aria-label": "Camera preview" });
  video.style.width = "260px";
  const codeNote = el("p", { class: "hint", role: "status" });

  const step1 = el("div", { class: "card" },
    el("h2", { text: "Receive a file" }),
    el("p", { class: "hint", text: "Nothing is stored on any server: the file streams straight from the sender's device. The connection code finds that device; the Transfer Key — which comes separately — is what opens the file." }),
    el("label", { text: "Connection code", for: "recv-code" }),
    codeField,
    el("div", { class: "row" }, useBtn, scanBtn, importBtn),
    video, codeNote,
  );
  const step2 = el("div", {});
  const progress = el("progress", { max: "100", value: "0", "aria-label": "Download progress" });
  const progressStatus = el("p", { class: "hint", role: "status" });
  const progressCard = el("div", { class: "card", hidden: true },
    el("h2", { text: "Downloading & decrypting" }),
    progress, progressStatus,
  );
  root.append(step1, step2, progressCard);

  useBtn.addEventListener("click", () => void useCode(codeField.value));
  importBtn.addEventListener("click", () => void (async () => {
    try {
      const raw = await importQrImage();
      if (!raw) return;
      codeField.value = raw;
      await useCode(raw);
    } catch (e) {
      announce(e instanceof Error ? e.message : "Couldn't read that image.", true);
    }
  })());
  scanBtn.addEventListener("click", () => void (async () => {
    try {
      const raw = await scanQrCamera(video);
      if (!raw) return;
      codeField.value = raw;
      await useCode(raw);
    } catch {
      announce("Camera unavailable — paste the code or import a screenshot instead.", true);
    }
  })());

  /* deep link: #/receive?c=<code>&k=<key> (or k1/k2 halves) */
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const deepCode = q.get("c");
  const deepKey = q.get("k");
  const deepK1 = q.get("k1");
  const deepK2 = q.get("k2");
  if (deepCode) {
    codeField.value = deepCode;
    void (async () => {
      await useCode(deepCode);
      if (deepKey) prefillKey(deepKey);
      else if (deepK1 && deepK2) prefillKey(`SD|2|${state.shareId}|${deepK1}|${deepK2}`);
    })();
  }

  async function useCode(raw: string): Promise<void> {
    const text = (raw ?? "").trim().replace(/\s+/g, "");
    if (!text) {
      announce("Paste the connection code the sender gave you.", true);
      codeField.focus();
      return;
    }
    useBtn.disabled = true;
    step2.textContent = "";
    codeNote.textContent = "";
    try {
      const peer = await acceptInvite(text);
      // The ID travels inside the code: check it against its fingerprint before trusting it.
      const fp = await hkdfCodeFp(peer.meta.shareId);
      if (fp !== peer.meta.codeFp) throw new Error("That connection code is damaged — ask the sender for a fresh one.");
      state.shareId = peer.meta.shareId;
      state.codeFp = peer.meta.codeFp;
      state.expiresAt = peer.meta.expiresAt;
      announce(`Code accepted for transfer ${peer.meta.shareId}. Send the reply code back to the sender.`);
      renderReplyCard(peer.answer, peer.meta.publicLabel);
      // A direct connection can genuinely fail (some mobile/corporate networks refuse it). Say so
      // plainly instead of leaving the receiver staring at a spinner.
      peer.pc.addEventListener("connectionstatechange", () => {
        if (peer.pc.connectionState !== "failed") return;
        const msg = "Couldn't reach the sender's device directly — some networks block this. Ask them for a fresh connection code, or try a different network.";
        codeNote.textContent = msg;
        announce(msg, true);
      });
      void peer.channel.then((channel) => onConnected(channel));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't use that connection code.";
      codeNote.textContent = msg;
      announce(msg, true);
      step2.append(el("div", { class: "card", role: "alert" },
        el("h2", { text: "Connection code not usable" }),
        el("p", { text: msg }),
      ));
    } finally {
      useBtn.disabled = false;
    }
  }

  /** The reply is small; it goes back over the same chat the code came from. */
  function renderReplyCard(answer: string, publicLabel: string | null): void {
    step2.textContent = "";
    const field = el("textarea", { class: "mono", rows: "3", readOnly: true, spellcheck: "false", "aria-label": "Reply code to send back" });
    field.value = answer;
    const copy = el("button", { class: "btn", type: "button", text: "Copy reply code" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(answer);
        announce("Reply code copied — send it back to the sender.");
      } catch {
        announce("Copying failed — select the text and copy it manually.", true);
      }
    });
    const wait = el("p", { class: "hint", role: "status", text: "Waiting for the sender to accept this reply…  the transfer continues here by itself." });
    const qr = el("div", { class: "qr-wrap" });
    step2.append(el("div", { class: "card" },
      el("h2", { text: `1 · Reply code for ${state.shareId}` }),
      el("p", { class: "hint", text: "Send this back to the sender exactly as it is (or let them scan / import the QR). It is not secret — it only tells your device and theirs how to reach each other." }),
      publicLabel ? el("p", null, el("em", { text: publicLabel })) : el("span", {}),
      field,
      el("div", { class: "row" }, copy),
      qr, wait,
    ));
    void qrCard(answer, `streamdrop-${state.shareId}-reply.png`, `Reply code QR for ${state.shareId}`, 300)
      .then((node) => qr.append(node))
      .catch(() => qr.append(el("p", { class: "hint", text: "QR rendering unavailable — copy the text instead." })));
  }

  function onConnected(channel: BlockChannel): void {
    if (!state.agent) {
      const agent = new ReceiverAgent(channel);
      state.agent = agent;
      agent.onFatal((code) => {
        const msg = reasonText(code);
        progressCard.hidden = true;
        step2.append(el("p", { class: "hint", role: "alert", text: msg }));
        announce(msg, true);
      });
      agent.onHello((hello) => renderTransferCard(hello));
      agent.begin();
    }
  }

  /* ── step 2: the key, then the bytes ── */

  function renderTransferCard(hello: HelloFrame): void {
    state.hello = hello;
    state.headerBytes = unb64(hello.sealedManifest);
    const keyField = el("textarea", { rows: "2", spellcheck: "false", placeholder: "Paste the Transfer Key (or scan / import its QR)", "aria-label": "Transfer key" });
    const halfA = el("input", { type: "text", spellcheck: "false", placeholder: "Half A (64 hex)", hidden: true, "aria-label": "Half A" });
    const halfB = el("input", { type: "text", spellcheck: "false", placeholder: "Half B (64 hex)", hidden: true, "aria-label": "Half B" });
    const keyVideo = el("video", { hidden: true, playsinline: true, "aria-label": "Camera preview" });
    keyVideo.style.width = "260px";
    const unlockBtn = el("button", { class: "btn primary", type: "button", text: "Unlock & verify" });
    const keyNote = el("p", { class: "hint", role: "status" });

    keyField.addEventListener("input", () => {
      const p = qrParse(keyField.value);
      if (!p) return;
      if (p.kind === "plain") keyField.value = p.keyHex;
      if (p.kind === "split" || p.kind === "directSplit") {
        halfA.hidden = false;
        halfB.hidden = false;
        halfA.value = p.halfAHex;
        halfB.value = p.halfBHex;
        keyField.value = "";
      }
      announce("Key QR recognized — press Unlock & verify.");
    });

    const keyScan = el("button", { class: "btn small", type: "button", text: "Scan key QR", disabled: !cameraAvailable() });
    keyScan.addEventListener("click", () => void (async () => {
      try {
        const raw = await scanQrCamera(keyVideo);
        if (raw) {
          keyField.value = raw;
          keyField.dispatchEvent(new Event("input"));
        }
      } catch {
        announce("Camera unavailable — paste the key instead.", true);
      }
    })());
    const keyImport = el("button", { class: "btn small", type: "button", text: "Import key QR image" });
    keyImport.addEventListener("click", () => void (async () => {
      try {
        const raw = await importQrImage();
        if (raw) {
          keyField.value = raw;
          keyField.dispatchEvent(new Event("input"));
        }
      } catch (e) {
        announce(e instanceof Error ? e.message : "Couldn't read that image.", true);
      }
    })());

    // Keep references so a deep link can prefill the key before the user presses anything.
    pendingKey = { field: keyField, halfA, halfB };
    if (state.pendingKeyText) {
      keyField.value = state.pendingKeyText;
      keyField.dispatchEvent(new Event("input"));
      state.pendingKeyText = null;
    }

    unlockBtn.addEventListener("click", () => void unlock());

    step2.prepend(el("div", { class: "card" },
      el("h2", { text: `2 · Connected to ${hello.shareId} — supply the Transfer Key` }),
      el("p", { class: "hint", text: `${hello.publicLabel ? `“${hello.publicLabel}” · ` : ""}the file is ${fmtBytes(hello.sizePlain)} and nothing is readable until the key arrives. Promised until ${hello.expiresAt ? new Date(hello.expiresAt).toLocaleString() : "—"}${hello.maxDownloads != null ? ` · download ${hello.dlCount} of ${hello.maxDownloads}` : ""}.` }),
      el("label", { text: "Transfer Key", for: "recv-key" }),
      keyField,
      el("div", { class: "row" }, halfA, halfB),
      el("div", { class: "row" }, unlockBtn, keyScan, keyImport),
      keyVideo, keyNote,
    ));

    async function unlock(): Promise<void> {
      try {
        if (!state.headerBytes) throw new Error("No transfer metadata yet — reconnect with a fresh code.");
        let key: Uint8Array<ArrayBuffer> | [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>];
        if (!halfA.hidden) {
          const a = /^[0-9a-fA-F]{64}$/.test(halfA.value.trim()) ? fromHex(halfA.value.trim()) : null;
          const b = /^[0-9a-fA-F]{64}$/.test(halfB.value.trim()) ? fromHex(halfB.value.trim()) : null;
          if (!a || !b) throw new Error("Both halves are required — 64 hex characters each.");
          key = [a, b];
        } else if (/^[0-9a-fA-F]{64}$/.test(keyField.value.trim())) {
          key = fromHex(keyField.value.trim());
        } else {
          throw new Error("Paste the 64-hex Transfer Key, or use the two halves.");
        }

        const norm = normalizeCode(state.shareId);
        if (!norm) throw new Error("The connection code carried an invalid ID.");
        const keySet = await receiverKeySet(norm, key);
        const manifest = await unsealHeader(state.headerBytes, { manifestKey: keySet.manifestKey, signPub: keySet.signPub });
        if (manifest.receiverAuth !== keySet.receiverAuth) throw new Error("This key doesn't open that transfer.");
        state.keySet = keySet;
        state.manifest = manifest;
        keyNote.textContent = "";
        announce(`Unlocked: ${manifest.name} (${fmtBytes(manifest.size)}).`);
        renderDownloadCard(manifest);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unlock failed";
        keyNote.textContent = msg;
        announce(msg, true);
      }
    }
  }

  function renderDownloadCard(manifest: Manifest): void {
    const dlBtn = el("button", { class: "btn primary", type: "button", text: `Download & verify (${fmtBytes(manifest.size)})` });
    dlBtn.addEventListener("click", () => void doDownload(dlBtn));
    step2.prepend(el("div", { class: "card" },
      el("h2", { text: "Unlocked — signature verified" }),
      el("p", null, el("strong", { text: manifest.name })),
      el("p", { class: "hint", text: `${fmtBytes(manifest.size)} · ${manifest.mime} · sender-verified (Ed25519) · promised until ${manifest.expiresAt ? new Date(manifest.expiresAt).toLocaleString() : "—"}` }),
      el("p", { class: "hint", text: "The bytes come live from the sender's device, so they must keep the share open until you finish." }),
      dlBtn,
    ));
  }

  async function doDownload(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    progressCard.hidden = false;
    progress.value = 0;
    progressStatus.textContent = "Asking the sender's device for the first block…";
    const agent = state.agent;
    const keySet = state.keySet;
    const manifest = state.manifest;
    if (!agent || !keySet || !manifest) {
      progressCard.hidden = true;
      btn.disabled = false;
      return;
    }
    let sink: Sink | null = null;
    try {
      sink = await makeSink(manifest.name);
      let offset = state.hello!.headerLen;
      let written = 0;
      for (let i = 0; i < manifest.chunkCount; i++) {
        const len = blockLenFor(i, manifest.size);
        const bytes = await pullBlock(agent, offset, len);
        offset += len;
        const plain = await decryptChunk(keySet.fek, bytes, keySet.codeFp, i);
        const want = plainChunkLen(i, manifest.size);
        await sink.write(plain.slice(0, want));
        written += want;
        const pct = Math.round((written / manifest.size) * 100);
        progress.value = pct;
        progressStatus.textContent = `${pct}% — GCM-verified, straight from the sender's device`;
      }
      if (sink.type === "picker") await sink.finish();
      announce(`Downloaded and verified: ${manifest.name}`);
      progressCard.hidden = true;
      agent.end();
    } catch (e) {
      await sink?.abort?.();
      const msg = e instanceof Error ? e.message : "Download failed";
      progressCard.hidden = true;
      step2.append(el("p", { class: "hint", role: "alert", text: msg }));
      announce(msg, true);
    } finally {
      btn.disabled = false;
    }
  }

  /** One block per request. A slow sender gets one retry before we call it a stall. */
  async function pullBlock(agent: ReceiverAgent, offset: number, len: number): Promise<Uint8Array<ArrayBuffer>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await agent.read(offset, len);
      } catch (e) {
        const code = e instanceof Error ? e.message : "";
        if (code !== "sender_timeout" || attempt === 1) throw new Error(reasonText(code));
        progressStatus.textContent = "The sender's device is slow — retrying that block…";
        continue;
      }
      if (bytes.length !== len) {
        throw new Error("The sender's device sent a short block — it may have gone offline mid-transfer.");
      }
      return bytes;
    }
    throw new Error(reasonText("sender_timeout"));
  }

  function prefillKey(raw: string): void {
    if (!pendingKey) {
      state.pendingKeyText = raw;
      return;
    }
    pendingKey.field.value = raw;
    pendingKey.field.dispatchEvent(new Event("input"));
  }
}

/* sink so the plaintext never has to fit in memory twice */
type Sink = {
  type: "picker" | "blob";
  write: (plain: Uint8Array<ArrayBuffer>) => Promise<void>;
  finish: () => Promise<void>;
  abort?: () => Promise<void>;
};

async function makeSink(name: string): Promise<Sink> {
  const picker = (window as unknown as { showSaveFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: name });
      const writable = await (handle as unknown as { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable();
      return {
        type: "picker",
        write: async (plain) => { await writable.write(plain); },
        finish: async () => { await writable.close(); },
        abort: async () => { try { await writable.abort(); } catch { /* already closed */ } },
      };
    } catch {
      /* user dismissed the picker → fall through to the blob path */
    }
  }
  const parts: BlobPart[] = [];
  let buffer: Uint8Array<ArrayBuffer>[] = [];
  const spill = (): void => {
    if (buffer.length) {
      parts.push(new Blob(buffer));
      buffer = [];
    }
  };
  let spilled = 0;
  return {
    type: "blob",
    write: async (plain) => {
      buffer.push(plain);
      spilled += plain.length;
      if (spilled > 512 * 1024 * 1024) spill();
    },
    finish: async () => {
      spill();
      downloadBlob(new Blob(parts), name);
    },
  };
}

function reasonText(code: string): string {
  switch (code) {
    case "expired": return "The sender's download window has closed. Ask them to extend it or start a fresh share.";
    case "consumed": return "This transfer reached its download limit and the sender's device closed it.";
    case "sender_closed": return "The sender closed the share (or their tab) before the transfer finished.";
    case "sender_timeout": return "The sender's device stopped responding — it may have gone to sleep or lost its connection.";
    case "sender_offline": return "The sender's device is not reachable right now.";
    case "read_failed": return "The sender couldn't read that part of the file.";
    default: return "The transfer stopped unexpectedly. Ask the sender for a fresh connection code.";
  }
}
