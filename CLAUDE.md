# Card Vault

Mobile-first PWA that lets someone photograph a sports card and instantly know **what it is** and **roughly what it's worth**. Built for older collectors and people who have inherited large vintage collections (1930s–1960s baseball especially) and don't want to research thousands of cards by hand.

## Primary user

**Not** the seasoned collector. The target is:

- A spouse / child / grandchild going through an inherited shoebox
- An older collector who wants to inventory what they own
- Someone who needs a **fast, plain-English** answer: *what is this, is it worth something, should I keep it / grade it / sell it*

If a feature requires collector jargon to use, it doesn't belong in v1.

## Tech stack

- **Frontend:** Vanilla HTML/CSS/JS PWA (no framework). Matches the rest of the SVL portfolio (Challenge, PinPoint, Card-on-File, Capital City Matchgames).
- **Hosting:** Firebase Hosting
- **Auth:** Firebase Anonymous Auth by default (frictionless for older users), upgradeable in-app to a shared email+password **family login** (`#/account`) so multiple phones can share one collection. Requires the Email/Password provider enabled in Firebase Console → Authentication → Sign-in method.
- **Database:** Firestore
- **Image storage:** Firebase Cloud Storage
- **AI vision:** Claude Opus 4.8 via the Anthropic SDK (called from a Cloud Function so the key never ships to the client). Adaptive thinking + `output_config.format` json_schema for guaranteed structured output + ephemeral prompt caching on `IDENTIFY_PROMPT` (~90% cost reduction after the first scan).
- **Pricing:** AI rough-estimate first; real eBay sold comps later (see Pricing strategy)

## MVP scope

### IN

1. **Scan** — guided two-shot: capture the front, then the app prompts for the back of the same card (skippable); the pair stays together as one card
2. **AI identify** — Cloud Function calls Claude Opus 4.8 (Anthropic SDK) and returns: sport, year, set/manufacturer, player, card number, team, rookie flag, HOF flag, confidence
3. **Rough value estimate** — same vision call asks for a ballpark range labeled clearly as *rough — verify with eBay sold listings*
4. **Save to collection** — write card + image URL to Firestore
5. **View collection** — list view with thumbnails, totals, basic search/filter
6. **Card detail page** — full info, both photos, delete/re-scan
7. **High-value flag** — simple "Possibly valuable — verify with a pro" banner above some threshold (e.g. estimated > $250)

### DEFERRED (do NOT build in v1)

- Batch scanning
- Custom CV models / on-device inference
- Real eBay sold-comp integration (see below)
- AI condition grading
- PSA-equivalent estimates
- Selling assistance / eBay listing generation
- Auction-house recommendations
- Insurance / appraisal reports
- Variations and parallels recognition
- Modern cards (1970s+) — works opportunistically but not tuned for it

## The two honest unknowns

### Pricing data

eBay's public sold-listings API was deprecated. Real options:

- **eBay Marketplace Insights API** — 90 days of sold data, but requires approval (slow)
- **PriceCharting / Card Ladder / 130point** — paid APIs
- **MVP:** ask Claude for a rough range from training knowledge; label it loudly as a rough estimate; integrate real comp data in v2 once the scan-identify-save loop is proven

### Card database

TCDB has no public API. For MVP we lean on Claude's training knowledge of mainstream vintage sets (Topps, Bowman, Goudey, Play Ball, Leaf). Works reasonably well for famous players and well-known sets; weaker on obscure variants. Add a structured database integration in a later phase.

## Architecture

```
[Phone camera]
     |
     v
[PWA: scan view]  --upload-->  [Cloud Storage: /scans/{uid}/{cardId}/front.jpg]
     |
     v
[Cloud Function: identifyCard]  --calls-->  [Claude Opus 4.8 via Anthropic SDK]
     |                                       returns structured JSON
     |                                       (output_config.format json_schema)
     v
[PWA: result view]  --save-->  [Firestore: users/{uid}/cards/{cardId}]
     |
     v
[PWA: collection view]  <--read--  Firestore
```

Scans land as `status:"pending"` and surface in the **Needs review** view (`#/review`, `#/review/{cardId}`) before being kept into the collection. A public, read-only **share** view (`#/share/{token}`) renders the owner's kept cards via the no-auth `getSharedCollection` function.

