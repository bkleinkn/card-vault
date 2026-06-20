// Card Vault Cloud Functions.
// Phase 2 wires this up; Phase 1 ships with `mockIdentify` on the client so
// no AI tokens are spent until the UX is dialed in on a real phone.
//
// Deploy: cd "C:\Projects\card-vault" && firebase deploy --only functions
// Set key: firebase functions:secrets:set ANTHROPIC_API_KEY

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");

admin.initializeApp();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// --- Identify prompts & schemas --------------------------------------------
// Three item types share one Cloud Function. Each gets its own frozen system
// prompt (cached) and a structured-output schema so Claude returns exactly the
// shape the client expects with no prose or markdown fences.

const CARD_PROMPT = `
You are a vintage sports card expert. The user has photographed a single sports card.
Identify it as accurately as possible. Lean conservative on confidence.

Return JSON ONLY in this exact shape (no prose, no markdown fences):
{
  "identified": {
    "sport": "baseball|football|basketball|hockey|other",
    "year": <number or null>,
    "set": "<manufacturer/set, e.g. 'Topps', 'Bowman', 'Goudey', 'Upper Deck'>",
    "player": "<string>",
    "cardNumber": "<string or null>",
    "team": "<team name (e.g. 'Yankees', 'Bulls', 'Oilers'), or null for non-team sports/cards>",
    "isRookie": <true|false>,
    "isHOF": <true|false>,
    "confidence": <number 0..1>
  },
  "valueEstimate": {
    "low": <number, USD, raw/ungraded ballpark>,
    "high": <number, USD>,
    "note": "Rough estimate. Verify with recent eBay sold listings before buying or selling."
  }
}

If you can't identify the card with at least 0.3 confidence, set player to "Unknown card" and confidence to 0.
`.trim();

const PACK_PROMPT = `
You are a vintage sports card expert. The user has photographed a SEALED PACK of sports cards
(a wax pack, cello pack, rack pack, foil pack, jumbo pack, etc.) — NOT a single card.
Identify the product as accurately as possible. Lean conservative on confidence.

Return JSON ONLY in this exact shape (no prose, no markdown fences):
{
  "identified": {
    "sport": "baseball|football|basketball|hockey|other",
    "year": <number or null>,
    "set": "<manufacturer/brand/set, e.g. 'Topps', 'Fleer', 'Upper Deck'>",
    "itemLabel": "<short product label, e.g. 'Wax Pack', 'Cello Pack', 'Rack Pack', 'Foil Pack', 'Jumbo Pack'>",
    "configuration": "<what's inside if known, e.g. '15 cards + 1 stick of gum', or null>",
    "sealed": <true|false — does it appear factory sealed / unopened>,
    "notable": "<one short sentence on notable rookies/cards possible in this set or why it's collectible, or null>",
    "confidence": <number 0..1>
  },
  "valueEstimate": {
    "low": <number, USD, ballpark for a sealed/unopened pack>,
    "high": <number, USD>,
    "note": "Rough estimate for a sealed pack. Authenticity and seal matter a lot — verify with recent eBay sold listings."
  }
}

If you can't identify the pack with at least 0.3 confidence, set itemLabel to "Unknown pack" and confidence to 0.
`.trim();

const BOX_PROMPT = `
You are a vintage sports card expert. The user has photographed a SEALED BOX of sports cards
(a wax box, hobby box, blaster box, jumbo box, rack box, cello box, etc.) — NOT a single card or pack.
Identify the product as accurately as possible. Lean conservative on confidence.

Return JSON ONLY in this exact shape (no prose, no markdown fences):
{
  "identified": {
    "sport": "baseball|football|basketball|hockey|other",
    "year": <number or null>,
    "set": "<manufacturer/brand/set, e.g. 'Topps', 'Fleer', 'Upper Deck'>",
    "itemLabel": "<short product label, e.g. 'Wax Box', 'Hobby Box', 'Blaster Box', 'Jumbo Box', 'Rack Box'>",
    "configuration": "<pack/card layout if known, e.g. '36 wax packs, 15 cards each', or null>",
    "sealed": <true|false — does it appear factory sealed / unopened>,
    "notable": "<one short sentence on notable rookies/cards possible in this set or why it's collectible, or null>",
    "confidence": <number 0..1>
  },
  "valueEstimate": {
    "low": <number, USD, ballpark for a sealed/unopened box>,
    "high": <number, USD>,
    "note": "Rough estimate for a sealed box. Authenticity and seal matter a lot — verify with recent eBay sold listings."
  }
}

If you can't identify the box with at least 0.3 confidence, set itemLabel to "Unknown box" and confidence to 0.
`.trim();

