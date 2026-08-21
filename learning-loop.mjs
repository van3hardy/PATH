#!/usr/bin/env node
/**
 * learning-loop.mjs — Close-the-loop aggregator for career-ops (roadmap 1.3, gap #10)
 *
 * Gathers the analytics the pipeline already computes — lifetime funnel,
 * funnel velocity/calibration/waiting (vs market benchmarks), skill gaps from
 * evaluation reports, and verbatim outcome feedback — into ONE schema-versioned
 * feedback object written to data/learning-feedback.json. It never fabricates:
 * every field is derived from tracked data or copied verbatim from outcome
 * logs. The `patterns` lens runs analyze-patterns.mjs as a child process (it has
 * no exports and test-all parses it by fixed index — it must not be imported or
 * restructured).
 *
 * Run:
 *   node learning-loop.mjs            (human summary to stdout)
 *   node learning-loop.mjs --json     (full feedback object)
 *   node learning-loop.mjs --self-test
 *   node learning-loop.mjs --benchmarks <path>
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

import { computeTrackerStats, computeFunnel, computeFollowupStats, trackerStatusByNum } from './stats.mjs';
import { analyze as analyzeFunnel, loadBenchmarks } from './funnel-velocity.mjs';
import { parseReportGaps, aggregateGaps, extractSkills } from './upskill.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Read a file as UTF-8, or return null when missing (never throws). */
function readIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
  } catch {
    return null;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

const DEFAULT_APPS = join(ROOT, 'data', 'applications.md');
const DEFAULT_STATUS_LOG = join(ROOT, 'data', 'status-log.tsv');
const DEFAULT_FOLLOWUPS = join(ROOT, 'data', 'follow-ups.md');
const DEFAULT_STATES = join(ROOT, 'templates', 'states.yml');
const DEFAULT_OUTCOMES = join(ROOT, 'data', 'outcomes');
const DEFAULT_REPORTS = join(ROOT, 'reports');
const CV_FILE = join(ROOT, 'cv.md');
const PROFILE_FILE = join(ROOT, 'config', 'profile.yml');
const FEEDBACK_FILE = join(ROOT, 'data', 'learning-feedback.json');

export const SCHEMA_VERSION = 1;

/**
 * Read every outcome log under the data/outcomes directory and extract
 * verbatim per-entry feedback. Directory names are `{num}_{company}_{role}`.
 *
 * @param {string} outcomesDir - data/outcomes directory (may be missing)
 * @returns {Array<{date: string, company: string, role: string,
 *   outcomeType: string, stageReached: string, feedback: string}>}
 */
export function readOutcomeFeedback(outcomesDir = DEFAULT_OUTCOMES) {
  if (!existsSync(outcomesDir)) return [];
  const results = [];
  let entries;
  try {
    entries = readdirSync(outcomesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const logPath = join(outcomesDir, entry.name, 'outcome.md');
    const content = readIfExists(logPath);
    if (!content) continue;
    const match = /^(\d+)_(.+)$/.exec(entry.name);
    let num = null;
    let company = null;
    let role = null;
    if (match) {
      num = match[1];
      const rest = match[2];
      const sep = rest.indexOf('_');
      company = sep === -1 ? rest : rest.slice(0, sep);
      role = sep === -1 ? null : rest.slice(sep + 1);
    }
    const blocks = content.split(/\n(?=## Entry: )/);
    for (const block of blocks) {
      const dateMatch = /^## Entry:\s*(\S+)/m.exec(block);
      const typeMatch = /\*\*Outcome Type\*\*:\s*(.+)/.exec(block);
      const stageMatch = /\*\*Stage Reached\*\*:\s*(.+)/.exec(block);
      const feedbackLines = block
        .split('\n')
        .filter((l) => l.trim().startsWith('>'))
        .map((l) => l.replace(/^\s*>\s?/, ''))
        .join('\n');
      results.push({
        date: dateMatch ? dateMatch[1] : null,
        company: company ?? entry.name,
        role: role ?? null,
        num: num ? Number(num) : null,
        outcomeType: typeMatch ? typeMatch[1].trim() : null,
        stageReached: stageMatch ? stageMatch[1].trim() : null,
        feedback: feedbackLines || null,
      });
    }
  }
  return results;
}

/**
 * Read the tracker and its linked reports, returning parsed reports in the
 * shape upskill.aggregateGaps expects ({num, score, gapText}).
 *
 * @param {string} appsFile
 * @param {string} reportsDir - reports/ directory (fallback for root-relative links)
 * @returns {Array<{num: string, score: number|null, gapText: string}>}
 */
export function readReports(appsFile = DEFAULT_APPS, reportsDir = DEFAULT_REPORTS) {
  const apps = readIfExists(appsFile);
  if (!apps) return [];
  const parsed = [];
  for (const line of apps.split('\n')) {
    if (!/^\|/.test(line.trim())) continue;
    const cols = line.trim().replace(/^\|/, '').split('|').map((s) => s.trim());
    if (cols.length < 9) continue;
    const num = cols[0];
    const reportCell = cols[7] || '';
    const linkMatch = reportCell.match(/\]\(([^)]+)\)/);
    if (!linkMatch) continue;
    const candidates = new Set([
      join(dirname(appsFile), linkMatch[1]),
      join(ROOT, linkMatch[1]),
      join(reportsDir, linkMatch[1]),
    ]);
    let content = null;
    for (const p of candidates) {
      const c = readIfExists(p);
      if (c !== null) {
        content = c;
        break;
      }
    }
    if (content === null) continue;
    const parsedReport = parseReportGaps(content);
    parsed.push({ num, ...parsedReport });
  }
  return parsed;
}

/**
 * Data-gated recommendations. Each entry only fires when the underlying
 * non-null signal exists; nothing is ever invented.
 *
 * @param {object} feedback - output of aggregateFeedback
 * @returns {string[]}
 */
export function deriveRecommendations(feedback) {
  const recs = [];
  const { funnel, calibration, waiting, skillGaps, outcomeFeedback } = feedback;
  if (!funnel && !skillGaps && !outcomeFeedback.length) {
    recs.push('Tracker is empty — no learning signals yet.');
    return recs;
  }
  if (funnel) {
    if (funnel.interviewRate !== null && funnel.interviewRate < funnel.responseRate && funnel.responseRate > 0) {
      recs.push('Funnel shows applications advancing to interview less often than responses arrive — review targeting before applying further.');
    } else if (funnel.everApplied > 0 && funnel.offerRate === 0 && !funnel.smallSample) {
      recs.push('Funnel shows zero offers from a full pipeline — reassess scoring thresholds before the next batch.');
    }
  }
  if (calibration) {
    if (calibration.responseRate?.band === 'below-range' || calibration.interviewRate?.band === 'below-range') {
      recs.push('Calibration sits below the typical market band — directional only, selection bias possible.');
    } else if (calibration.responseRate?.band === 'above-range' || calibration.interviewRate?.band === 'above-range') {
      recs.push('Calibration sits above the typical market band — directional only, selection bias possible.');
    }
  }
  if (waiting && (waiting.waitingCount || waiting.coldCount)) {
    recs.push(`Follow-up candidates in the pipeline: ${waiting.waitingCount ?? 0} waiting, ${waiting.coldCount ?? 0} cold.`);
  }
  if (skillGaps && skillGaps.gaps.length) {
    const top = skillGaps.gaps.slice(0, 3).map((g) => g.skill).join(', ');
    recs.push(`Top skill gaps by weighted score: ${top}.`);
  }
  if (outcomeFeedback.length) {
    const positive = outcomeFeedback.filter((o) => /positive|offer|hired/i.test(o.outcomeType ?? '')).length;
    const negative = outcomeFeedback.filter((o) => /negative|reject/i.test(o.outcomeType ?? '')).length;
    recs.push(`Outcome feedback logged: ${positive} positive, ${negative} negative — verbatim feedback is in the artifact.`);
  }
  return recs;
}

/**
 * Aggregate all analytics into one schema-versioned feedback object. Pure and
 * unit-testable: every input is content or already-parsed data.
 *
 * @param {object} inputs
 * @param {string} inputs.trackerContent - data/applications.md content (may be '')
 * @param {string} inputs.logContent - data/status-log.tsv content (may be '')
 * @param {string} inputs.followupsContent - data/follow-ups.md content (may be '')
 * @param {string} inputs.statesContent - templates/states.yml content
 * @param {object} inputs.benchmarks - parsed benchmarks object from loadBenchmarks
 * @param {Array} inputs.reports - parsed reports [{num, score, gapText}] (see readReports)
 * @param {Array} inputs.outcomeLogs - outcome feedback entries (see readOutcomeFeedback)
 * @param {Set<string>} inputs.knownSkills - canonical known skills from cv/profile
 * @param {string} inputs.todayStr - YYYY-MM-DD
 * @returns {object} schema-versioned feedback object
 */
export function aggregateFeedback({
  trackerContent = '',
  logContent = '',
  followupsContent = '',
  statesContent = '',
  benchmarks = null,
  reports = [],
  outcomeLogs = [],
  knownSkills = new Set(),
  todayStr = today(),
} = {}) {
  const hasTracker = Boolean(trackerContent && trackerContent.trim());
  let funnel = null;
  let velocity = null;
  let calibration = null;
  let waiting = null;
  let followups = null;

  if (hasTracker) {
    const stats = computeTrackerStats(trackerContent);
    funnel = computeFunnel(stats.byStatus);
    followups = followupsContent
      ? computeFollowupStats(followupsContent, trackerStatusByNum(trackerContent))
      : null;
    try {
      const funnelResult = analyzeFunnel({
        trackerContent,
        logContent,
        benchmarks: benchmarks ?? {},
        states: statesContent,
        todayStr,
      });
      velocity = funnelResult.velocity;
      calibration = funnelResult.calibration;
      waiting = funnelResult.waiting;
    } catch {
      // Malformed status log — keep funnel, drop velocity/calibration/waiting.
    }
  }

  let skillGaps = null;
  if (reports.length) {
    skillGaps = aggregateGaps(reports, knownSkills);
  }

  const feedback = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: todayStr,
    sources: {
      tracker: hasTracker,
      statusLog: Boolean(logContent && logContent.trim()),
      outcomes: outcomeLogs.length,
      reports: reports.length,
    },
    funnel,
    velocity,
    calibration,
    waiting,
    followups,
    skillGaps,
    outcomeFeedback: outcomeLogs,
    patterns: null,
    recommendations: [],
  };
  feedback.recommendations = deriveRecommendations(feedback);
  return feedback;
}

/** Human-readable summary. Never claims more than the data supports. */
export function renderSummary(feedback) {
  const out = [];
  const line = '━'.repeat(52);
  out.push(`\n${line}`);
  out.push(`Learning Loop — ${feedback.generatedAt}`);
  out.push(line);
  out.push(`Sources: tracker ${feedback.sources.tracker ? '✓' : '✗'} | status-log ${feedback.sources.statusLog ? '✓' : '✗'} | outcomes ${feedback.sources.outcomes} | reports ${feedback.sources.reports}`);
  if (!feedback.sources.tracker && !feedback.outcomeFeedback.length && !feedback.skillGaps) {
    out.push('No data yet — run evaluations, track applications, and log outcomes to close the loop.');
    out.push(`${line}\n`);
    return out.join('\n');
  }
  const f = feedback.funnel;
  if (f) {
    out.push(`Funnel: ${f.everApplied} applied | ${f.everInterview} interview | ${f.everOffer} offer | response ${f.responseRate}% | interview ${f.interviewRate}% | offer ${f.offerRate}%${f.smallSample ? ' (small sample)' : ''}`);
  }
  const v = feedback.velocity;
  if (v && v.interviewToOffer && v.interviewToOffer.median !== null) {
    out.push(`Velocity: interview→offer median ${v.interviewToOffer.median} days (p75 ${v.interviewToOffer.p75 ?? 'n/a'})`);
  }
  const c = feedback.calibration;
  if (c) {
    const fmt = (label, x) => (x && x.ownPct !== null ? `${label} ${x.ownPct}% (${x.band})` : null);
    const parts = [fmt('Response', c.responseRate), fmt('Interview', c.interviewRate), fmt('Offer', c.offerRate)].filter(Boolean);
    if (parts.length) out.push(`Calibration: ${parts.join(' | ')}`);
  }
  const w = feedback.waiting;
  if (w && (w.waitingCount || w.coldCount)) {
    out.push(`Waiting: ${w.waitingCount ?? 0} | Cold: ${w.coldCount ?? 0}`);
  }
  if (feedback.skillGaps && feedback.skillGaps.gaps.length) {
    const top = feedback.skillGaps.gaps.slice(0, 3).map((g) => `  - ${g.skill} (w${g.weightedScore}, n${g.reports})`).join('\n');
    out.push(`Top skill gaps:\n${top}`);
  }
  if (feedback.outcomeFeedback.length) {
    out.push(`Outcome feedback: ${feedback.outcomeFeedback.length} entries (verbatim in data/learning-feedback.json)`);
  }
  if (feedback.patterns && !feedback.patterns.error) {
    out.push(`Patterns lens: ${feedback.patterns.metadata?.total ?? 'n/a'} applications analyzed.`);
  }
  if (feedback.recommendations.length) {
    out.push('Recommendations:');
    for (const r of feedback.recommendations) out.push(`  - ${r}`);
  }
  out.push(`${line}\n`);
  return out.join('\n');
}

/** Run analyze-patterns.mjs --json as a child process (no imports — see header). */
function runPatternsLens(trackerContent) {
  if (!trackerContent || !trackerContent.trim()) return null;
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'analyze-patterns.mjs'), '--json'], {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return JSON.parse(out);
  } catch (err) {
    const out = err.stdout?.toString?.() ?? '';
    try {
      return JSON.parse(out);
    } catch {
      return { error: 'analyze-patterns lens failed to run' };
    }
  }
}

