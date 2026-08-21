// tests/path-safety/verify-cv-facts-facts.test.mjs — approved-fact store wiring
// for verify-cv-facts.mjs (roadmap 1.2, gap #3).
//
// The facts store (config/path.facts.yml) is an additional verification
// authority: a metric or non-metric fact that appears in an approved fact
// passes the gate even when the literal source files phrase it differently.
// A missing/empty store must change nothing.
import { pass, fail } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nverify-cv-facts.mjs — approved-fact store wiring');

const mod = await import(pathToFileURL(join(import.meta.dirname, '..', '..', 'verify-cv-facts.mjs')).href);

const dir = mkdtempSync(join(tmpdir(), 'cops-verify-facts-'));
const sourcePath = join(dir, 'source.md');
const factsPath = join(dir, 'facts.yml');
const emptyFactsPath = join(dir, 'empty.yml');
const configPath = join(dir, 'config.json');

function cleanup() {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

try {
  writeFileSync(sourcePath, 'Van works at Example Corp as an Operations Lead.\n');
  writeFileSync(emptyFactsPath, 'version: 1\nprincipal: Van\nfacts: []\n');
  writeFileSync(configPath, '{"allow_metrics": [], "allow_facts": [], "forbidden_phrases": [], "warn_phrases": []}\n');
  writeFileSync(factsPath, [
    'version: 1',
    'principal: Van',
    'facts:',
    '  - id: test-availability',
    '    text: Van improved automated area availability from 95% to 98% by standardizing response routines.',
    '    source: cv.md',
    '    source_date: 2026-08-14',
    '    approved: true',
    '  - id: test-employer',
    '    text: Van joined Initech as a Senior Analyst.',
    '    source: cv.md',
    '    source_date: 2026-08-14',
    '    approved: true',
    '  - id: test-unapproved',
    '    text: Van once reached 500 active users.',
    '    source: cv.md',
    '    source_date: 2026-08-14',
    '    approved: false',
    '',
  ].join('\n'));

  const base = { sourcePaths: [sourcePath], configPath, factsPath };

  // (a) Metric present only in an approved fact passes the gate.
  const metricTarget = 'Van improved automated area availability from 95% to 98%.';
  const metricResult = mod.verifyFacts(metricTarget, base);
  if (metricResult.verdict === 'pass' && metricResult.invented.length === 0) {
    pass('approved-fact metric (95%→98%) passes when absent from source');
  } else {
    fail(`approved-fact metric should pass, got ${JSON.stringify(metricResult)}`);
  }

  // (b) Non-metric fact (employer + title) present only in an approved fact passes.
  const employerTarget = 'Van joined Initech as a Senior Analyst.';
  const employerResult = mod.verifyFacts(employerTarget, base);
  if (employerResult.verdict === 'pass' && employerResult.unsupportedFacts.length === 0) {
    pass('approved-fact employer/title passes when absent from source');
  } else {
    fail(`approved-fact employer should pass, got ${JSON.stringify(employerResult)}`);
  }

  // (c) Same target WITHOUT the facts store blocks (gate not weakened by default).
  const noFactsResult = mod.verifyFacts(employerTarget, { sourcePaths: [sourcePath], configPath, factsPath: emptyFactsPath });
  if (noFactsResult.verdict === 'block' && noFactsResult.unsupportedFacts.length === 2) {
    pass('empty facts store leaves the gate unchanged (still blocks)');
  } else {
    fail(`empty facts store should still block, got ${JSON.stringify(noFactsResult)}`);
  }

  // (d) A missing facts file behaves identically to an empty one.
  const missingResult = mod.verifyFacts(employerTarget, { sourcePaths: [sourcePath], configPath, factsPath: join(dir, 'does-not-exist.yml') });
  if (missingResult.verdict === 'block' && missingResult.unsupportedFacts.length === 2) {
    pass('missing facts file is treated as empty (gate unchanged)');
  } else {
    fail(`missing facts file should still block, got ${JSON.stringify(missingResult)}`);
  }

  // (e) An unapproved fact is NOT honored as authority.
  const unapprovedTarget = 'Van once reached 500 active users.';
  const unapprovedResult = mod.verifyFacts(unapprovedTarget, base);
  if (unapprovedResult.verdict === 'block' && unapprovedResult.invented.includes('500 users')) {
    pass('unapproved fact is not honored as an authority');
  } else {
    fail(`unapproved fact should block, got ${JSON.stringify(unapprovedResult)}`);
  }

  // (f) A broken facts store (unreadable) warns loudly on stderr and still
  // fails closed — never a silent fail-open.
  const brokenFactsPath = join(dir, 'broken-store');
  mkdirSync(brokenFactsPath, { recursive: true });
  let warned = '';
  const originalError = console.error;
  console.error = (msg) => { warned += String(msg); };
  let brokenResult;
  try {
    brokenResult = mod.verifyFacts(employerTarget, { sourcePaths: [sourcePath], configPath, factsPath: brokenFactsPath });
  } finally {
    console.error = originalError;
  }
  if (brokenResult.verdict === 'block' && /WARNING: could not read approved-fact store/.test(warned)) {
    pass('broken facts store warns loudly and still blocks');
  } else {
    fail(`broken facts store should warn + block, got verdict=${brokenResult?.verdict} warned=${JSON.stringify(warned)}`);
  }
} finally {
  cleanup();
}