// `additionalProperties: false` is required by the structured-outputs spec.
const CARD_SCHEMA = {
  type: "object",
  properties: {
    identified: {
      type: "object",
      properties: {
        sport: { type: "string", enum: ["baseball", "football", "basketball", "hockey", "other"] },
        year: { type: ["number", "null"] },
        set: { type: "string" },
        player: { type: "string" },
        cardNumber: { type: ["string", "null"] },
        team: { type: ["string", "null"] },
        isRookie: { type: "boolean" },
        isHOF: { type: "boolean" },
        confidence: { type: "number" },
      },
      required: ["sport", "year", "set", "player", "cardNumber", "team", "isRookie", "isHOF", "confidence"],
      additionalProperties: false,
    },
    valueEstimate: {
      type: "object",
      properties: { low: { type: "number" }, high: { type: "number" }, note: { type: "string" } },
      required: ["low", "high", "note"],
      additionalProperties: false,
    },
  },
  required: ["identified", "valueEstimate"],
  additionalProperties: false,
};

// Packs and boxes share one schema shape (the prompts differ).
function sealedSchema() {
  return {
    type: "object",
    properties: {
      identified: {
        type: "object",
        properties: {
          sport: { type: "string", enum: ["baseball", "football", "basketball", "hockey", "other"] },
          year: { type: ["number", "null"] },
          set: { type: "string" },
          itemLabel: { type: "string" },
          configuration: { type: ["string", "null"] },
          sealed: { type: "boolean" },
          notable: { type: ["string", "null"] },
          confidence: { type: "number" },
        },
        required: ["sport", "year", "set", "itemLabel", "configuration", "sealed", "notable", "confidence"],
        additionalProperties: false,
      },
      valueEstimate: {
        type: "object",
        properties: { low: { type: "number" }, high: { type: "number" }, note: { type: "string" } },
        required: ["low", "high", "note"],
        additionalProperties: false,
      },
    },
    required: ["identified", "valueEstimate"],
    additionalProperties: false,
  };
}

function promptAndSchema(itemType) {
  if (itemType === "pack") return { prompt: PACK_PROMPT, schema: sealedSchema(), label: "pack" };
  if (itemType === "box") return { prompt: BOX_PROMPT, schema: sealedSchema(), label: "box" };
  return { prompt: CARD_PROMPT, schema: CARD_SCHEMA, label: "card" };
}

function cleanApiKey() {
  // Strip a leading BOM (U+FEFF) and stray whitespace that can sneak into the
  // secret when pasted/saved on Windows — otherwise the SDK rejects it as
  // "not a legal HTTP header value".
  return ANTHROPIC_API_KEY.value().replace(/^﻿/, "").trim();
}

exports.identifyCard = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, region: "us-central1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const { frontImageBase64, backImageBase64, itemType } = request.data || {};
    if (!frontImageBase64) {
      throw new HttpsError("invalid-argument", "frontImageBase64 is required.");
    }

    const type = itemType === "pack" || itemType === "box" ? itemType : "card";
    const { prompt, schema, label } = promptAndSchema(type);

    const client = new Anthropic({ apiKey: cleanApiKey() });

    const userContent = [
      { type: "text", text: `Identify this ${label}. Respond with JSON only.` },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frontImageBase64 } },
    ];
    if (backImageBase64) {
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: backImageBase64 },
      });
    }

    let response;
    try {
      response = await client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { format: { type: "json_schema", schema } },
        // Frozen per-type prompt, cached across scans (~90% cost cut on the
        // cached portion). Each item type keys its own cache entry.
        system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent }],
      });
    } catch (err) {
      console.error("Anthropic API call failed:", err);
      throw new HttpsError("internal", `Could not identify ${label}. Try again.`);
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      console.error("No text block in response:", JSON.stringify(response));
      throw new HttpsError("internal", "Model returned no content.");
    }

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      console.error("Failed to parse JSON:", textBlock.text);
      throw new HttpsError("internal", "Model returned invalid JSON.");
    }

    parsed.itemType = type;
    if (parsed.valueEstimate) {
      parsed.valueEstimate.estimatedAt = new Date().toISOString();
    }

    // Real recent eBay sold prices as a second source. Query differs by type.
    const ident = parsed.identified || {};
    let queryParts;
    if (type === "card") {
      queryParts = ident.player && ident.player !== "Unknown card"
        ? [ident.year, ident.set, ident.player, ident.cardNumber]
        : null;
    } else {
      const known = ident.itemLabel && !/^unknown/i.test(ident.itemLabel);
      queryParts = known ? [ident.year, ident.set, ident.itemLabel, "sealed"] : null;
    }
    if (queryParts) {
      parsed.ebayPrices = await fetchEbaySoldPrices(queryParts.filter(Boolean).join(" "));
    }

    return parsed;
  },
);

