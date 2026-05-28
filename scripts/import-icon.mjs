// Take a single source PNG (e.g. one Gemini / Midjourney spit out)
// and render the three PWA icon sizes into public/icons/.
//
// Usage:
//   npm run icon:import -- "C:\Projects\card-vault\gemini-icon.png"

import sharp from "sharp";
import { writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public", "icons");

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

// Step 1: auto-trim flat borders (AI generators usually leave a white margin).
// Threshold 20/255 catches off-white JPEG noise without eating into content.
const trimmed = await sharp(srcPath).trim({ threshold: 20 }).toBuffer();
const trimMeta = await sharp(trimmed).metadata();
const srcMeta = await sharp(srcPath).metadata();
console.log(`Source: ${srcPath}`);
console.log(`  Original: ${srcMeta.width}x${srcMeta.height}`);
console.log(`  Trimmed:  ${trimMeta.width}x${trimMeta.height}`);

const sizes = [
  { name: "icon-192.png", px: 192 },
  { name: "icon-512.png", px: 512 },
  { name: "icon-maskable-512.png", px: 512 },
];

for (const { name, px } of sizes) {
  const buf = await sharp(trimmed)
    .resize(px, px, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(OUT_DIR, name), buf);
  console.log(`wrote ${name} (${px}x${px})`);
}

console.log("\nDone. Hard-refresh the app (Ctrl+Shift+R) to see the new icon.");
console.log("(If the PWA is installed on a home screen, remove + re-install to update that icon copy.)");
