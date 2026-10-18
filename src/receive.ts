/* StreamDrop — Receive.
 *
 * Three things can arrive, and only the first one needs a human decision:
 *   1. a connection code  — scanned, pasted, or imported from a screenshot
 *   2. the reply code     — shown once, sent back to the sender
 *   3. the file itself    — decrypted block by block, straight from the sender's device
 *
 * When the code carries the key (the default), the key arrives with it and nobody types anything.
 * When the sender chose to keep the key separate, this screen asks for it and says why.
 */
import {
  normalizeCode, receiverKeySet, unsealHeader, decryptChunk, hkdfCodeFp,
  plainChunkLen, blockLenFor, fromHex, unb64, qrParse,
  type Manifest,
} from "./crypto";
import { ReceiverAgent, type BlockChannel, type HelloFrame } from "./protocol";
import { acceptInvite } from "./rtc";
import { announce, el, fmtBytes, fmtEta, fmtSpeed, note, toast, downloadBlob } from "./ui";
import { cameraAvailable, importQrImage, qrDataUrl, scanQrCamera } from "./qr";

const looksLikeCode = (text: string): boolean => /^SDC[01]\./.test(text.trim());

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
    /** Key material that arrived inside the connection code, if the sender opted in. */
    keyFromCode: null as Uint8Array<ArrayBuffer> | [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>] | null,
    started: false,
  };

  let rootEl = root;

  /* ── phase A: get the code ── */
  const codeField = el("textarea", {
    class: "code-box mono", rows: "3", spellcheck: "false",
    placeholder: "Paste the code here", "aria-label": "Connection code from the sender",
  });
  const video = el("video", { hidden: true, playsinline: true, "aria-label": "Camera preview" });
  const scanBtn = el("button", { class: "btn primary block big", type: "button", text: "Scan the code" });
  const importBtn = el("button", { class: "btn ghost", type: "button", text: "Choose a screenshot" });
  const codeStatus = el("p", { class: "hint" });
  const hasCamera = cameraAvailable();
  if (!hasCamera) scanBtn.hidden = true;

  const picker = el("div", { class: "card" },
    el("div", { class: "step-head active" },
      el("span", { class: "step-num", text: "1" }),
      el("div", { class: "step-text" },
        el("h3", { text: "Get the code from the sender" }),
        el("p", { class: "hint", text: "Point your camera at their screen. Or paste the code, or pick a screenshot of it." }),
      ),
    ),
    scanBtn,
    el("div", { class: "field", style: "margin-top:14px" },
      el("label", { for: "recv-code", text: "Or paste the code" }),
      codeField,
    ),
    el("div", { class: "row", style: "margin-top:12px" }, importBtn),
    video,
    codeStatus,
  );

  const work = el("div", {});
  rootEl.append(hero(), picker, work);

  scanBtn.addEventListener("click", () => void (async () => {
    try {
      const raw = await scanQrCamera(video);
      if (raw) await useCode(raw);
    } catch {
      note("Camera unavailable — paste the code or pick a screenshot instead.", "err");
    }
  })());

  importBtn.addEventListener("click", () => void (async () => {
    try {
      const raw = await importQrImage();
      if (raw) {
        codeField.value = raw;
        await useCode(raw);
      }
    } catch (e) {
      note(e instanceof Error ? e.message : "Couldn't read that image.", "err");
    }
  })());

  codeField.addEventListener("input", () => {
    const value = codeField.value.trim();
    if (looksLikeCode(value)) void useCode(value);
  });

  /* deep link: #/receive?c=<code>[&k=|&k1=&k2=] — the key params are a legacy convenience */
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const deepCode = q.get("c");
  const deepKey = q.get("k") ?? (q.get("k1") && q.get("k2") ? `SD|2|0|${q.get("k1")}|${q.get("k2")}` : null);
  if (deepCode) {
    codeField.value = deepCode;
    void useCode(deepCode, deepKey);
  }

  async function useCode(raw: string, legacyKey?: string | null): Promise<void> {
    const text = (raw ?? "").trim().replace(/\s+/g, "");
    if (!text) {
      note("Paste the code from the sender first.", "err");
      codeField.focus();
      return;
    }
    if (state.started) return;
    state.started = true;
    codeStatus.textContent = "Reading the code…";
    try {
      const peer = await acceptInvite(text);
      // The ID travels inside the code: check it against its fingerprint before trusting it.
      if ((await hkdfCodeFp(peer.meta.shareId)) !== peer.meta.codeFp) {
        throw new Error("That connection code is damaged — ask the sender for a fresh one.");
      }
      state.shareId = peer.meta.shareId;
      state.codeFp = peer.meta.codeFp;
      state.expiresAt = peer.meta.expiresAt;

      // The key, when the sender put it in the code. This is what removes every typing step.
      if (legacyKey) state.keyFromCode = keyFromLegacy(legacyKey);
      else if (peer.meta.ka && peer.meta.kb) state.keyFromCode = [fromHex(peer.meta.ka), fromHex(peer.meta.kb)];
      else if (peer.meta.k) state.keyFromCode = fromHex(peer.meta.k);

      picker.hidden = true;
      const steps = el("div", { class: "steps" },
        el("div", { class: "seg done" }),
        el("div", { class: "seg active" }),
        el("div", { class: "seg" }),
      );
      const replyStatus = el("p", { class: "hint" });
      const replyQR = el("div", { class: "qr-frame small" });
      const copyReply = el("button", { class: "btn primary", type: "button", text: "Copy reply code" });
      const replyField = el("textarea", { class: "code-box mono", rows: "2", readOnly: true, spellcheck: "false", "aria-label": "Reply code to send back" });
      replyField.value = peer.answer;
      copyReply.addEventListener("click", () => void copy(peer.answer));

      work.textContent = "";
      work.append(el("div", { class: "card" },
        steps,
        el("div", { class: "step-head active" },
          el("span", { class: "step-num", text: "2" }),
          el("div", { class: "step-text" },
            el("h3", { text: "Answer the sender" }),
            el("p", { class: "hint", text: "Let them scan this reply code — or copy it and send it to them. It is not secret; it only helps the two devices find each other." }),
          ),
        ),
        peer.meta.publicLabel ? el("p", null, el("em", { text: `${peer.meta.publicLabel}` })) : el("span", {}),
        replyQR,
        el("div", { class: "row", style: "margin-top:12px" }, copyReply),
        el("details", { class: "advanced", style: "margin-top:12px" },
          el("summary", { text: "Show the reply as text" }),
          el("div", { class: "body" }, replyField),
        ),
        el("div", { class: "status-line" }, el("span", { class: "pill live" }, el("span", { class: "pulse" }), el("span", { text: "Waiting for the sender" }))),
        replyStatus,
      ));

      void qrDataUrl(peer.answer, 480, "M").then((src) => {
        replyQR.append(el("div", { class: "qr-tile" }, el("img", { src, alt: `Reply code for transfer ${state.shareId}` })));
      }).catch(() => {
        replyStatus.textContent = "QR rendering unavailable — use the text below.";
      });

      // A direct connection can genuinely fail (some mobile and corporate networks refuse it), so
      // say so in plain words rather than leaving the receiver watching a spinner.
      peer.pc.addEventListener("connectionstatechange", () => {
        if (peer.pc.connectionState !== "failed") return;
        const msg = "Couldn't reach the sender's device directly — some networks block this. Ask them for a fresh code, or try another network.";
        replyStatus.textContent = msg;
        note(msg, "err");
      });
      void peer.channel.then((channel) => onConnected(channel));
    } catch (e) {
      state.started = false;
      const msg = e instanceof Error ? e.message : "Couldn't use that connection code.";
      codeStatus.textContent = msg;
      note(msg, "err");
    }
  }

  function onConnected(channel: BlockChannel): void {
    if (state.agent) return;
    const agent = new ReceiverAgent(channel);
    state.agent = agent;
    agent.onFatal((code) => {
      const msg = reasonText(code);
      work.append(el("p", { class: "hint bad-text", role: "alert", text: msg }));
      note(msg, "err");
    });
    agent.onHello((hello) => void onHello(hello));
    agent.begin();
  }

  /* ── phase C: connected — save the file ── */
  async function onHello(hello: HelloFrame): Promise<void> {
    state.hello = hello;
    state.headerBytes = unb64(hello.sealedManifest);

    if (state.keyFromCode) {
      try {
        await unlock(state.keyFromCode);
        return; // straight to the save card
      } catch (e) {
        const msg = e instanceof Error ? e.message : "The key in that code didn't open the file.";
        work.append(el("p", { class: "hint bad-text", role: "alert", text: msg }));
        note(msg, "err");
      }
    }
    renderKeyCard(hello);
  }

  function renderKeyCard(hello: HelloFrame): void {
    const keyField = el("textarea", { class: "code-box mono", rows: "2", spellcheck: "false", placeholder: "Paste the Transfer Key", "aria-label": "Transfer key" });
    const halfA = el("input", { class: "code-box mono", type: "text", spellcheck: "false", placeholder: "Half A", hidden: true, "aria-label": "Half A" });
    const halfB = el("input", { class: "code-box mono", type: "text", spellcheck: "false", placeholder: "Half B", hidden: true, "aria-label": "Half B" });
    const keyVideo = el("video", { hidden: true, playsinline: true, "aria-label": "Camera preview" });
    const unlockBtn = el("button", { class: "btn primary block big", type: "button", text: "Unlock the file" });
    const keyNote = el("p", { class: "hint" });

    keyField.addEventListener("input", () => {
      const parsed = qrParse(keyField.value);
      if (!parsed) return;
      if (parsed.kind === "plain" || parsed.kind === "direct") keyField.value = parsed.keyHex;
      if (parsed.kind === "split" || parsed.kind === "directSplit") {
        halfA.hidden = false;
        halfB.hidden = false;
        halfA.value = parsed.halfAHex;
        halfB.value = parsed.halfBHex;
        keyField.value = "";
      }
      note("Key recognised — press Unlock.", "ok");
    });

    const keyScan = el("button", { class: "btn ghost small", type: "button", text: "Scan key QR", disabled: !cameraAvailable() });
    keyScan.addEventListener("click", () => void (async () => {
      try {
        const raw = await scanQrCamera(keyVideo);
        if (raw) {
          keyField.value = raw;
          keyField.dispatchEvent(new Event("input"));
        }
      } catch {
        note("Camera unavailable — paste the key instead.", "err");
      }
    })());
    const keyImport = el("button", { class: "btn ghost small", type: "button", text: "Import key image" });
    keyImport.addEventListener("click", () => void (async () => {
      try {
        const raw = await importQrImage();
        if (raw) {
          keyField.value = raw;
          keyField.dispatchEvent(new Event("input"));
        }
      } catch (e) {
        note(e instanceof Error ? e.message : "Couldn't read that image.", "err");
      }
    })());

    unlockBtn.addEventListener("click", () => void (async () => {
      try {
        if (!halfA.hidden) {
          const a = /^[0-9a-fA-F]{64}$/.test(halfA.value.trim()) ? fromHex(halfA.value.trim()) : null;
          const b = /^[0-9a-fA-F]{64}$/.test(halfB.value.trim()) ? fromHex(halfB.value.trim()) : null;
          if (!a || !b) throw new Error("Both halves are needed — 64 hex characters each.");
          await unlock([a, b]);
        } else if (/^[0-9a-fA-F]{64}$/.test(keyField.value.trim())) {
          await unlock(fromHex(keyField.value.trim()));
        } else {
          throw new Error("Paste the Transfer Key to open the file.");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unlock failed";
        keyNote.textContent = msg;
        note(msg, "err");
      }
    })());

    work.append(el("div", { class: "card" },
      el("div", { class: "steps" },
        el("div", { class: "seg done" }),
        el("div", { class: "seg done" }),
        el("div", { class: "seg active" }),
      ),
      el("div", { class: "step-head active" },
        el("span", { class: "step-num", text: "3" }),
        el("div", { class: "step-text" },
          el("h3", { text: "The sender kept the key separate" }),
          el("p", { class: "hint", text: `${hello.publicLabel ? `“${hello.publicLabel}” · ` : ""}They will send you the Transfer Key another way — a message, a call, or in person. It is what actually opens the file (${fmtBytes(hello.sizePlain)}).` }),
        ),
      ),
      el("div", { class: "field" }, el("label", { for: "recv-key", text: "Transfer Key" }), keyField),
      el("div", { class: "row", style: "margin-top:10px" }, halfA, halfB),
      el("div", { class: "row", style: "margin-top:12px" }, unlockBtn, keyScan, keyImport),
      keyVideo, keyNote,
    ));
  }

  async function unlock(key: Uint8Array<ArrayBuffer> | [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>]): Promise<void> {
    if (!state.headerBytes) throw new Error("No transfer metadata yet — reconnect with a fresh code.");
    const norm = normalizeCode(state.shareId);
    if (!norm) throw new Error("The connection code carried an invalid ID.");
    const keySet = await receiverKeySet(norm, key);
    const manifest = await unsealHeader(state.headerBytes, { manifestKey: keySet.manifestKey, signPub: keySet.signPub });
    if (manifest.receiverAuth !== keySet.receiverAuth) throw new Error("This key doesn't open that transfer.");
    state.keySet = keySet;
    state.manifest = manifest;
    renderSaveCard(manifest);
  }

  /* ── phase D: save it ── */
  function renderSaveCard(manifest: Manifest): void {
    const saveBtn = el("button", { class: "btn primary block big", type: "button", text: `Save ${fmtBytes(manifest.size)}` });
    const progressBox = el("div", { hidden: true },
      el("div", { class: "progress" }, el("div", { class: "bar" })),
      el("div", { class: "progress-meta" }, el("span", { text: "Starting…" }), el("span", { text: "" })),
    );
    const saveNote = el("p", { class: "hint" });

    saveBtn.addEventListener("click", () => void doDownload(saveBtn, progressBox, saveNote));

    work.textContent = "";
    work.append(el("div", { class: "card" },
      el("div", { class: "steps" },
        el("div", { class: "seg done" }),
        el("div", { class: "seg done" }),
        el("div", { class: "seg done" }),
      ),
      el("div", { class: "step-head done" },
        el("span", { class: "step-num", text: "✓" }),
        el("div", { class: "step-text" },
          el("h3", { text: "Connected and verified" }),
          el("p", { class: "hint", text: "The sender's signature checks out, so this really is their file." }),
        ),
      ),
      el("div", { class: "file-row" },
        el("span", { class: "ico", text: "📄" }),
        el("div", { class: "grow" },
          el("div", { class: "name", text: manifest.name }),
          el("div", { class: "meta", text: `${fmtBytes(manifest.size)} · ${manifest.mime}` }),
        ),
      ),
      el("p", { class: "hint tiny", style: "margin-top:10px", text: state.expiresAt ? `The sender promised this until ${new Date(state.expiresAt).toLocaleString()}, but the bytes come live from their device — so they need to keep it open until you finish.` : "" }),
      saveBtn,
      progressBox,
      saveNote,
    ));
  }

  async function doDownload(btn: HTMLButtonElement, progressBox: HTMLElement, saveNote: HTMLElement): Promise<void> {
    const agent = state.agent;
    const keySet = state.keySet;
    const manifest = state.manifest;
    if (!agent || !keySet || !manifest) return;

    const bar = progressBox.querySelector(".bar") as HTMLElement;
    const left = progressBox.querySelector(".progress-meta span") as HTMLElement;
    const right = progressBox.querySelectorAll(".progress-meta span")[1] as HTMLElement;

    btn.disabled = true;
    progressBox.hidden = false;
    left.textContent = "Asking the sender's device for the first block…";

    let sink: Sink | null = null;
    const meter = new Rate();
    try {
      sink = await makeSink(manifest.name);
      let offset = state.hello!.headerLen;
      let written = 0;
      for (let i = 0; i < manifest.chunkCount; i++) {
        const len = blockLenFor(i, manifest.size);
        const bytes = await pullBlock(agent, offset, len, left);
        offset += len;
        const plain = await decryptChunk(keySet.fek, bytes, keySet.codeFp, i);
        const want = plainChunkLen(i, manifest.size);
        await sink.write(plain.slice(0, want));
        written += want;
        const pct = (written / manifest.size) * 100;
        bar.style.width = `${pct.toFixed(1)}%`;
        const speed = meter.push(written);
        left.textContent = `${pct.toFixed(0)} %`;
        right.textContent = speed === null ? fmtBytes(written) : `${fmtSpeed(speed)} · ${fmtEta(speed > 0 ? (manifest.size - written) / speed : NaN)}`.trim();
      }
      if (sink.type === "picker") await sink.finish();
      agent.end();
      progressBox.hidden = true;
      work.textContent = "";
      work.append(el("div", { class: "card center" },
        el("div", { class: "empty" },
          el("span", { class: "ico", text: "✅" }),
          el("h2", { text: "Saved" }),
          el("p", { class: "hint", text: manifest.name }),
        ),
        el("button", { class: "btn", type: "button", text: "Receive another file", onclick: () => { location.hash = "#/receive"; location.reload(); } }),
      ));
      toast("Saved and verified", "ok");
      announce(`Saved ${manifest.name}`);
    } catch (e) {
      await sink?.abort?.();
      progressBox.hidden = true;
      const msg = e instanceof Error ? e.message : "Download failed";
      saveNote.textContent = "";
      saveNote.append(el("span", { class: "bad-text", text: msg }));
      note(msg, "err");
      btn.disabled = false;
    }
  }

  /** One block per request. A slow sender gets one retry before we call it a stall. */
  async function pullBlock(agent: ReceiverAgent, offset: number, len: number, statusLine: HTMLElement): Promise<Uint8Array<ArrayBuffer>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await agent.read(offset, len);
      } catch (e) {
        const code = e instanceof Error ? e.message : "";
        if (code !== "sender_timeout" || attempt === 1) throw new Error(reasonText(code));
        statusLine.textContent = "The sender is slow — retrying that block…";
        continue;
      }
      if (bytes.length !== len) {
        throw new Error("The sender sent a short block — they may have gone offline mid-transfer.");
      }
      return bytes;
    }
    throw new Error(reasonText("sender_timeout"));
  }

  function keyFromLegacy(text: string): Uint8Array<ArrayBuffer> | [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>] {
    const parsed = qrParse(text);
    if (parsed) {
      if (parsed.kind === "plain" || parsed.kind === "direct") return fromHex(parsed.keyHex);
      if (parsed.kind === "split" || parsed.kind === "directSplit") return [fromHex(parsed.halfAHex), fromHex(parsed.halfBHex)];
    }
    return fromHex(text.trim());
  }
}

