// Take a single source PNG (e.g. one Gemini / Midjourney spit out)
// and render the three PWA icon sizes into public/icons/.
//
// Pipeline:
//   1. auto-trim flat borders (AI generators usually leave white margin)
//   2. chroma-key out remaining near-white pixels → transparent
//      (so the rounded badge's corner triangles aren't solid white)
//   3. resize to each PWA size
//
// Exception: the maskable variant uses the trimmed-but-NOT-chroma-keyed
// version. Maskable icons need solid backgrounds for the OS mask to clip
// against; a transparent corner gets cut into.
//
// Usage:
//   npm run icon:import -- "C:\Projects\card-vault\gemini-icon.png"

import sharp from "sharp";
import { writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public", "icons");

// R/G/B values above this threshold are treated as "white" and made transparent.
// 240 catches anti-aliased edge noise without eating into the gold bezel.
const WHITE_THRESHOLD = 240;

const src = process.argv[2];
if (!src) {
  console.error('Usage: node scripts/import-icon.mjs "<path-to-source-image>"');
  console.error('Example: npm run icon:import -- "C:\\Projects\\card-vault\\gemini-icon.png"');
  process.exit(1);
}

const srcPath = resolve(src);
try {
  await access(srcPath);
} catch {
  console.error(`Source image not found: ${srcPath}`);
  process.exit(1);
}

// Step 1: auto-trim flat borders. Threshold 20/255 handles JPEG-style noise
// without eating into content.
const trimmed = await sharp(srcPath).trim({ threshold: 20 }).toBuffer();
const trimMeta = await sharp(trimmed).metadata();
const srcMeta = await sharp(srcPath).metadata();
console.log(`Source: ${srcPath}`);
console.log(`  Original: ${srcMeta.width}x${srcMeta.height}`);
console.log(`  Trimmed:  ${trimMeta.width}x${trimMeta.height}`);

// Step 2: chroma-key out white pixels → transparent. Read raw RGBA, walk
// the buffer, set alpha=0 for near-white pixels, re-encode as PNG.
const { data: rgba, info } = await sharp(trimmed)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

let removedPixels = 0;
for (let i = 0; i < rgba.length; i += 4) {
  if (
    rgba[i] > WHITE_THRESHOLD &&
    rgba[i + 1] > WHITE_THRESHOLD &&
    rgba[i + 2] > WHITE_THRESHOLD
  ) {
    rgba[i + 3] = 0;
    removedPixels++;
  }
}
console.log(`  Made transparent: ${removedPixels.toLocaleString()} pixels`);

const transparent = await sharp(rgba, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .png()
  .toBuffer();

// Step 3a: standard "any-purpose" icons with transparent corners.
const transparentSizes = [
  { name: "icon-192.png", px: 192 },
  { name: "icon-512.png", px: 512 },
];

for (const { name, px } of transparentSizes) {
  const buf = await sharp(transparent)
    .resize(px, px, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(OUT_DIR, name), buf);
  console.log(`wrote ${name} (${px}x${px}) — transparent corners`);
}

// Step 3b: maskable variant — solid background (no chroma key) so the OS
// mask has something to clip against without eating into the badge.
const maskableBuf = await sharp(trimmed)
  .resize(512, 512, { fit: "cover", position: "centre" })
  .png({ compressionLevel: 9 })
  .toBuffer();
await writeFile(join(OUT_DIR, "icon-maskable-512.png"), maskableBuf);
console.log(`wrote icon-maskable-512.png (512x512) — solid background for OS masking`);

console.log("\nDone. Hard-refresh the app (Ctrl+Shift+R) to see the new icon.");
console.log("(If the PWA is installed on a home screen, remove + re-install to update that icon copy.)");
