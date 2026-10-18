/* Small DOM + formatting helpers with accessibility baked in (WCAG AA / aria-live). */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  // attrs values may also be event handlers (onclick, oninput, …) or raw props
  attrs: Record<string, string | number | boolean | undefined | null | ((...a: unknown[]) => unknown)> | null,
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k === "text") node.textContent = String(v);
      else if (k in node) (node as unknown as Record<string, unknown>)[k] = v;
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids) node.append(kid);
  return node;
}

export const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

export const fmtDurationLeft = (expiresAt: number, now = Date.now()): string => {
  const ms = Math.max(0, expiresAt - now);
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h === 0 && m === 0) return "less than a minute";
  if (h === 0) return `${m} min`;
  return `${h} h ${m.toString().padStart(2, "0")} min`;
};

export function announce(text: string, assertive = false): void {
  const live = document.getElementById(
    assertive ? "aria-assertive" : "aria-polite",
  );
  if (live) live.textContent = "";
  requestAnimationFrame(() => {
    if (live) live.textContent = text;
  });
}

export type ToastKind = "ok" | "err" | "info";

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Transient visual confirmation. Screen readers get `announce` separately, so call both. */
export function toast(text: string, kind: ToastKind = "info"): void {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = text;
  node.className = `toast ${kind}`;
  node.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, kind === "err" ? 6000 : 3200);
}

/** Say it and show it — the usual case for anything the user must notice. */
export function note(text: string, kind: ToastKind = "info"): void {
  announce(text, kind === "err");
  toast(text, kind);
}

export const fmtSpeed = (bytesPerSecond: number): string =>
  bytesPerSecond <= 0 ? "—" : `${fmtBytes(bytesPerSecond)}/s`;

/** "about 2 min left" — only when we can say something honest. */
export const fmtEta = (secondsRemaining: number): string => {
  if (!isFinite(secondsRemaining) || secondsRemaining <= 0) return "";
  if (secondsRemaining < 1) return "almost done";
  if (secondsRemaining < 60) return `${Math.ceil(secondsRemaining)} s left`;
  const m = Math.floor(secondsRemaining / 60);
  const s = Math.round(secondsRemaining % 60);
  return `${m} min ${s.toString().padStart(2, "0")} s left`;
};

export const downloadBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

