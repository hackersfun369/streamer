import "./styles.css";
import { initSend } from "./send";
import { initReceive } from "./receive";
import { initDash } from "./dash";

type Screen = "send" | "receive" | "dash";

const screens: Record<Screen, () => void> = {
  send: initSend,
  receive: initReceive,
  dash: initDash,
};

function currentScreen(): Screen {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("receive") || h.startsWith("c=") || h === "c") return "receive";
  if (h.startsWith("dash")) return "dash";
  if (h.startsWith("send")) return "send";
  return "send";
}

function show(screen: Screen): void {
  const ids: Record<Screen, string> = { send: "screen-send", receive: "screen-receive", dash: "screen-dash" };
  const tabs: Record<Screen, string> = { send: "tab-send", receive: "tab-receive", dash: "tab-dash" };
  for (const key of Object.keys(ids) as Screen[]) {
    const node = document.getElementById(ids[key]);
    const tab = document.getElementById(tabs[key]);
    const on = key === screen;
    if (node) node.hidden = !on;
    if (tab) tab.setAttribute("aria-selected", String(on));
  }
  screens[screen]();
  document.getElementById("screen")?.focus({ preventScroll: true });
}

/** Deep link: #/receive?c=<connection code>[&k=<key>|&k1=&k2=]. The key is a convenience extra. */
function normaliseDeepLink(): boolean {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return false;
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
  const params = new URLSearchParams(query);
  const code = params.get("c");
  if (!code) return false;
  const next = new URLSearchParams();
  next.set("c", code);
  for (const name of ["k", "k1", "k2"]) {
    const value = params.get(name);
    if (value) next.set(name, value);
  }
  history.replaceState(null, "", `${location.pathname}${location.search}#/receive?${next.toString()}`);
  return true;
}

/* No sign-in, no server, no runtime configuration: there is nothing to boot beyond the first screen. */
show(normaliseDeepLink() ? "receive" : currentScreen());

window.addEventListener("hashchange", () => {
  const h = location.hash;
  if (h.startsWith("#/receive") || h.startsWith("#c=")) show("receive");
  else show(currentScreen());
});
