/* StreamDrop v5 — the sender's key vault, and key backups that the sender keeps themselves.
 *
 * There is no server to ask, so "recovery" is a file: the passphrase seals your key into a small
 * backup you store wherever you like (USB stick, password manager, your own drive). Only the
 * passphrase unwraps it, and nothing about it is stored anywhere else.
 */
import { qrEncode, unwrapTransferKey, toHex, hkdfCodeFp, normalizeCode, b64, unb64 } from "./crypto";
import { announce, el, downloadBlob } from "./ui";

export { qrEncode };

export interface VaultRow {
  shareId: string;
  codeFp: string;
  tkHex: string;
  halfA?: string;
  halfB?: string;
  name?: string;
  mime?: string;
  size?: number;
  mode?: string;
  createdAt: number;
  expiresAt: number;
  maxDownloads: number | null;
  hasRecovery?: boolean;
}

const VAULT_KEY = "sd.vault.v1";

export function loadVault(): VaultRow[] {
  try {
    return JSON.parse(localStorage.getItem(VAULT_KEY) ?? "[]") as VaultRow[];
  } catch {
    return [];
  }
}

export function saveVaultRow(row: VaultRow): void {
  const list = loadVault().filter((r) => r.codeFp !== row.codeFp);
  list.unshift(row);
  localStorage.setItem(VAULT_KEY, JSON.stringify(list.slice(0, 100)));
}

/** Kill/Delete removes the record from this device too — the vault is the sender's own data. */
export function deleteVaultRow(codeFp: string): void {
  localStorage.setItem(VAULT_KEY, JSON.stringify(loadVault().filter((r) => r.codeFp !== codeFp)));
}

/* ── passphrase-sealed key backups (PBKDF2 ×250k + AES-GCM) ────────── */

interface KeyBackup {
  v: 1;
  app: "streamdrop";
  shareId: string;
  salt: string;
  wrapped: string;
}

/** `wrappedKey` from createSender is salt(16) ‖ iv(12) ‖ ciphertext. */
export function downloadKeyBackup(shareId: string, wrappedKey: Uint8Array<ArrayBuffer>): void {
  const backup: KeyBackup = {
    v: 1,
    app: "streamdrop",
    shareId,
    salt: b64(wrappedKey.slice(0, 16)),
    wrapped: b64(wrappedKey.slice(16)),
  };
  downloadBlob(
    new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }),
    `streamdrop-${shareId}.keybackup.json`,
  );
}

/** Reads a backup file and unwraps it locally. Returns the row to store in this device's vault. */
export async function readKeyBackup(text: string, passphrase: string): Promise<VaultRow> {
  let parsed: Partial<KeyBackup>;
  try {
    parsed = JSON.parse(text) as Partial<KeyBackup>;
  } catch {
    throw new Error("That file isn't a StreamDrop key backup.");
  }
  if (parsed.app !== "streamdrop" || parsed.v !== 1) throw new Error("That file isn't a StreamDrop key backup.");
  if (typeof parsed.shareId !== "string" || typeof parsed.salt !== "string" || typeof parsed.wrapped !== "string") {
    throw new Error("The key backup is incomplete.");
  }
  const norm = normalizeCode(parsed.shareId);
  if (!norm) throw new Error("The key backup carries an invalid Share ID.");
  const tk = await unwrapTransferKey(unb64(parsed.wrapped), passphrase, unb64(parsed.salt));
  return {
    shareId: norm,
    codeFp: await hkdfCodeFp(norm),
    tkHex: toHex(tk),
    createdAt: Date.now(),
    expiresAt: 0,
    maxDownloads: null,
    hasRecovery: true,
  };
}

/** Restore card: pick a backup file + passphrase. No server is involved anywhere. */
export function renderRecoveryCard(container: HTMLElement): void {
  container.textContent = "";
  const fileInput = el("input", { type: "file", accept: ".json,application/json", "aria-label": "Key backup file" });
  const pass = el("input", { type: "password", placeholder: "Backup passphrase", "aria-label": "Backup passphrase" });
  const btn = el("button", { class: "btn", type: "button", text: "Restore key into this device" });
  const out = el("p", { class: "hint", role: "status" });

  btn.addEventListener("click", () => void (async () => {
    try {
      const file = fileInput.files?.[0];
      if (!file) throw new Error("Choose the .keybackup.json file you saved.");
      if (!pass.value) throw new Error("Enter the passphrase you sealed the backup with.");
      const row = await readKeyBackup(await file.text(), pass.value);
      saveVaultRow(row);
      out.textContent = "";
      out.append("Key restored for ", el("span", { class: "mono", text: row.shareId }), " — ", el("span", { class: "mono", text: row.tkHex }));
      announce("Key restored and stored in this device's vault.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Restore failed";
      out.textContent = msg;
      announce(msg, true);
    }
  })());

  container.append(el("div", { class: "card" },
    el("h2", { text: "Restore a key from a backup file" }),
    el("p", { class: "hint", text: "If you set a backup passphrase when you started a share, StreamDrop offered you a small .keybackup.json file. This reads it back on any device — the passphrase never leaves this device and nothing is asked of any server." }),
    el("label", { text: "Backup file" }), fileInput,
    el("label", { text: "Passphrase" }), pass,
    btn, out,
  ));
}