/** Built-in self-test (mirrors upskill/funnel-velocity conventions). */
function runSelfTest() {
  const tmpOutcomes = join(ROOT, 'data', 'outcomes');
  const outcomeLogs = readOutcomeFeedback(tmpOutcomes);

  // Empty branch: must not throw and must report empty.
  const empty = aggregateFeedback({
    trackerContent: '',
    statesContent: '',
    todayStr: '2026-08-14',
  });
  const checks = [];
  checks.push(['empty tracker yields funnel null', empty.funnel === null]);
  checks.push(['empty tracker yields velocity null', empty.velocity === null]);
  checks.push(['empty tracker yields calibration null', empty.calibration === null]);
  checks.push(['empty tracker yields waiting null', empty.waiting === null]);
  checks.push(['empty tracker yields empty recommendations', empty.recommendations.length === 1 && /empty/i.test(empty.recommendations[0])]);
  checks.push(['empty tracker has schema version', empty.schemaVersion === SCHEMA_VERSION]);

  // Populated branch with fixtures (no disk dependence).
  const tracker = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-06-01 | Acme | Senior Dev | 4.0/5 | Applied | ✅ | [1](reports/001-acme-2026-06-01.md) | |',
    '| 2 | 2026-06-05 | Beta | Dev | 4.5/5 | Interview | ✅ | [2](reports/002-beta-2026-06-05.md) | |',
    '| 3 | 2026-06-10 | Gamma | Lead | 4.2/5 | Offer | ✅ | [3](reports/003-gamma-2026-06-10.md) | |',
  ].join('\n');
  const states = readIfExists(DEFAULT_STATES) ?? '';
  const benchmark = loadBenchmarks().benchmarks;
  const full = aggregateFeedback({
    trackerContent: tracker,
    statesContent: states,
    benchmarks: benchmark,
    todayStr: '2026-08-14',
  });
  checks.push(['populated tracker yields funnel', full.funnel !== null && full.funnel.everApplied === 3]);
  checks.push(['populated tracker yields velocity', full.velocity !== null]);
  checks.push(['populated tracker yields calibration', full.calibration !== null]);
  checks.push(['populated tracker yields waiting', full.waiting !== null]);
  checks.push(['sources.tracker true on populated', full.sources.tracker === true]);

  let failures = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
    if (!ok) failures++;
  }
  console.log(`learning-loop self-test: ${checks.length - failures} passed, ${failures} failed`);
  return failures ? 1 : 0;
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    process.exitCode = runSelfTest();
    return;
  }
  const jsonMode = args.includes('--json');
  const benchIdx = args.indexOf('--benchmarks');
  const benchPath = benchIdx !== -1 && args[benchIdx + 1] !== undefined ? args[benchIdx + 1] : undefined;

  const trackerContent = readIfExists(DEFAULT_APPS) ?? '';
  const logContent = readIfExists(DEFAULT_STATUS_LOG) ?? '';
  const followupsContent = readIfExists(DEFAULT_FOLLOWUPS) ?? '';
  const statesContent = readIfExists(DEFAULT_STATES) ?? '';
  const benchmark = loadBenchmarks(benchPath).benchmarks;
  const reports = readReports(DEFAULT_APPS, DEFAULT_REPORTS);
  const outcomeLogs = readOutcomeFeedback(DEFAULT_OUTCOMES);
  const knownText = [readIfExists(CV_FILE) ?? '', readIfExists(PROFILE_FILE) ?? ''].join('\n');
  const knownSkills = extractSkills(knownText);

  const feedback = aggregateFeedback({
    trackerContent,
    logContent,
    followupsContent,
    statesContent,
    benchmarks: benchmark,
    reports,
    outcomeLogs,
    knownSkills,
  });
  feedback.patterns = runPatternsLens(trackerContent);

  try {
    writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2) + '\n');
  } catch (err) {
    console.error(`learning-loop: could not write ${FEEDBACK_FILE}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(feedback, null, 2) + '\n');
  } else {
    process.stdout.write(renderSummary(feedback));
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli();
}