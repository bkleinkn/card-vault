// Unit tests for the pure helpers exported from functions/index.js.
// Run with: node --test   (or: node --test test/)
//
// These only exercise side-effect-free helpers (`promptAndSchema`,
// `parseEbaySoldHtml`) via the `__testables` export, so they don't touch
// Firebase, the network, or the Anthropic SDK.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  promptAndSchema,
  parseEbaySoldHtml,
  buildPriceQuery,
  buildRelevance,
} = require("../index.js").__testables;

// One result card in eBay's current markup: title then price. `sold` renders
// the green "positive" price; sponsored/active listings render "primary".
const row = (title, price, sold = true) =>
  `<div class=s-card__title><span class="su-styled-text primary default">${title}</span></div>` +
  `<span class="su-styled-text ${sold ? "positive" : "primary"} bold large-1 s-card__price">${price}</span>`;

const WANT = { year: 1976, lastName: "cochrane" };
const TITLE = "1976 Topps Mickey Cochrane #348 All-Time All-Stars";

test("parseEbaySoldHtml ignores eBay's 'fewer words' padding (the $3,184.97 bug)", () => {
  // Reproduces 2026-07-21: one real $2.50 sale, then eBay pads the page with
  // unrelated listings. Counting the padding priced a $2 common at $3,184.97.
  const html =
    row(TITLE, "$2.50") +
    "<h2>Results matching fewer words</h2>" +
    row("1952 Topps Mickey Mantle PSA 8", "$97,379.88") +
    row("1961 Yankees Team Lot", "$457.66") +
    row("1976 Topps Complete Set", "$1,200.00");

  const stats = parseEbaySoldHtml(html, WANT);
  assert.strictEqual(stats.count, 1, "only the pre-divider listing is a comp");
  assert.strictEqual(stats.median, 2.5);
  assert.strictEqual(stats.max, 2.5, "padding must not reach the range");
});

test("parseEbaySoldHtml requires the listing title to name the player and year", () => {
  const html =
    row(TITLE, "$3.00") +
    row("1976 Topps Nolan Ryan #330", "$85.00") + // right year, wrong player
    row("1987 Topps Mickey Cochrane reprint", "$40.00"); // right player, wrong year

  const stats = parseEbaySoldHtml(html, WANT);
  assert.strictEqual(stats.count, 1, "only the matching title counts");
  assert.strictEqual(stats.median, 3);
});

test("parseEbaySoldHtml counts only sold (green) prices, not sponsored rows", () => {
  const html =
    row(TITLE, "$4.00") +
    row(TITLE, "$999.00", false) + // sponsored/active asking price
    row("Shop on eBay", "$20.00");

  const stats = parseEbaySoldHtml(html, WANT);
  assert.strictEqual(stats.count, 1);
  assert.strictEqual(stats.median, 4);
});

test("parseEbaySoldHtml rejects foreign-currency and impossible prices", () => {
  // A non-US proxy exit renders local currency with a bare "$" (five cards in
  // the first sweep came back scaled ~1000x), or with a letter prefix.
  const html =
    row(TITLE, "$5.00") +
    row(TITLE, "C $60.00") +
    row(TITLE, "AU $75.00") +
    row(TITLE, "$1,062,903.38");

  const stats = parseEbaySoldHtml(html, WANT);
  assert.strictEqual(stats.count, 1, "only the plain-USD, plausible price counts");
  assert.strictEqual(stats.median, 5);
});

test("parseEbaySoldHtml takes the low end of a price range", () => {
  const stats = parseEbaySoldHtml(row(TITLE, "$10.00 to $50.00"), WANT);
  assert.strictEqual(stats.count, 1);
  assert.strictEqual(stats.median, 10);
});

test("parseEbaySoldHtml trims outliers out of the reported range", () => {
  // Eight ordinary sales plus a complete-set lot that slipped the title filter.
  const html =
    [2, 3, 3, 4, 4, 5, 5, 6].map((p) => row(TITLE, `$${p}.00`)).join("") +
    row(TITLE, "$900.00");

  const stats = parseEbaySoldHtml(html, WANT);
  assert.strictEqual(stats.count, 8, "the lot should be trimmed");
  assert.strictEqual(stats.max, 6);
  assert.ok(stats.median >= 3 && stats.median <= 5, `median ${stats.median} should sit with the pack`);
});

test("parseEbaySoldHtml returns { count: 0 } on empty input", () => {
  assert.deepStrictEqual(parseEbaySoldHtml(""), { count: 0 });
});

test("parseEbaySoldHtml returns { count: 0 } on garbage input", () => {
  const garbage = "<div>no prices here</div><span>$nope</span>";
  assert.deepStrictEqual(parseEbaySoldHtml(garbage), { count: 0 });
});

test("parseEbaySoldHtml reports nothing rather than guessing when titles are unparseable", () => {
  // If eBay reshuffles its markup, silence beats a median over mystery rows.
  const html = `<span class="su-styled-text positive bold large-1 s-card__price">$25.00</span>`;
  assert.deepStrictEqual(parseEbaySoldHtml(html, WANT), { count: 0 });
});

test("buildRelevance picks the surname and skips generational suffixes", () => {
  assert.deepStrictEqual(buildRelevance({ year: 1989, player: "Ken Griffey Jr." }, "card"), {
    year: 1989,
    lastName: "Griffey",
  });
  // Packs/boxes have no surname to key on.
  assert.strictEqual(buildRelevance({ year: 1986, itemLabel: "Wax Pack" }, "pack").lastName, "");
});

test("buildPriceQuery refuses unidentified items", () => {
  assert.strictEqual(buildPriceQuery({ player: "Unknown card", year: 1956 }, "card"), null);
  assert.strictEqual(buildPriceQuery({}, "card"), null);
  assert.strictEqual(
    buildPriceQuery({ year: 1956, set: "Topps", player: "Mickey Mantle", cardNumber: "135" }, "card"),
    "1956 Topps Mickey Mantle 135",
  );
});

test("promptAndSchema labels item types correctly", () => {
  assert.strictEqual(promptAndSchema("pack").label, "pack");
  assert.strictEqual(promptAndSchema("box").label, "box");
  assert.strictEqual(promptAndSchema("card").label, "card");
  // Anything unrecognized falls through to the card prompt/schema.
  assert.strictEqual(promptAndSchema("anything").label, "card");
  assert.strictEqual(promptAndSchema(undefined).label, "card");
});

test("card schema is strict (additionalProperties === false)", () => {
  const { schema } = promptAndSchema("card");
  assert.strictEqual(schema.additionalProperties, false);
  // The documented top-level requirements should be present.
  assert.ok(Array.isArray(schema.required));
  assert.ok(schema.required.includes("identified"));
  assert.ok(schema.required.includes("valueEstimate"));
});

test("pack/box schema is also strict (additionalProperties === false)", () => {
  for (const t of ["pack", "box"]) {
    const { schema } = promptAndSchema(t);
    assert.strictEqual(schema.additionalProperties, false, `${t} schema should be strict`);
    assert.ok(schema.required.includes("identified"));
    assert.ok(schema.required.includes("valueEstimate"));
  }
});
