import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(__dirname, "../client/gameplay/hiscores.css");

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function checkBalancedBraces(source) {
  let depth = 0;
  let inString = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) return { balanced: false, depth };
    }
  }
  return { balanced: depth === 0 && inString === null, depth };
}

/**
 * Extract all top-level and nested (@media / @container / @supports) rule
 * selectors from a CSS stylesheet, skipping @keyframes blocks.
 */
function extractRuleSelectors(cssText) {
  const clean = stripComments(cssText);
  const selectors = [];
  let i = 0;

  function parseBlock(skipRules) {
    let buffer = "";
    while (i < clean.length) {
      const ch = clean[i];
      if (ch === "}") {
        i += 1;
        return;
      }
      if (ch === "{") {
        const header = buffer.trim();
        buffer = "";
        i += 1;
        if (header.startsWith("@")) {
          const isKeyframes = /^@(?:-webkit-)?keyframes\b/i.test(header);
          parseBlock(skipRules || isKeyframes);
        } else {
          if (!skipRules && header) {
            for (const sel of splitSelectors(header)) {
              selectors.push(sel);
            }
          }
          // Skip declaration block body (no nested rules expected, track braces safely)
          let declDepth = 1;
          while (i < clean.length && declDepth > 0) {
            if (clean[i] === "{") declDepth += 1;
            else if (clean[i] === "}") declDepth -= 1;
            i += 1;
          }
        }
        continue;
      }
      if (ch === ";" && buffer.trim().startsWith("@")) {
        buffer = "";
        i += 1;
        continue;
      }
      buffer += ch;
      i += 1;
    }
  }

  parseBlock(false);
  return selectors;
}

function splitSelectors(header) {
  const parts = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < header.length; i += 1) {
    const ch = header[i];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth -= 1;
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth -= 1;
    else if (ch === "," && parenDepth === 0 && bracketDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

test("client/gameplay/hiscores.css exists and has balanced braces", async () => {
  const css = await readFile(cssPath, "utf8");
  assert.ok(css.length > 0, "hiscores.css should not be empty");
  const result = checkBalancedBraces(stripComments(css));
  assert.equal(result.balanced, true, `Braces must be balanced (final depth: ${result.depth})`);
});

test("hiscores.css uses only scoped .hs- selectors with no global element overrides", async () => {
  const css = await readFile(cssPath, "utf8");
  const selectors = extractRuleSelectors(css);
  assert.ok(selectors.length > 0, "Expected parsed CSS selectors");

  const unscoped = selectors.filter((sel) => !sel.startsWith(".hs-"));
  assert.deepEqual(
    unscoped,
    [],
    `Found unscoped selectors in hiscores.css: ${unscoped.join(", ")}`
  );
});

test("hiscores.css defines all required Chronicles / Hiscores classes", async () => {
  const css = await readFile(cssPath, "utf8");
  const clean = stripComments(css);

  const requiredClasses = [
    ".hs-root",
    ".hs-tabs",
    ".hs-tab",
    '.hs-tab[aria-selected="true"]',
    ".hs-live",
    ".hs-controls",
    ".hs-filters",
    ".hs-table-wrap",
    ".hs-table",
    ".hs-rank",
    ".hs-rank-1",
    ".hs-rank-2",
    ".hs-rank-3",
    ".hs-row-self",
    ".hs-player-btn",
    ".hs-order-tag",
    ".hs-badge",
    ".hs-badge-wanted",
    ".hs-pagination",
    ".hs-profile-head",
    ".hs-summary-grid",
    ".hs-stat-card",
    ".hs-stat-label",
    ".hs-stat-value",
    ".hs-stat-rank",
    ".hs-skill-groups",
    ".hs-skill-group",
    ".hs-skill-grid",
    ".hs-skill-cell",
    ".hs-skill-bar",
    ".hs-skill-fill",
    ".hs-skill-max",
    ".hs-compare-bar",
    ".hs-compare-banner",
    ".hs-delta-pos",
    ".hs-delta-neg",
    ".hs-delta-tie",
    ".hs-privacy-bar",
    ".hs-empty",
    ".hs-error",
    ".hs-loading",
  ];

  const missing = requiredClasses.filter((cls) => !clean.includes(cls));
  assert.deepEqual(missing, [], `Missing required CSS classes: ${missing.join(", ")}`);
});

test("hiscores.css uses tabular-nums, medal colors, focus-visible, and responsive media query", async () => {
  const css = await readFile(cssPath, "utf8");
  const clean = stripComments(css);

  assert.match(clean, /font-variant-numeric\s*:\s*tabular-nums\b/, "Expected tabular-nums for numeric ranks/scores");
  assert.match(clean, /\.hs-rank-1\s*\{[^}]*#e6c267/i, "Expected gold #e6c267 on .hs-rank-1");
  assert.match(clean, /\.hs-rank-2\s*\{[^}]*#c9d4e3/i, "Expected silver #c9d4e3 on .hs-rank-2");
  assert.match(clean, /\.hs-rank-3\s*\{[^}]*#c98a5b/i, "Expected bronze #c98a5b on .hs-rank-3");
  assert.match(clean, /:focus-visible\b/, "Expected :focus-visible keyboard focus styling");
  assert.match(clean, /@media\s*\(\s*max-width\s*:\s*640px\s*\)/, "Expected @media (max-width: 640px) responsive rules");
});
