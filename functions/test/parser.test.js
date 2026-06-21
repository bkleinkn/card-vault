// Unit tests for the pure helpers exported from functions/index.js.
// Run with: node --test   (or: node --test test/)
//
// These only exercise side-effect-free helpers (`promptAndSchema`,
// `parseEbaySoldHtml`) via the `__testables` export, so they don't touch
// Firebase, the network, or the Anthropic SDK.

const { test } = require("node:test");
const assert = require("node:assert");

const { promptAndSchema, parseEbaySoldHtml } = require("../index.js").__testables;

// Helper: build an eBay-style price span the parser looks for.
const priceSpan = (n) => `<span class="s-item__price">$${n}</span>`;

test("parseEbaySoldHtml drops the stale first row when there are >3 matches", () => {
  // First row is a stale template price; with >3 matches it should be dropped,
  // leaving 10/20/30/40.
  const html = [
    priceSpan("9,999.99"), // stale "Shop on eBay" template row
    priceSpan("10.00"),
    priceSpan("20.00"),
    priceSpan("30.00"),
    priceSpan("40.00"),
  ].join("\n");

  const stats = parseEbaySoldHtml(html);

  assert.strictEqual(stats.count, 4, "expected the first (stale) row dropped, leaving 4");
  assert.strictEqual(stats.min, 10, "min should be the lowest real price");
  assert.strictEqual(stats.max, 40, "max should be the highest real price");
  // Be tolerant about the exact median definition: just require it sit within
  // the observed data range.
  assert.ok(
    stats.median >= stats.min && stats.median <= stats.max,
    `median ${stats.median} should be within [${stats.min}, ${stats.max}]`,
  );
  // Sanity: the stale $9999.99 row must not have leaked into max.
  assert.ok(stats.max < 9999, "stale high row should have been dropped");
});

test("parseEbaySoldHtml returns { count: 0 } on empty input", () => {
  assert.deepStrictEqual(parseEbaySoldHtml(""), { count: 0 });
});

test("parseEbaySoldHtml returns { count: 0 } on garbage input", () => {
  const garbage = "<div>no prices here</div><span>$nope</span>";
  assert.deepStrictEqual(parseEbaySoldHtml(garbage), { count: 0 });
});

test("parseEbaySoldHtml keeps all matches when there are 3 or fewer", () => {
  // With only 3 matches the parser should NOT drop the first row.
  const html = [priceSpan("10.00"), priceSpan("20.00"), priceSpan("30.00")].join("\n");
  const stats = parseEbaySoldHtml(html);
  assert.strictEqual(stats.count, 3, "with <=3 matches no row should be dropped");
  assert.strictEqual(stats.min, 10);
  assert.strictEqual(stats.max, 30);
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
