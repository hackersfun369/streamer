// Rasterises the StreamDrop logo SVGs into the PNG sizes the web app and the
// Android shell (@capacitor/assets) expect.  Run:  node scripts/render-logo.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const ICON = '#0f1022'; // app background, matches capacitor SplashScreen.backgroundColor

/** Re-emit an SVG at an exact pixel size so sharp renders it natively (no upscaling). */
const atSize = (svg, size) =>
  Buffer.from(svg.replace(/width="\d+"\s+height="\d+"/, `width="${size}" height="${size}"`));

const iconSrc = await readFile('public/icon.svg', 'utf8');
const markSrc = await readFile('public/logo-mark.svg', 'utf8');

await mkdir('resources', { recursive: true });

const targets = [
  ['resources/icon.png', iconSrc, 1024], // @capacitor/assets source
  ['public/icon-512.png', iconSrc, 512], // PWA / manifest
  ['public/apple-touch-icon.png', iconSrc, 180], // iOS home screen
];

for (const [out, svg, size] of targets) {
  await sharp(atSize(svg, size)).png().toFile(out);
  console.log('wrote', out, `${size}x${size}`);
}

// Splash: mark centred on the app background colour.
const SPLASH = 2732;
const mark = 640;
const markPng = await sharp(atSize(markSrc, mark)).png().toBuffer();
await sharp({ create: { width: SPLASH, height: SPLASH, channels: 4, background: ICON } })
  .composite([{ input: markPng, gravity: 'center' }])
  .png()
  .toFile('resources/splash.png');
console.log('wrote resources/splash.png', `${SPLASH}x${SPLASH}`);

await writeFile(
  'resources/README.md',
  `# Android / store assets\n\nGenerated from \`public/icon.svg\` and \`public/logo-mark.svg\` by\n\`node scripts/render-logo.mjs\`. Do not hand-edit; regenerate instead.\n\n| file | use |\n|---|---|\n| \`icon.png\` | \`npx @capacitor/assets generate\` app icon source (1024²) |\n| \`splash.png\` | Capacitor splash source (2732², bg \`${ICON}\`) |\n`,
);
console.log('wrote resources/README.md');
