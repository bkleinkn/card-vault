// Card Vault Cloud Functions.
// Phase 2 wires this up; Phase 1 ships with `mockIdentify` on the client so
// no OpenAI tokens are spent until the UX is dialed in on a real phone.
//
// Deploy: cd "C:\Projects\card-vault" && firebase deploy --only functions
// Set key: firebase functions:secrets:set OPENAI_API_KEY

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const OpenAI = require("openai");

admin.initializeApp();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

const IDENTIFY_PROMPT = `
You are a vintage sports card expert. The user has photographed a sports card.
Identify it as accurately as possible. Lean conservative on confidence.

Return JSON ONLY in this exact shape (no prose, no markdown fences):
{
  "identified": {
    "sport": "baseball|football|basketball|hockey|other",
    "year": <number or null>,
    "set": "<string, e.g. 'Topps', 'Bowman', 'Goudey'>",
    "player": "<string>",
    "cardNumber": "<string or null>",
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

exports.identifyCard = onCall(
  { secrets: [OPENAI_API_KEY], cors: true, region: "us-central1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const { frontImageBase64, backImageBase64 } = request.data || {};
    if (!frontImageBase64) {
      throw new HttpsError("invalid-argument", "frontImageBase64 is required.");
    }

    const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });

    const userContent = [
      { type: "text", text: "Identify this card. Respond with JSON only." },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frontImageBase64}` } },
    ];
    if (backImageBase64) {
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${backImageBase64}` },
      });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: IDENTIFY_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const raw = response.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpsError("internal", "Model returned invalid JSON.");
    }

    if (parsed.valueEstimate) {
      parsed.valueEstimate.estimatedAt = new Date().toISOString();
    }
    return parsed;
  },
);
