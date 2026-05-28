// Generates PWA icons from a single inline SVG source.
// Run: npm run icons

import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public", "icons");

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="topGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f59e0b"/>
      <stop offset="0.5" stop-color="#f43f5e"/>
      <stop offset="1" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="100" fill="#020617"/>
  <rect x="116" y="76" width="280" height="360" rx="20" fill="#0f172a"/>
  <rect x="116" y="76" width="280" height="360" rx="20" fill="none" stroke="#6366f1" stroke-width="3"/>
  <rect x="136" y="96" width="240" height="8" rx="4" fill="url(#topGrad)"/>
  <rect x="136" y="118" width="240" height="298" rx="8" fill="none" stroke="#1e293b" stroke-width="2"/>
  <text x="256" y="316" font-family="Inter, 'Segoe UI', sans-serif" font-size="180" font-weight="800"
        text-anchor="middle" fill="#e0e7ff" letter-spacing="-6">CV</text>
</svg>
`.trim();

await mkdir(OUT_DIR, { recursive: true });

const sizes = [
  { name: "icon-192.png", px: 192 },
  { name: "icon-512.png", px: 512 },
  { name: "icon-maskable-512.png", px: 512, padding: 64 },
];

for (const { name, px, padding = 0 } of sizes) {
  const inner = px - padding * 2;
  let pipeline = sharp(Buffer.from(SVG), { density: 384 }).resize(inner, inner);
  if (padding > 0) {
    pipeline = pipeline.extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: { r: 11, g: 61, b: 46, alpha: 1 },
    });
  }
  const buf = await pipeline.png().toBuffer();
  await writeFile(join(OUT_DIR, name), buf);
  console.log(`wrote ${name} (${px}x${px})`);
}
