/* Keeps the mobile shell self-contained (CI and local): the web app is bundled into the APK, so
 * there is no deployment URL and nothing to point at. Anything left over from an older setup is
 * stripped, because a stale server.url would send the app looking for a host that no longer exists.
 *
 * Paths come from this file's own location, so the script behaves the same from any directory. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = path.join(repoRoot, "mobile/capacitor.config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

let changed = false;
if (cfg.server?.url) {
  delete cfg.server.url;
  changed = true;
}
cfg.server = { androidScheme: "https", ...(cfg.server ?? {}) };
delete cfg.server.cleartext;
if (cfg.webDir !== "../dist") {
  cfg.webDir = "../dist";
  changed = true;
}

fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
console.log(changed
  ? "Capacitor config normalised — the APK bundles the web app (no server URL)."
  : "Capacitor config is already self-contained — the APK bundles the web app.");
