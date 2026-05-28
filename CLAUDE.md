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
- **Auth:** Firebase Anonymous Auth (frictionless for older users; upgradeable to email later)
- **Database:** Firestore
- **Image storage:** Firebase Cloud Storage
- **AI vision:** Claude Opus 4.7 via the Anthropic SDK (called from a Cloud Function so the key never ships to the client). Adaptive thinking + `output_config.format` json_schema for guaranteed structured output + ephemeral prompt caching on `IDENTIFY_PROMPT` (~90% cost reduction after the first scan).
- **Pricing:** AI rough-estimate first; real eBay sold comps later (see Pricing strategy)

## MVP scope

### IN

1. **Scan** — take a photo of the front of a card (optional back), preview, hit Identify
2. **AI identify** — Cloud Function calls OpenAI Vision and returns: sport, year, set/manufacturer, player, card number, rookie flag, HOF flag, confidence
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

TCDB has no public API. For MVP we lean on OpenAI Vision's knowledge of mainstream vintage sets (Topps, Bowman, Goudey, Play Ball, Leaf). Works reasonably well for famous players and well-known sets; weaker on obscure variants. Add a structured database integration in a later phase.

## Architecture

```
[Phone camera]
     |
     v
[PWA: scan view]  --upload-->  [Cloud Storage: /scans/{uid}/{cardId}/front.jpg]
     |
     v
[Cloud Function: identifyCard]  --calls-->  [OpenAI Vision API]
     |                                       returns structured JSON
     v
[PWA: result view]  --save-->  [Firestore: users/{uid}/cards/{cardId}]
     |
     v
[PWA: collection view]  <--read--  Firestore
```

## Data model (Firestore)

```
users/{uid}
  createdAt
  displayName? (optional)

users/{uid}/cards/{cardId}
  createdAt
  imageFrontUrl
  imageBackUrl?
  identified: {
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
  userNotes?       // free text
  conditionGuess?  // user-entered string for v1; AI-graded later
```

The collection view groups cards as **Manufacturer (set) → Year → Team** via nested `<details>` elements — the primary browse pattern for working through an inherited collection. Search / sort / sport / Rookie / HOF / year-range filters narrow the cards that get bucketed into the groups.

## File layout

```
card-vault/
  CLAUDE.md
  firebase.json
  .firebaserc                  (project ID placeholder)
  firestore.rules
  storage.rules
  .gitignore
  package.json                 (root tooling: sharp for icon generation)
  public/
    index.html
    app.css
    app.js
    manifest.json
    sw.js
    icons/
      icon-192.png
      icon-512.png
      icon-maskable-512.png
  functions/
    package.json
    index.js                   (identifyCard onCall)
  scripts/
    generate-icons.mjs         (npm run icons)
```

## Phases

**Phase 0 (scaffold) — DONE.** Folder, files, plan doc.

**Phase 1 (scan + identify locally) — DONE + EXPANDED.** Camera capture, mock identify response, full result view. Beyond original scope: generated PWA icons (192/512/maskable), About page with plain-language disclaimers, inline edit-details flow (Player/Year/Set/#/Sport/Rookie/HOF), user notes field, confidence-aware copy (soft "I'm not sure" banner under 50% confidence), and empty-state CTA on collection.

**Phase 2 (real AI) — DONE.** LIVE at **`https://card-vault-d8fa4.web.app`**. Firebase project `card-vault-d8fa4` is parented under the `bkleinkn-org` Google Cloud Organization (note: doesn't show in the default Firebase Console projects list — bookmark the direct URL). Cloud Function `identifyCard` deployed to `us-central1` reading `ANTHROPIC_API_KEY` from Firebase Secrets Manager. Client `USE_MOCK_AI = false` flag flipped — real scans hit Claude Opus 4.7. Build IAM roles (`cloudbuild.builds.builder`, `artifactregistry.writer`, `logging.logWriter`) granted to the default Compute Engine service account once; future deploys work without re-granting.

**Phase 3 (collection) — DONE.** Firestore CRUD, list view, detail view with edit flow, delete, search — all live and exercised via the deployed app.

**Phase 4 (polish)** — High-value flagging, totals, edit flow, notes, confidence-aware copy: DONE. Basic CSV export still pending.

**Phase 5+ (deferred features)** — real pricing data, condition grading, batch scan, selling assistance, etc.

## Open questions (need answers before Phase 2)

1. Firebase project: new dedicated `card-vault` project, or piggyback an existing one?
2. OpenAI API key: existing key or new one for this project?
3. Custom domain or `card-vault.web.app` for v1?
