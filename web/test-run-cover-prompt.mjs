// Tests for buildCoverPrompt() using Node's built-in test runner.
// Imports directly from run-cover-prompt.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test web/test-run-cover-prompt.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoverPrompt } from "./src/lib/run-cover-prompt.mjs";

const ctx = { report: "042", company: "Example Corp", role: "Ops Manager", today: "2026-08-09" };

test("prompt names the real renderer + payload write", () => {
  const p = buildCoverPrompt(ctx);
  assert.match(p, /generate-cover-letter\.mjs --payload/);
  assert.match(p, /\/tmp\/cover-payload-/);
  assert.match(p, /output\/\{company-slug\}-\{role-slug\}-cover\.pdf/);
});

test("prompt is headless batch — forbids waiting for interactive questions", () => {
  const p = buildCoverPrompt(ctx);
  assert.match(p, /do NOT stop for interactive questions/i);
  assert.match(p, /web-triggered batch job/i);
});

test("prompt forbids submitting / contacting / inventing", () => {
  const p = buildCoverPrompt(ctx);
  assert.match(p, /Do NOT submit anything anywhere/i);
  assert.match(p, /never invent/i);
  assert.match(p, /cv\.md ONLY/i);
});

test("prompt ends with exactly one VERDICT line", () => {
  const p = buildCoverPrompt(ctx);
  const verdicts = p.split("\n").filter((l) => l.trim().startsWith("VERDICT:"));
  assert.equal(verdicts.length, 1);
  assert.match(verdicts[0], /^VERDICT: 5\/5 — \{actual output path/);
});

test("references the evaluation report + mode + tracker row", () => {
  const p = buildCoverPrompt(ctx);
  assert.match(p, /reports\/042-\*\.md/);
  assert.match(p, /modes\/cover\.md EXACTLY/);
  assert.match(p, /row #042/);
  assert.match(p, /cover letter for Example Corp \(Ops Manager\)/);
});

test("company/role absent still degrades gracefully", () => {
  const p = buildCoverPrompt({ report: "042", company: "", role: "", today: "2026-08-09" });
  assert.match(p, /reports\/042-\*\.md/);
  assert.match(p, /VERDICT: 5\/5 — /);
});