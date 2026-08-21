// tests/learning-loop.test.mjs — Unit suite for learning-loop.mjs (roadmap 1.3, gap #10).
// Covers the empty-data branch (must never throw), the populated branch with
// fixture tracker content, verbatim outcome feedback extraction, report gap
// parsing, recommendation gating, and the CLI main-guard (import must not run
// the CLI or write data/learning-feedback.json).
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const SCRIPT = join(ROOT, 'learning-loop.mjs');

function check(desc, condition, details = '') {
  if (condition) pass(desc);
  else fail(`${desc}${details ? ` (${details})` : ''}`);
}

function readIfExists(p) {
  try {
    return existsSync(p) ? readFileSync(p, 'utf-8') : null;
  } catch {
    return null;
  }
}

console.log('\nlearning-loop.mjs — close-the-loop aggregator (roadmap 1.3, gap #10)');

try {
  const ll = await import(pathToFileURL(SCRIPT).href);

  // ---- Empty branch: must be null-safe, never throw, never fabricate. ----
  const empty = ll.aggregateFeedback({
    trackerContent: '',
    statesContent: '',
    todayStr: '2026-08-14',
  });
  check('empty inputs yield funnel null', empty.funnel === null);
  check('empty inputs yield velocity null', empty.velocity === null);
  check('empty inputs yield calibration null', empty.calibration === null);
  check('empty inputs yield waiting null', empty.waiting === null);
  check('empty inputs yield followups null', empty.followups === null);
  check('empty inputs yield skillGaps null', empty.skillGaps === null);
  check('empty inputs yield empty outcomeFeedback', Array.isArray(empty.outcomeFeedback) && empty.outcomeFeedback.length === 0);
  check('empty inputs carry schema version', empty.schemaVersion === ll.SCHEMA_VERSION);
  check('empty inputs gate recommendation to "empty"', empty.recommendations.length === 1 && /empty/i.test(empty.recommendations[0]));

  // ---- Populated branch with fixture tracker + real states/benchmarks. ----
  const tracker = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-06-01 | Acme | Senior Dev | 4.0/5 | Applied | ✅ | [1](reports/001-acme-2026-06-01.md) | |',
    '| 2 | 2026-06-05 | Beta | Dev | 4.5/5 | Interview | ✅ | [2](reports/002-beta-2026-06-05.md) | |',
    '| 3 | 2026-06-10 | Gamma | Lead | 4.2/5 | Offer | ✅ | [3](reports/003-gamma-2026-06-10.md) | |',
  ].join('\n');
  const states = readIfExists(join(ROOT, 'templates', 'states.yml')) ?? '';
  const { loadBenchmarks } = await import(pathToFileURL(join(ROOT, 'funnel-velocity.mjs')).href);
  const benchmarks = loadBenchmarks().benchmarks;

  const full = ll.aggregateFeedback({
    trackerContent: tracker,
    statesContent: states,
    benchmarks,
    todayStr: '2026-08-14',
  });
  check('populated tracker yields funnel', full.funnel !== null && full.funnel.everApplied === 3);
  check('populated tracker yields velocity', full.velocity !== null);
  check('populated tracker yields calibration', full.calibration !== null);
  check('populated tracker yields waiting', full.waiting !== null);
  check('populated tracker sets sources.tracker', full.sources.tracker === true);
  check('populated tracker yields non-empty recommendations', Array.isArray(full.recommendations) && full.recommendations.length > 0);
  check('populated tracker passes patterns null', full.patterns === null);

  // ---- Outcome feedback: verbatim extraction from a temp outcomes dir. ----
  const tmpDir = mkdtempSync(join(tmpdir(), 'cops-ll-outcomes-'));
  const outcomeDir = join(tmpDir, 'outcomes');
  mkdirSync(join(outcomeDir, '1_acme_eng'), { recursive: true });
  writeFileSync(join(outcomeDir, '1_acme_eng', 'outcome.md'), [
    '## Entry: 2026-07-01',
    '',
    '- **Outcome Type**: rejected',
    '- **Canonical State**: Rejected',
    '- **Stage Reached**: Tech Screen',
    '- **Verbatim Feedback**:',
    '> Great technical depth, but we hired someone with',
    '> more product experience in this domain.',
    '- **Notes**: referral pipeline',
    '',
  ].join('\n'));
  const outcomeLogs = ll.readOutcomeFeedback(outcomeDir);
  check('outcome feedback parsed with date', outcomeLogs.length === 1 && outcomeLogs[0].date === '2026-07-01');
  check('outcome feedback verbatim multi-line', outcomeLogs[0].feedback === 'Great technical depth, but we hired someone with\nmore product experience in this domain.');
  check('outcome feedback type/stage', outcomeLogs[0].outcomeType === 'rejected' && outcomeLogs[0].stageReached === 'Tech Screen');
  check('outcome feedback dir name parsed', outcomeLogs[0].num === 1 && outcomeLogs[0].company === 'acme' && outcomeLogs[0].role === 'eng');
  check('outcome feedback missing dir returns []', Array.isArray(ll.readOutcomeFeedback(join(tmpDir, 'nope'))) && ll.readOutcomeFeedback(join(tmpDir, 'nope')).length === 0);

  // A role containing underscores must split on the FIRST underscore only.
  mkdirSync(join(outcomeDir, '2_beta_senior_data_engineer'), { recursive: true });
  writeFileSync(join(outcomeDir, '2_beta_senior_data_engineer', 'outcome.md'), [
    '## Entry: 2026-07-02',
    '',
    '- **Outcome Type**: rejected',
    '- **Canonical State**: Rejected',
    '- **Stage Reached**: Onsite',
    '- **Verbatim Feedback**:',
    '> Solid, but the team went with a specialist.',
    '',
  ].join('\n'));
  const outcomeLogs2 = ll.readOutcomeFeedback(outcomeDir);
  check('outcome feedback role with underscore parsed',
    outcomeLogs2.length === 2 && outcomeLogs2[1].num === 2 && outcomeLogs2[1].company === 'beta' && outcomeLogs2[1].role === 'senior_data_engineer');

  // ---- Report gap parsing: readReports over a temp tracker + reports dir. ----
  const reportDir = join(tmpDir, 'reports');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, '001-acme-2026-06-01.md'), [
    '# Evaluation — Acme',
    '',
    '**Score:** 4.0/5',
    '',
    '## Machine Summary',
    '',
    '```yaml',
    'score: 4.0',
    'hard_stops:',
    '  - "Missing Kubernetes"',
    'soft_gaps:',
    '  - "Weak on distributed systems"',
    '```',
    '',
  ].join('\n'));
  const appsFile = join(tmpDir, 'applications.md');
  // A non-table line containing pipes must be skipped, not parsed as a row.
  writeFileSync(appsFile, `${tracker}\nnote: | 1 | 2026-06-01 | Acme | Senior Dev | 4.0/5 | Applied | ✅ | [9](reports/009-acme-2026-06-01.md) | |\n`);
  const parsedReports = ll.readReports(appsFile, reportDir);
  check('readReports parses gapText', parsedReports.length === 1 && /Kubernetes/.test(parsedReports[0].gapText));
  check('readReports carries score', parsedReports[0].score === 4.0);
  check('readReports skips non-table lines', parsedReports.length === 1 && parsedReports.every((r) => r.num === '1'));

  // ---- CLI main-guard: importing must not run the CLI or write artifacts. ----
  const feedbackPath = join(ROOT, 'data', 'learning-feedback.json');
  const existedBefore = existsSync(feedbackPath);
  // Import happened at the top; the CLI must not have written the file.
  const wroteOnImport = !existedBefore && existsSync(feedbackPath);
  check('import does not write data/learning-feedback.json', wroteOnImport === false);

  // Explicit CLI run DOES write + exit 0.
  const out = execFileSync(NODE, [SCRIPT, '--json'], { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' });
  const cliJson = JSON.parse(out);
  check('CLI --json emits schema-versioned object', cliJson.schemaVersion === ll.SCHEMA_VERSION);

  // Self-test entrypoint stays green through the CLI.
  const st = execFileSync(NODE, [SCRIPT, '--self-test'], { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' });
  check('CLI --self-test passes', /learning-loop self-test: \d+ passed, 0 failed/.test(st));

  rmSync(tmpDir, { recursive: true, force: true });
} catch (err) {
  fail(`learning-loop suite crashed: ${err.stack || err.message}`);
}