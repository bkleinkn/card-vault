// Flat ESLint config (ESLint v9/v10) for the Cloud Functions code.
// CommonJS + Node 20. Intentionally lenient: this lints existing, working code,
// so we prefer warnings over errors and never block a build on style.
//
// Self-contained on purpose: it pulls recommended rules from `@eslint/js` only
// when that package is resolvable, and otherwise falls back to a small built-in
// rule set. This keeps `npm run lint` working without adding new dependencies
// to functions/package.json.

let recommended = { rules: {} };
try {
  // `@eslint/js` ships ESLint's recommended ruleset. Use it if present.
  recommended = require("@eslint/js").configs.recommended;
} catch {
  // Fall back to a minimal, high-signal set of core rules. These are all
  // built into ESLint itself (no plugin needed).
  recommended = {
    rules: {
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-constant-condition": "warn",
      "valid-typeof": "error",
    },
  };
}

const nodeGlobals = {
  // Node CommonJS module globals.
  require: "readonly",
  module: "writable",
  exports: "writable",
  __dirname: "readonly",
  __filename: "readonly",
  // Node runtime globals.
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  global: "readonly",
  fetch: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  AbortController: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
};

module.exports = [
  // Don't lint dependencies or generated output.
  { ignores: ["node_modules/**", "coverage/**"] },

  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: nodeGlobals,
    },
    rules: {
      ...recommended.rules,
      // Lenient by design — surface issues without failing the build.
      "no-unused-vars": "warn",
      "no-console": "off",
    },
  },

  // Test files get Node's built-in test-runner globals.
  {
    files: ["test/**/*.js"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        before: "readonly",
        after: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
      },
    },
  },
];
