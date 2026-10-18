/* Adds the permissions the APK genuinely needs after `cap add android` has generated the project.
 * CAMERA is for scanning QR codes (the connection code and the transfer key both arrive as QRs);
 * gallery import goes through the system photo picker, which needs nothing extra.
 *
 * The manifest path comes from this file's own location, so the script works whether it is run
 * from the repository root or from mobile/. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "mobile/android/app/src/main/AndroidManifest.xml");
if (!fs.existsSync(manifestPath)) {
  console.log(`AndroidManifest.xml not found at ${manifestPath} — run \`npx cap add android\` first. Skipping.`);
  process.exit(0);
}

let xml = fs.readFileSync(manifestPath, "utf8");
const wanted = [
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
];

let added = 0;
for (const line of wanted) {
  const marker = line.match(/android:name="([^"]+)"/)?.[1];
  if (marker && xml.includes(marker)) continue;
  xml = xml.replace(/(<manifest[^>]*>\s*\n)/, `$1    ${line}\n`);
  added++;
}

if (added > 0) {
  fs.writeFileSync(manifestPath, xml);
  console.log(`Added ${added} manifest entr${added === 1 ? "y" : "ies"} (camera access for QR scanning).`);
} else {
  console.log("Manifest already has camera access.");
}
