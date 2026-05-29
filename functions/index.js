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

const IDENTIFY_PROMPT = `
You are a vintage sports card expert. The user has photographed a sports card.
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

// JSON schema for output_config.format — guarantees Claude returns this exact
// shape with no markdown fences and no extra fields. `additionalProperties:
// false` is required by the structured-outputs spec.
const IDENTIFY_SCHEMA = {
  type: "object",
  properties: {
    identified: {
      type: "object",
      properties: {
        sport: {
          type: "string",
          enum: ["baseball", "football", "basketball", "hockey", "other"],
        },
        year: { type: ["number", "null"] },
        set: { type: "string" },
        player: { type: "string" },
        cardNumber: { type: ["string", "null"] },
        team: { type: ["string", "null"] },
        isRookie: { type: "boolean" },
        isHOF: { type: "boolean" },
        confidence: { type: "number" },
      },
      required: [
        "sport",
        "year",
        "set",
        "player",
        "cardNumber",
        "team",
        "isRookie",
        "isHOF",
        "confidence",
      ],
      additionalProperties: false,
    },
    valueEstimate: {
      type: "object",
      properties: {
        low: { type: "number" },
        high: { type: "number" },
        note: { type: "string" },
      },
      required: ["low", "high", "note"],
      additionalProperties: false,
    },
  },
  required: ["identified", "valueEstimate"],
  additionalProperties: false,
};

exports.identifyCard = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, region: "us-central1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const { frontImageBase64, backImageBase64 } = request.data || {};
    if (!frontImageBase64) {
      throw new HttpsError("invalid-argument", "frontImageBase64 is required.");
    }

    // Strip a leading BOM (U+FEFF) and any stray whitespace/newlines that can
    // sneak into the secret when it's pasted/saved on Windows — otherwise the
    // SDK rejects the value as "not a legal HTTP header value".
    const apiKey = ANTHROPIC_API_KEY.value().replace(/^﻿/, "").trim();
    const client = new Anthropic({ apiKey });

    // Build the user turn: instruction text + image(s).
    const userContent = [
      { type: "text", text: "Identify this card. Respond with JSON only." },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: frontImageBase64,
        },
      },
    ];
    if (backImageBase64) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: backImageBase64,
        },
      });
    }

    let response;
    try {
      response = await client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 16000,
        // Adaptive thinking lets Claude reason about ambiguous cards (year
        // differences, off-grade scans) before committing to an answer.
        thinking: { type: "adaptive" },
        // Structured output — the API enforces this schema; the model
        // cannot return prose, markdown fences, or extra fields.
        output_config: {
          format: { type: "json_schema", schema: IDENTIFY_SCHEMA },
        },
        // System prompt wrapped with cache_control so Anthropic caches it
        // across every scan (~90% cost reduction on the cached portion).
        // IDENTIFY_PROMPT is frozen content — cache hits from scan 2 onward.
        system: [
          {
            type: "text",
            text: IDENTIFY_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userContent }],
      });
    } catch (err) {
      console.error("Anthropic API call failed:", err);
      throw new HttpsError("internal", "Could not identify card. Try again.");
    }

    // output_config.format guarantees the first text block holds valid JSON.
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

    if (parsed.valueEstimate) {
      parsed.valueEstimate.estimatedAt = new Date().toISOString();
    }

    // After Claude identifies the card, scrape eBay's sold-listings page for
    // real recent sales. Second pricing source, free, no API key needed.
    // Fails gracefully — null result if blocked or HTML changes, in which case
    // the client just shows Claude's ballpark alone.
    const ident = parsed.identified;
    if (ident && ident.player && ident.player !== "Unknown card") {
      const queryParts = [ident.year, ident.set, ident.player, ident.cardNumber].filter(Boolean);
      const ebayQuery = queryParts.join(" ");
      parsed.ebayPrices = await fetchEbaySoldPrices(ebayQuery);
    }

    return parsed;
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

    // Match sold-listing prices. eBay's HTML uses s-item__price spans. Some
    // listings show ranges (e.g. "$5 to $20") — we skip those and keep
    // single-value prices only for cleaner median.
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