## Data model (Firestore)

```
users/{uid}
  createdAt
  displayName? (optional)
  shareToken?      // current public view-only share token (→ shares/{token}); null/absent ⇒ no active link

users/{uid}/cards/{cardId}
  createdAt
  status           // "pending" (just scanned, needs review) | "kept" (in collection)  (missing ⇒ treat as "kept")
  itemType         // "card" | "pack" | "box"  (missing ⇒ treat as "card")
  imageFrontUrl
  imageBackUrl?
  identified: {    // CARD shape (PACK/BOX use itemLabel/configuration/sealed/notable instead of player/cardNumber/team/isRookie/isHOF)
    sport          // "baseball"
    year           // 1952
    set            // "Topps"          ← grouped as "Manufacturer" in UI
    player         // "Mickey Mantle"
    cardNumber     // "311"
    team           // "Yankees" (nullable for non-team sports)
    isRookie       // boolean
    isHOF          // boolean
    confidence     // 0-1
    userEdited?    // true if user corrected AI's guess
  }
  valueEstimate: {
    low            // dollars
    high           // dollars
    note           // "rough — verify with eBay sold listings"
    estimatedAt
  }
  ebayPrices?      // real recent eBay sold-comp stats from identifyCard, or null
                   //   { median, min, max, count, query, searchUrl, fetchedAt }
                   //   (when no comps found: { query, count: 0, searchUrl })
  userNotes?       // free text
  locationId?      // → users/{uid}/locations/{id}
  conditionGuess?  // (planned — not yet implemented) user-entered string for v1; AI-graded later

shares/{token}     // top-level; unguessable token → owner. Client-denied in rules (Admin-only via Cloud Functions)
  uid              // owner whose kept cards this token exposes
  createdAt
```

The collection view shows only **kept** cards (`status:"kept"` or missing); pending scans live in the "Needs review" view (`#/review`). It groups items as **Manufacturer (set) → Year → Team** via nested `<details>` elements — the primary browse pattern for working through an inherited collection. Sealed packs/boxes have no team, so they bucket under their `itemLabel` at that level. Search / sort / **type (card/pack/box)** / sport / Rookie / HOF / year-range filters narrow what gets bucketed.

**Durable pending-review pool.** A scan is uploaded + written to Firestore as `status:"pending"` immediately after identification (not held in memory until Save), so leaving the app — tapping an external eBay link, reloading, switching devices — no longer loses scanned cards. The "Needs review" view at `#/review` (and `#/review/{cardId}`) lists pending cards; reviewing one is either **Keep** (`status`→`"kept"`, with edits/notes/location) or **Discard** (deletes the doc; the `onCardDeleted` trigger cleans up its Storage images).

**Bulk location.** In Bulk mode the scan view shows a location picker (with inline "+ New"); the chosen location is auto-applied as `locationId` to every card scanned in that batch, so a whole box gets one location automatically.

**Public view-only share link.** From the Collection view ("Share") the owner can create / copy / revoke an unguessable link backed by `shares/{token}`. Anyone with the link opens `#/share/{token}` to see a read-only gallery of the owner's **kept** cards. `getSharedCollection` strips `valueEstimate`, `ebayPrices`, `userNotes`, and `locationId` — so the public view shows cards and details but **no** dollar values, notes, or locations. The recipient view hides the app's nav chrome (`body.viewing-share`).

**Three item types.** The scan view has a Card / Pack / Box selector; the chosen type tags every capture and is passed to `identifyCard`, which switches to a type-specific prompt + JSON schema. Result/detail/collection/CSV/edit-form/eBay-listing all branch on `itemType` via shared helpers (`itemTypeOf`, `displayName`, `identifiedSummaryHTML`, `renderEditFormHTML`).

**AI eBay descriptions.** The "Generate eBay listing" panel has a "✦ Write a better description with AI" button → `generateListing` Cloud Function (Opus 4.8 + `web_search_20260209`) returns a researched, sales-oriented description (editable, templated fallback already in the box). Gated through `generateListingDescription()`, which returns a mock when `USE_MOCK_AI`.