// --- AI eBay listing description -------------------------------------------
// Writes a professional, sales-oriented description for one item, using web
// search so it can ground the copy in what's actually known/collectible about
// the card, pack, or box (set significance, notable rookies, demand) rather
// than emitting a generic template. Returns plain prose the user can edit.
const LISTING_SYSTEM = `
You are an expert sports-card seller who writes eBay listing descriptions that sell.
You write accurate, engaging, professional descriptions that build buyer confidence and interest.

Rules you MUST follow:
- Be specific and informative about the item: who/what it is, the set, the year, and why a collector would want it.
- Use web search to ground the description in real, current facts about the player, set, or product
  (significance, notable rookies/cards, why it's collectible, general market interest). Do NOT invent or
  promise specific prices, grades, or sales — the seller verifies pricing separately.
- The item is RAW / UNGRADED and sold as-is from a personal collection. Always tell buyers to review the
  photos carefully to judge condition themselves. Do not claim or guarantee a condition or authenticity grade.
- Encourage interest honestly — highlight genuine desirability, but never overstate, fabricate, or mislead.
- Write in clean paragraphs (and a short bulleted highlights list when useful). No markdown headers, no emojis.
- Output ONLY the finished description text. No preamble, no "Here is", no surrounding quotes.
`.trim();

exports.generateListing = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, region: "us-central1", timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const { itemType, identified, valueEstimate, userNotes } = request.data || {};
    if (!identified) {
      throw new HttpsError("invalid-argument", "identified is required.");
    }
    const type = itemType === "pack" || itemType === "box" ? itemType : "card";

    // Compact, factual summary of what the user has, for the model to expand on.
    const facts = [];
    facts.push(`Item type: ${type}`);
    if (identified.year) facts.push(`Year: ${identified.year}`);
    if (identified.set) facts.push(`Set/Brand: ${identified.set}`);
    if (identified.sport) facts.push(`Sport: ${identified.sport}`);
    if (type === "card") {
      if (identified.player) facts.push(`Player: ${identified.player}`);
      if (identified.cardNumber) facts.push(`Card number: ${identified.cardNumber}`);
      if (identified.team) facts.push(`Team: ${identified.team}`);
      if (identified.isRookie) facts.push("This is a ROOKIE card.");
      if (identified.isHOF) facts.push("Player is a Hall of Famer.");
    } else {
      if (identified.itemLabel) facts.push(`Product: ${identified.itemLabel}`);
      if (identified.configuration) facts.push(`Configuration: ${identified.configuration}`);
      facts.push(identified.sealed ? "Appears factory sealed / unopened." : "Seal/contents unconfirmed.");
      if (identified.notable) facts.push(`Notable: ${identified.notable}`);
    }
    if (valueEstimate && (valueEstimate.low || valueEstimate.high)) {
      facts.push(`Seller's rough reference range (do NOT quote as a price): $${valueEstimate.low} - $${valueEstimate.high}.`);
    }
    if (userNotes) facts.push(`Seller notes: ${userNotes}`);

    const client = new Anthropic({ apiKey: cleanApiKey() });

    let response;
    try {
      response = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 2000,
        thinking: { type: "adaptive" },
        tools: [{ type: "web_search_20260209", name: "web_search" }],
        system: [{ type: "text", text: LISTING_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content:
              `Write an eBay listing description for the following item. ` +
              `Research it with web search first, then write the description.\n\n` +
              facts.join("\n"),
          },
        ],
      });
    } catch (err) {
      console.error("generateListing API call failed:", err);
      throw new HttpsError("internal", "Could not write a description. Try again.");
    }

    // Concatenate the final text blocks (web search interleaves tool blocks).
    const description = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!description) {
      throw new HttpsError("internal", "Model returned no description.");
    }
    return { description };
  },
);

// Scrape eBay's sold-listings page for the given free-text query and return
// median / min / max / count, or null on any failure. User-Agent mimics a real
// browser because eBay returns an empty body to the default Node fetch UA.
async function fetchEbaySoldPrices(query, maxResults = 60) {
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1&_ipg=${maxResults}`;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) {
      console.warn(`eBay fetch returned ${response.status} for query "${query}"`);
      return null;
    }
    const html = await response.text();

    const priceMatches = [
      ...html.matchAll(
        /<span class="s-item__price">[^<]*?\$([\d,]+(?:\.\d{2})?)[^<]*?<\/span>/g,
      ),
    ];
    const prices = priceMatches
      .map((m) => parseFloat(m[1].replace(/,/g, "")))
      .filter((p) => !isNaN(p) && p > 0)
      .slice(0, maxResults);

    if (prices.length === 0) {
      return { query, count: 0, searchUrl: url };
    }

    prices.sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const min = prices[0];
    const max = prices[prices.length - 1];

    return {
      median: Math.round(median * 100) / 100,
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
      count: prices.length,
      query,
      searchUrl: url,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`eBay fetch failed for "${query}":`, err.message);
    return null;
  }
}
