// Renders all ```mermaid blocks from docs/DIAGRAMS.md into PNGs via mermaid.ink (hosted renderer).
// Usage: node scripts/render-diagrams.mjs
import fs from "node:fs";
import path from "node:path";

const mdPath = path.resolve("docs/DIAGRAMS.md");
const outDir = path.resolve("docs/assets");
fs.mkdirSync(outDir, { recursive: true });

const md = fs.readFileSync(mdPath, "utf8");
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(m => m[1].trim());
console.log(`Found ${blocks.length} mermaid blocks`);

const N = ["v5-architecture", "v5-handshake", "v5-send-flow", "v5-receive-flow", "v5-wire-protocol", "v5-container", "v5-lifecycle", "v5-cicd"];

for (let i = 0; i < blocks.length; i++) {
  const name = N[i] || `diagram-${i + 1}`;
  const payload = Buffer.from(JSON.stringify({
    code: blocks[i],
    mermaid: { theme: "default", htmlLabels: true, flowchart: { htmlLabels: true } },
  })).toString("base64url");
  const url = `https://mermaid.ink/img/${payload}?type=png`;
  let buf = null;
  for (let attempt = 1; attempt <= 4 && !buf; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const t = await res.text();
        console.error(`FAILED ${name} (attempt ${attempt}): ${res.status} ${t.slice(0, 200)}`);
        await new Promise(r => setTimeout(r, 2500 * attempt));
        continue;
      }
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      console.error(`retry ${name} (attempt ${attempt}): ${e.cause?.code || e.message}`);
      await new Promise(r => setTimeout(r, 2500 * attempt));
    }
  }
  if (!buf) continue;
  const out = path.join(outDir, `${name}.png`);
  fs.writeFileSync(out, buf);
  console.log(`OK ${name} -> ${out} (${buf.length} bytes)`);
}