**Inline locations.** The card detail edit form has a "+ New" button next to the Location select that creates a storage location (writes `users/{uid}/locations/{id}`) and assigns it without leaving the page.

**Front + back in one capture.** The live camera is a guided two-shot: capture the front, then the same shutter becomes "Capture back" (corner thumbnail shows the captured front; a "Skip — save front only" button queues front-only). The pair travels as one queue job → one card, in both single and Bulk mode; closing the camera mid-pair queues the front alone so nothing is lost. Both images go to `identifyCard` and are stored as `imageFrontUrl` / `imageBackUrl`.

**Family login (shared collection).** Every device starts on its own invisible anonymous account. The top-bar user chip (reads "Set up sharing" while anonymous) links to `#/account`, where **creating** the family login runs `linkWithCredential` on the current anonymous user — same uid, so the phone that already holds the collection keeps every card — and the other phones simply **sign in** with the shared email+password to see the same collection. Signing in on a phone whose own account has cards warns first (count via `getCountFromServer`); sign-out drops the device back to a fresh anonymous account. Startup no longer calls `signInAnonymously` unconditionally — it waits for the first auth state so a restoring family session isn't replaced by a new anonymous one.

## File layout

```
card-vault/
  CLAUDE.md
  firebase.json                (excludes the icon source from deploy)
  .firebaserc                  (default → card-vault-d8fa4)
  firestore.rules              (owner-only)
  storage.rules                (owner-only)
  .gitignore
  package.json                 (root tooling: sharp for icon generation)
  package-lock.json
  public/
    index.html                 (top gradient strip, About page, scan-mark)
    app.css                    (Cosmic Slate tokens, all view styles)
    app.js                     (firebaseConfig wired, USE_MOCK_AI flag, all views)
    manifest.json
    sw.js                      (network-first + skipWaiting/clients.claim)
    icons/
      card-vault-icon.png      (6.6MB source — Gemini output; not deployed)
      icon-192.png             (transparent corners)
      icon-512.png             (transparent corners; also used in scan view)
      icon-maskable-512.png    (solid bg for OS masking)
  functions/
    package.json               (@anthropic-ai/sdk)
    package-lock.json
    index.js                   (identifyCard onCall — Opus 4.8, branches by itemType card/pack/box; generateListing onCall — Opus 4.8 + web_search, AI eBay descriptions; createShareLink / revokeShareLink onCall — auth'd, manage shares/{token} + users/{uid}.shareToken; getSharedCollection onCall — PUBLIC/no-auth, returns owner's kept cards with values/notes/location stripped; onCardDeleted trigger — cleans up Storage images)
  scripts/
    generate-icons.mjs         (npm run icons — SVG→PNG, legacy)
    import-icon.mjs            (npm run icon:import — chroma-key + resize)
```

## Phases

**Phase 0 (scaffold) — DONE.** Folder, files, plan doc.

