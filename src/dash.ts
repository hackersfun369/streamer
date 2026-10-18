/* StreamDrop v5 — My transfers.
 *
 * There is no server list, so the list is this device's vault — which is exactly right now that
 * this device is also the source of the bytes. Every state here is local and honest: a share is
 * "serving now" only while this tab is actually serving it, and "active" only until the window
 * you promised runs out. Delete/Stop forgets the record and closes every connection; there is no
 * remote copy to delete, because the file never left this device.
 */
import { stopShare, servingCodeFp, extendShare } from "./send";
import { deleteVaultRow, qrEncode, loadVault, saveVaultRow, type VaultRow } from "./vault";
import { qrCard } from "./qr";
import { announce, el, fmtBytes, fmtDurationLeft } from "./ui";

type LocalState = "serving" | "active" | "expired";

export function initDash(root: HTMLElement = document.getElementById("screen-dash") as HTMLElement): void {
  root.textContent = "";

  const head = el("div", { class: "card" },
    el("h2", { text: "My transfers" }),
    el("p", { class: "hint", text: "This list lives in this browser, because this device is what serves the file. Keys stay here too — a transfer made on another device can be reopened with its backup file on the Send screen." }),
  );
  const refreshBtn = el("button", { class: "btn small", type: "button", text: "Refresh" });
  refreshBtn.addEventListener("click", () => refresh());
  head.append(refreshBtn);
  const list = el("div", { id: "dash-list" });
  root.append(head, list);

  refresh();

  function refresh(): void {
    list.textContent = "";
    const rows = loadVault();
    if (rows.length === 0) {
      list.append(el("p", { class: "hint", text: "Nothing here yet — start a share and it will be listed on this device." }));
      return;
    }
    const now = Date.now();
    const serving = servingCodeFp();
    const table = el("table", { class: "transfers" });
    table.append(el("thead", null,
      el("tr", null,
        el("th", { text: "ID" }),
        el("th", { text: "File" }),
        el("th", { text: "Status" }),
        el("th", { text: "Window" }),
        el("th", { text: "Actions" }),
      ),
    ));
    const tbody = el("tbody", null);

    for (const row of rows) {
      const state: LocalState = serving === row.codeFp ? "serving" : row.expiresAt > now ? "active" : "expired";
      const chip = el("span", { class: "chip", text: state === "serving" ? "serving now" : state });
      chip.className = `chip ${state === "serving" || state === "active" ? "active" : "expired"}`;
      const actions = el("td", null);

      if (state === "serving") {
        const stop = el("button", { class: "btn danger small", type: "button", text: "Stop" });
        stop.addEventListener("click", () => {
          stopShare(row.codeFp);
          announce("Stopped — every connection to that share is closed.");
          refresh();
        });
        actions.append(stop, " ");
      }

      const extend = el("button", { class: "btn small", type: "button", text: "+24 h" });
      extend.addEventListener("click", () => {
        // Purely local: the sender's own device is the authority on the window, so no request
        // has to leave this machine — and if the share is live right now, it follows along.
        const expiresAt = Date.now() + Math.max(0, row.expiresAt - Date.now()) + 24 * 3600_000;
        saveVaultRow({ ...row, expiresAt });
        const live = extendShare(row.codeFp, 24);
        announce(live ? "Extended by 24 hours (live share updated too)." : "Extended by 24 hours on this device.");
        refresh();
      });
      actions.append(extend);

      const qr = el("button", { class: "btn small", type: "button", text: "Key QR" });
      qr.addEventListener("click", () => void showQr(row));
      actions.append(" ", qr);

      const del = el("button", { class: "btn danger small", type: "button", text: state === "serving" ? "Stop & forget" : "Forget" });
      del.addEventListener("click", () => {
        if (!stopShare(row.codeFp)) {
          /* not being served from this tab */
        }
        deleteVaultRow(row.codeFp);
        announce("Removed from this device. There is no remote copy to delete — the file never left this device.", true);
        refresh();
      });
      actions.append(" ", del);

      tbody.append(el("tr", null,
        el("td", null, el("span", { class: "mono", text: row.shareId })),
        el("td", null,
          el("div", { text: row.name ?? "(unknown file)" }),
          el("div", { class: "hint", text: row.size != null ? fmtBytes(row.size) : "" }),
        ),
        el("td", null, chip),
        el("td", { text: row.expiresAt > now ? fmtDurationLeft(row.expiresAt, now) : "closed" }),
        actions,
      ));
    }

    table.append(tbody);
    list.append(table);
    list.append(el("p", { class: "hint", text: "A share exists only while the sender's device serves it. Stopping closes every connection at once, and deleting the record here removes your copy of the key." }));
  }

  async function showQr(v: VaultRow): Promise<void> {
    const modal = el("div", { class: "card", role: "dialog", "aria-label": `Key QR for ${v.shareId}` });
    const payload = v.halfA && v.halfB
      ? qrEncode({ kind: "split", shareId: v.shareId, halfAHex: v.halfA, halfBHex: v.halfB })
      : qrEncode({ kind: "plain", shareId: v.shareId, keyHex: v.tkHex });
    try {
      modal.append(
        el("h2", { text: `Transfer Key — ${v.shareId}` }),
        el("p", { class: "hint", text: "This is the secret half. Send it over a different channel than the connection code." }),
        await qrCard(payload, `streamdrop-${v.shareId}-key.png`, `Transfer key QR for ${v.shareId}`, 280),
        el("button", { class: "btn small", type: "button", text: "Close", onclick: () => modal.remove() }),
      );
    } catch {
      modal.append(
        el("h2", { text: `Transfer Key — ${v.shareId}` }),
        el("p", { class: "hint mono", text: v.tkHex }),
        el("button", { class: "btn small", type: "button", text: "Close", onclick: () => modal.remove() }),
      );
    }
    document.body.append(modal);
    modal.scrollIntoView({ block: "nearest" });
  }
}
