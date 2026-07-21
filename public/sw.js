// Service worker — keeps PWA install criteria happy AND ensures deploys
// propagate without manual refresh.
//
// Strategy: NETWORK-FIRST for everything. The cache stores the last
// successful response, used only as an offline fallback. This avoids the
// classic "deployed new version but users still see the old one" trap.
//
// Bump CACHE on breaking changes — the activate handler wipes everything
// else.

// v6: forces a full cache wipe. A device holding a cached older index.html
// against a newer app.js hit a null element and died during module init —
// bumping this purges the stale shell on the next load.
const CACHE = "card-vault-v6";

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

// Only cache static assets we recognize. SPA deep-link URLs (handled by the
// hosting rewrite) all return the same index.html, so caching them under their
// own URL would bloat the cache with duplicate shell copies.
const STATIC_EXT = /\.(?:js|css|json|png)$/i;

function isStaticAsset(url) {
  const path = url.pathname.replace(/^\//, "");
  // version.json is the client's staleness probe — serving it from cache would
  // make a stale install report itself as current. Never cache it; when
  // offline the fetch simply fails and the version check skips.
  if (path === "version.json") return false;
  return SHELL_ASSETS.includes(path) || SHELL_ASSETS.includes("./" + path) || STATIC_EXT.test(url.pathname);
}

// Cross-origin CDNs whose URLs are immutable/version-pinned: the Firebase SDK
// (loaded from a /10.x.x/ path) and Google Fonts (versioned URLs). Because the
// URL changes whenever the asset changes, cache-first is safe here — no
// staleness risk — and it lets the app shell + fonts load instantly on repeat
// visits and survive an offline first paint.
const IMMUTABLE_CDNS = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (url.origin !== location.origin) {
    // Cache-first for the known immutable CDNs; all other cross-origin requests
    // (Firestore, Storage, the callable functions, Anthropic) pass through.
    if (IMMUTABLE_CDNS.includes(url.hostname)) {
      event.respondWith(
        caches.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((response) => {
              if (response && response.status === 200) {
                const clone = response.clone();
                caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
              }
              return response;
            }),
        ),
      );
    }
    return;
  }

  const isNavigate = req.mode === "navigate";

  // Network-first: always try fresh, fall back to cache for offline.
  event.respondWith(
    fetch(req)
      .then((response) => {
        // Only cache clean, basic (same-origin, non-redirected) 200s. Redirects
        // and opaque responses are never stored.
        const cacheable =
          response &&
          response.status === 200 &&
          !response.redirected &&
          response.type === "basic";
        if (cacheable) {
          if (isNavigate) {
            // Store every navigation (SPA deep links → rewritten index.html)
            // under one canonical key so the cache holds a single shell copy.
            const clone = response.clone();
            caches.open(CACHE).then((c) => c.put(new Request("./"), clone)).catch(() => {});
          } else if (isStaticAsset(url)) {
            const clone = response.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
        }
        return response;
      })
      .catch(() => (isNavigate ? caches.match("./") : caches.match(req))),
  );
});
