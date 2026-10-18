/* StreamDrop — Transfers.
 *
 * There is no server list, so this list is what this browser remembers: one row per transfer
 * started here. Every status is local and honest — a share is "serving now" only while this tab
 * is actually serving it, and the window you promised is a promise, not a remote setting.
 *
 * The key is kept here so you can show it again later (or restore it from a backup file); deleting
 * a row forgets the key on this device. The file itself never moved.
 */
import { stopShare, servingCodeFp, extendShare } from "./send";
import { deleteVaultRow, loadVault, renderRecoveryCard, type VaultRow } from "./vault";
import { qrEncode } from "./crypto";
import { qrDataUrl } from "./qr";
import { announce, el, fmtBytes, fmtDurationLeft, note, toast } from "./ui";

export function initDash(root: HTMLElement = document.getElementById("screen-dash") as HTMLElement): void {
  root.textContent = "";
  root.append(hero(), list());

  const restore = el("details", { class: "advanced" },
    el("summary", { text: "Restore a key from a backup file" }),
    el("div", { class: "body recovery-slot" }),
  );
  renderRecoveryCard(restore.querySelector(".body") as HTMLElement);
  root.append(restore);

  function list(): HTMLElement {
    const wrap = el("div", {});
    const rows = loadVault();
    const serving = servingCodeFp();
    if (!rows.length) {
      wrap.append(el("div", { class: "card" },
        el("div", { class: "empty" },
          el("span", { class: "ico", text: "🗂️" }),
          el("h2", { text: "Nothing here yet" }),
          el("p", { class: "hint", text: "Start a transfer on the Send tab and it will appear here, with its key kept on this device." }),
        ),
      ));
      return wrap;
    }
    for (const row of rows) wrap.append(rowCard(row, serving));
    return wrap;
  }

  function rowCard(row: VaultRow, serving: string | null): HTMLElement {
    const now = Date.now();
    const isServing = serving === row.codeFp;
    const open = row.expiresAt > now;
    const pill = isServing
      ? el("span", { class: "pill ok" }, el("span", { class: "pulse" }), el("span", { text: "Serving now" }))
      : open
        ? el("span", { class: "pill warn", text: "Not being served" })
        : el("span", { class: "pill", text: row.expiresAt ? "Window closed" : "Saved key" });

    const actions = el("div", { class: "t-actions" });
    const keyBtn = el("button", { class: "btn small", type: "button", text: "Show key" });
    keyBtn.addEventListener("click", () => showKey(row));
    actions.append(keyBtn);

    const stop = el("button", { class: "btn danger small", type: "button", text: "Stop sharing" });
    stop.addEventListener("click", () => {
      stopShare(row.codeFp);
      note("Stopped — every connection is closed.", "ok");
      initDash(root);
    });
    const extend = el("button", { class: "btn small", type: "button", text: "+24 hours" });
    extend.addEventListener("click", () => {
      const next = extendShare(row.codeFp, 24);
      if (next === null) {
        note("This tab is not serving that transfer right now.", "err");
        return;
      }
      note(`Open until ${new Date(next).toLocaleString()}.`, "ok");
      initDash(root);
    });
    if (isServing) actions.append(extend, stop);

    const forget = el("button", { class: "btn ghost small", type: "button", text: "Forget" });
    forget.addEventListener("click", () => {
      deleteVaultRow(row.codeFp);
      toast("Forgotten on this device", "ok");
      initDash(root);
    });
    actions.append(forget);

    const when = isServing
      ? `open for ${fmtDurationLeft(row.expiresAt)}`
      : open
        ? "Nothing is being served from this tab right now — start the file again on Send to share it."
        : row.expiresAt
          ? `Window closed ${new Date(row.expiresAt).toLocaleString()} — the key is still kept here.`
          : "Key kept on this device.";

    return el("div", { class: "t-item", style: "margin-top:10px" },
      el("div", { class: "t-top" },
        el("span", { class: "t-name", text: row.name ?? "Untitled transfer" }),
        pill,
      ),
      el("div", { class: "t-top" },
        el("span", { class: "t-id", text: row.shareId }),
        el("span", {
          class: "hint tiny",
          text: [
            row.size !== undefined ? fmtBytes(row.size) : null,
            row.maxDownloads !== null && row.maxDownloads !== undefined
              ? `${row.maxDownloads} download${row.maxDownloads === 1 ? "" : "s"}`
              : "unlimited downloads",
          ].filter(Boolean).join(" · "),
        }),
      ),
      el("p", { class: "hint tiny", text: when }),
      actions,
    );
  }

  function showKey(row: VaultRow): void {
    const ac = new AbortController();
    const backdrop = el("div", {
      class: "modal-backdrop", role: "dialog", "aria-modal": "true",
      "aria-label": `Key for transfer ${row.shareId}`,
    });
    const close = (): void => {
      ac.abort();
      backdrop.remove();
    };
    const qrHolder = el("div", { class: "qr-frame small" });
    const body = el("div", { class: "card" },
      el("div", { class: "spread" },
        el("h2", { text: row.shareId }),
        el("button", { class: "btn ghost small", type: "button", text: "Close" }),
      ),
      el("p", { class: "hint", text: row.halfA && row.halfB
        ? "This transfer uses a split key: both halves are needed, so send them by two different routes."
        : "This is the key that opens the file. Anyone who has it can decrypt a copy of the bytes." }),
      qrHolder,
    );
    (body.querySelector("button") as HTMLElement).addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    }, { signal: ac.signal });

    const payload = row.halfA && row.halfB
      ? qrEncode({ kind: "split", shareId: row.shareId, halfAHex: row.halfA, halfBHex: row.halfB })
      : qrEncode({ kind: "plain", shareId: row.shareId, keyHex: row.tkHex });

    if (row.halfA && row.halfB) {
      body.append(keyBlock("Half A", row.halfA), keyBlock("Half B", row.halfB));
    } else {
      body.append(keyBlock("Transfer Key", row.tkHex));
    }

    void qrDataUrl(payload, 420, "M").then((src) => {
      qrHolder.append(el("div", { class: "qr-tile" }, el("img", { src, alt: `Key for transfer ${row.shareId}` })));
    }).catch(() => {
      qrHolder.append(el("p", { class: "hint tiny", text: "QR rendering unavailable — use the text above." }));
    });

    backdrop.append(body);
    document.body.append(backdrop);
    announce(`Key for transfer ${row.shareId} shown.`);
  }

  function keyBlock(title: string, value: string): HTMLElement {
    const field = el("textarea", { class: "code-box mono", rows: "2", readOnly: true, spellcheck: "false", "aria-label": title });
    field.value = value;
    const copy = el("button", { class: "btn small", type: "button", text: `Copy ${title}` });
    copy.addEventListener("click", () => void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        toast(`${title} copied`, "ok");
      } catch {
        note("Copying failed — select the text and copy it manually.", "err");
      }
    })());
    return el("div", { class: "stack", style: "margin-top:10px" },
      el("span", { class: "hint tiny", text: title }),
      field,
      copy,
    );
  }
}

function hero(): HTMLElement {
  return el("div", { class: "hero" },
    el("h1", null, "Your transfers. ", el("span", { class: "accent", text: "On this device only." })),
    el("p", { text: "Every transfer started in this browser, with the key kept here so you can hand it out again." }),
  );
}