**Phase 1 (scan + identify locally) — DONE + EXPANDED.** Camera capture, mock identify response, full result view. Beyond original scope: generated PWA icons (192/512/maskable), About page with plain-language disclaimers, inline edit-details flow (Player/Year/Set/#/Sport/Rookie/HOF), user notes field, confidence-aware copy (soft "I'm not sure" banner under 50% confidence), and empty-state CTA on collection.

**Phase 2 (real AI) — DONE.** LIVE at **`https://card-vault-d8fa4.web.app`**. Firebase project `card-vault-d8fa4` is parented under the `bkleinkn-org` Google Cloud Organization (note: doesn't show in the default Firebase Console projects list — bookmark the direct URL). Cloud Function `identifyCard` deployed to `us-central1` reading `ANTHROPIC_API_KEY` from Firebase Secrets Manager. Client `USE_MOCK_AI = false` flag flipped — real scans hit Claude Opus 4.8. Build IAM roles (`cloudbuild.builds.builder`, `artifactregistry.writer`, `logging.logWriter`) granted to the default Compute Engine service account once; future deploys work without re-granting.

**Phase 3 (collection) — DONE.** Firestore CRUD, list view, detail view with edit flow, delete, search — all live and exercised via the deployed app.

**Phase 4 (polish) — DONE.** High-value flagging, totals, edit flow, notes, confidence-aware copy, CSV export, full search/sort/filter, Manufacturer→Year→Team hierarchical collection grouping, eBay listing generator with 1-click copy, custom Card Vault icon (transparent-cornered, also displayed in scan view), Cosmic Slate dark reskin (Inter + JetBrains Mono, slate-950 canvas, indigo accent, top gradient strip, glassmorphism). Network-first SW + auto-reload on update so deploys propagate to existing tabs within ~60s.

**Phase 5 (item types + AI listings + background scanning) — DONE, LIVE.** Background scan queue with a review tray + Bulk mode (capture many, identify in background, review before save). Card / Pack / Box item types end-to-end. AI-written eBay descriptions via `generateListing`. Inline location creation on the detail page. Deployed and confirmed live (hosting bundle verified byte-identical to the repo; live `identifyCard` exercises the new flow).

**Phase 6 (durable review pool + sharing) — DONE, LIVE.** Durable pending-review pool: scans persist to Firestore as `status:"pending"` the moment they're identified, so nothing is lost on reload / external link / device switch; the "Needs review" view (`#/review`) handles Keep vs Discard and the collection shows only kept cards. Bulk mode auto-applies a batch location to every card. Public view-only share link: `createShareLink` / `revokeShareLink` (auth'd) + `getSharedCollection` (PUBLIC) back a `shares/{token}` → uid map (Admin-only in rules), surfaced as a `#/share/{token}` read-only gallery with dollar values, notes, and locations stripped. Deployed and confirmed live (pending-status writes pass the deployed rules; share functions serving).

**Phase 7 (front+back capture + family login) — DONE, LIVE.** Guided front→back two-shot camera flow (skippable back, one queue job per item, front salvaged if the camera closes mid-pair, dead-track detection on camera reuse) and the `#/account` family-login view (create-by-linking / sign-in with are-you-sure card-count warning / password reset / sign-out) for sharing one collection across phones; About page rewritten to point multi-phone users at the family login. Client-only change; no function changes. The **Email/Password** provider was enabled programmatically via the Identity Toolkit admin API (`PATCH /admin/v2/projects/card-vault-d8fa4/config?updateMask=signIn.email` with a gcloud token + `X-Goog-User-Project` header — the Console toggle is the manual equivalent). Note: this phase's docs were committed from one PC but its code never was; it was re-implemented from scratch to match. E2E-verified against production Firebase from a local static server with a canvas-stubbed `getUserMedia` (pair → one card with front+back, skip → front-only, provider live via expected `invalid-credential` on a fake sign-in).

**Phase 8+ (deferred features)** — real pricing data, condition grading, selling assistance, custom domain, etc.

## Operational notes

- **Live URL:** [https://card-vault-d8fa4.web.app](https://card-vault-d8fa4.web.app)
- **Firebase Console (direct link — bookmark; the org-parented project doesn't show in the default project list):** [console.firebase.google.com/project/card-vault-d8fa4/overview](https://console.firebase.google.com/project/card-vault-d8fa4/overview)
- **GitHub:** [github.com/bkleinkn/card-vault](https://github.com/bkleinkn/card-vault)
- **Per-scan cost:** ~$0.01–0.03 (Claude Opus 4.8 with prompt-caching kicking in after the first scan). `generateListing` (AI eBay descriptions) also uses Opus 4.8 with web search.
- **Secret rotation:** if `ANTHROPIC_API_KEY` ever needs swapping, run `firebase functions:secrets:set ANTHROPIC_API_KEY --project=card-vault-d8fa4` then `firebase deploy --only functions --project=card-vault-d8fa4`.
- **USE_MOCK_AI escape hatch:** Flip `const USE_MOCK_AI = true;` in `public/app.js` to temporarily revert all scans to the mocked 1956 Mantle without redeploying the function (useful for cost-free UX iteration). Then `firebase deploy --only hosting`.
- **Cross-PC dev:** `git clone https://github.com/bkleinkn/card-vault.git && cd card-vault && npm install && cd functions && npm install`. Firebase deploys from any machine work after `firebase login` (as bkleinkn@gmail.com) — secrets stay server-side.
