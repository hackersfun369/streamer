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

