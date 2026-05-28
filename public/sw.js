// Service worker — keeps PWA install criteria happy AND ensures deploys
// propagate without manual refresh.
//
// Strategy: NETWORK-FIRST for everything. The cache stores the last
// successful response, used only as an offline fallback. This avoids the
// classic "deployed new version but users still see the old one" trap.
//
// Bump CACHE on breaking changes — the activate handler wipes everything
// else.

const CACHE = "card-vault-v3";

// Precache the app shell so a first-time offline visit still works.
const SHELL_ASSETS = ["./", "index.html", "app.css", "app.js", "manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .catch(() => {}),
  );
  // Activate immediately — paired with clients.claim() below, this means a
  // freshly-installed SW takes over without waiting for all tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only handle same-origin requests. Cross-origin (Firebase SDKs, Google
  // Fonts, Anthropic via the function) passes straight through.
  if (url.origin !== location.origin) return;

  // Network-first: always try fresh, fall back to cache for offline.
  event.respondWith(
    fetch(req)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(req)),
  );
});
