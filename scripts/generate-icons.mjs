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
  <rect width="512" height="512" rx="100" fill="#0b3d2e"/>
  <rect x="116" y="76" width="280" height="360" rx="20" fill="#f6f4ee"/>
  <rect x="116" y="76" width="280" height="360" rx="20" fill="none" stroke="#b8860b" stroke-width="6"/>
  <rect x="136" y="96" width="240" height="320" rx="10" fill="none" stroke="#0b3d2e" stroke-width="3"/>
  <text x="256" y="306" font-family="Georgia, 'Times New Roman', serif" font-size="190" font-weight="700"
        text-anchor="middle" fill="#0b3d2e">CV</text>
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
