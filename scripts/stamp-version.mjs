// Stamp a build id into the three places the client's version check compares:
//   public/index.html   <meta name="cv-build" content="...">   (the shell)
//   public/app.js       const BUILD = "...";                   (the script)
//   public/version.json { "build": "..." }                     (the server)
//
// Runs automatically as the hosting predeploy hook (see firebase.json), so
// every deploy is stamped without anyone having to remember it. The id is a
// UTC timestamp plus the git short hash when available.
//
// Why: an iOS home-screen install kept serving old code across six deploys
// (2026-07-20) with no way for the app to notice. With matching stamps, the
// client can detect both "my page and my script are from different deploys"
// and "the server has moved on" — and reload itself once to converge.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
let build =
  `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
  `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
try {
  build += "-" + execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  // No git available — timestamp alone still uniquely identifies the deploy.
}

// Replace a marker in a file, refusing to continue if the marker is missing —
// a silent no-op here would quietly disable the whole version check.
function stamp(path, pattern, replacement) {
  const before = readFileSync(path, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before && !before.includes(`"${build}"`)) {
    console.error(`stamp-version: marker ${pattern} not found in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, after);
}

stamp(
  "public/index.html",
  /(<meta name="cv-build" content=")[^"]*(")/,
  `$1${build}$2`,
);
stamp(
  "public/app.js",
  /(const BUILD = ")[^"]*(";)/,
  `$1${build}$2`,
);
writeFileSync("public/version.json", JSON.stringify({ build }) + "\n");

console.log(`stamp-version: ${build}`);