/* The fingerprint check the receiver always performs on the ID it was handed. */
function hero(): HTMLElement {
  return el("div", { class: "hero" },
    el("h1", null, "Receive a file. ", el("span", { class: "accent", text: "Nothing to install." })),
    el("p", { text: "Scan the sender's code and the file comes straight from their device to this one." }),
  );
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Reply copied — send it back to the sender", "ok");
  } catch {
    note("Copying failed — select the text and copy it manually.", "err");
  }
}

/** Smoothed bytes-per-second, blank until there is something honest to say. */
class Rate {
  private at = 0;
  private bytes = 0;
  private rate = 0;

  push(total: number): number | null {
    const now = Date.now();
    if (this.at === 0) {
      this.at = now;
      this.bytes = total;
      return null;
    }
    const dt = now - this.at;
    if (dt < 500) return this.rate > 0 ? this.rate : null;
    const rate = ((total - this.bytes) / dt) * 1000;
    this.rate = this.rate === 0 ? rate : this.rate * 0.6 + rate * 0.4;
    this.at = now;
    this.bytes = total;
    return this.rate > 0 ? this.rate : null;
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
    case "expired": return "The sender's window has closed. Ask them to extend it or start a fresh transfer.";
    case "consumed": return "This transfer reached its download limit, and the sender's device closed it.";
    case "sender_closed": return "The sender closed the transfer (or their tab) before it finished.";
    case "sender_timeout": return "The sender's device stopped responding — it may be asleep or offline.";
    case "sender_offline": return "The sender's device is not reachable right now.";
    case "read_failed": return "The sender couldn't read that part of the file.";
    default: return "The transfer stopped unexpectedly. Ask the sender for a fresh code.";
  }
}
