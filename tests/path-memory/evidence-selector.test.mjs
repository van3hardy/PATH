import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectEvidence } from '../../path-memory/evidence-selector.mjs';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/path-recruiter/approved-profile.md', import.meta.url));
const FIXTURE_TEXT = fs.readFileSync(FIXTURE_PATH, 'utf8');
const APPROVED_SENTENCE = 'Van builds agent workflows on Windows 11 with PowerShell.';
const NOW = new Date('2026-07-29T12:00:00Z');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeSandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'path-recruiter-evidence-'));
  const rootDir = path.join(base, 'root');
  fs.mkdirSync(rootDir);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, rootDir };
}

function writeSource(rootDir, relativePath, text = FIXTURE_TEXT) {
  const sourcePath = path.join(rootDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, text, 'utf8');
  return sourcePath;
}

function validRef(overrides = {}) {
  return {
    id: 'fact-agent-workflows',
    factKey: 'capability.agent-workflows',
    source: 'cv.md',
    sourceType: 'USER_LAYER_FACT',
    expectedSourceSha256: sha256(FIXTURE_TEXT),
    quote: APPROVED_SENTENCE,
    authority: 'OWNER_APPROVED_FACT',
    approvedBy: 'Van',
    approvedAt: '2026-07-29T11:00:00Z',
    factRecordedAt: '2026-07-29T10:00:00Z',
    freshness: { mode: 'STATIC' },
    supersedesFactIds: [],
    ...overrides
  };
}

function select(rootDir, evidenceRefs) {
  return selectEvidence({
    rootDir,
    evidenceRefs,
    now: () => new Date(NOW)
  });
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function createSymlinkOrSkip(t, target, link, type = 'file') {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      t.skip(`symlink fixture unavailable: ${error.message}`);
      return false;
    }
    throw error;
  }
}

test('selected evidence returns one exact approved atomic quote and no unselected content', (t) => {
  const { rootDir } = makeSandbox(t);
  const sourcePath = writeSource(rootDir, 'cv.md');
  const expectedSourceSha256 = sha256(FIXTURE_TEXT);
  const selected = selectEvidence({
    rootDir,
    evidenceRefs: [{
      id: 'fact-agent-workflows',
      factKey: 'capability.agent-workflows',
      source: 'cv.md',
      sourceType: 'USER_LAYER_FACT',
      expectedSourceSha256,
      quote: APPROVED_SENTENCE,
      authority: 'OWNER_APPROVED_FACT',
      approvedBy: 'Van',
      approvedAt: '2026-07-29T11:00:00Z',
      factRecordedAt: '2026-07-29T10:00:00Z',
      freshness: { mode: 'STATIC' },
      supersedesFactIds: []
    }],
    now: () => new Date('2026-07-29T12:00:00Z')
  });
  assert.equal(selected.items[0].quote, APPROVED_SENTENCE);
  assert.match(selected.items[0].sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(selected).sort(), [
    'inspectedAt', 'items', 'schemaVersion', 'supersededEvidenceIds'
  ]);
  assert.deepEqual(Object.keys(selected.items[0]).sort(), [
    'approvedAt', 'approvedBy', 'authority', 'factKey', 'factRecordedAt',
    'freshness', 'id', 'quote', 'source', 'sourceModifiedAt', 'sourceSha256'
  ]);
  assert.equal(selected.schemaVersion, 'path.evidence-selection.v1');
  assert.equal(selected.inspectedAt, '2026-07-29T12:00:00.000Z');
  assert.equal(selected.items[0].source, 'cv.md');
  assert.equal(selected.items[0].sourceSha256, expectedSourceSha256);
  assert.equal(selected.items[0].sourceModifiedAt, fs.statSync(sourcePath).mtime.toISOString());
  assert.deepEqual(selected.supersededEvidenceIds, []);
  assert.doesNotMatch(JSON.stringify(selected), /Synthetic Path Test Profile/);
});

test('source hash binds the exact approved file bytes', (t) => {
  const { rootDir } = makeSandbox(t);
  const sourcePath = path.join(rootDir, 'cv.md');
  const sourceBytes = Buffer.concat([
    Buffer.from(FIXTURE_TEXT, 'utf8'),
    Buffer.from([0x80])
  ]);
  fs.writeFileSync(sourcePath, sourceBytes);
  const expectedSourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');

  const selected = select(rootDir, [validRef({ expectedSourceSha256 })]);

  assert.equal(selected.items[0].sourceSha256, expectedSourceSha256);
});

const allowedPaths = [
  'cv.md',
  'article-digest.md',
  'config/profile.yml',
  'modes/_profile.md',
  'interview-prep/story-bank.md',
  'interview-prep/synthetic-company-synthetic-role.md'
];

for (const allowedPath of allowedPaths) {
  test(`factual allowlist accepts ${allowedPath}`, (t) => {
    const { rootDir } = makeSandbox(t);
    writeSource(rootDir, allowedPath);
    const selected = select(rootDir, [validRef({ source: allowedPath })]);
    assert.equal(selected.items[0].source, allowedPath);
  });
}

test('requested Windows separators normalize to the approved relative path', (t) => {
  const { rootDir } = makeSandbox(t);
  writeSource(rootDir, 'interview-prep/synthetic-note.md');
  const selected = select(rootDir, [validRef({ source: 'interview-prep\\synthetic-note.md' })]);
  assert.equal(selected.items[0].source, 'interview-prep/synthetic-note.md');
});

const rejectedPaths = [
  ['parent traversal', '../outside.md'],
  ['Windows parent traversal', '..\\outside.md'],
  ['absolute path', path.resolve('absolute.md')],
  ['empty path', ''],
  ['NUL path', 'cv.md\0'],
  ['system-layer shared mode', 'modes/_shared.md'],
  ['style-only writing sample', 'writing-samples/sample.md'],
  ['interview session', 'interview-prep/sessions/session.md'],
  ['nested interview note', 'interview-prep/company/role.md'],
  ['unlisted root file', 'voice-dna.md']
];

for (const [name, source] of rejectedPaths) {
  test(`bounded evidence rejects ${name}`, (t) => {
    const { base, rootDir } = makeSandbox(t);
    fs.writeFileSync(path.join(base, 'outside.md'), FIXTURE_TEXT, 'utf8');
    if (source && !source.includes('\0') && !path.isAbsolute(source) && !source.includes('..')) {
      writeSource(rootDir, source.replaceAll('\\', '/'));
    }
    assertCode(() => select(rootDir, [validRef({ source })]), 'BLOCKED_UNAPPROVED_SOURCE');
  });
}

test('bounded evidence rejects a missing approved source', (t) => {
  const { rootDir } = makeSandbox(t);
  assertCode(() => select(rootDir, [validRef()]), 'BLOCKED_SOURCE_UNAVAILABLE');
});

test('bounded evidence rejects a quote absent from its approved source', (t) => {
  const { rootDir } = makeSandbox(t);
  writeSource(rootDir, 'cv.md');
  assertCode(
    () => select(rootDir, [validRef({ quote: 'This exact sentence is absent.' })]),
    'BLOCKED_QUOTE_NOT_FOUND'
  );
});

test('bounded evidence rejects a quote containing two atomic claim units', (t) => {
  const { rootDir } = makeSandbox(t);
  const quote = 'First approved fact. Second approved fact.';
  const text = `# Synthetic\n\n${quote}\n`;
  writeSource(rootDir, 'cv.md', text);
  assertCode(
    () => select(rootDir, [validRef({ quote, expectedSourceSha256: sha256(text) })]),
    'BLOCKED_NON_ATOMIC_EVIDENCE'
  );
});

test('bounded evidence rejects a current fact whose validity ended before now', (t) => {
  const { rootDir } = makeSandbox(t);
  writeSource(rootDir, 'cv.md');
  assertCode(
    () => select(rootDir, [validRef({
      freshness: { mode: 'CURRENT', validUntil: '2026-07-29T11:59:59Z' }
    })]),
    'BLOCKED_STALE_EVIDENCE'
  );
});

test('bounded evidence accepts a current fact valid at now', (t) => {
  const { rootDir } = makeSandbox(t);
  writeSource(rootDir, 'cv.md');
  const selected = select(rootDir, [validRef({
    freshness: { mode: 'CURRENT', validUntil: '2026-07-29T12:00:00Z' }
  })]);
  assert.equal(selected.items[0].freshness.validUntil, '2026-07-29T12:00:00.000Z');
});

test('bounded evidence rejects a source changed after approval', (t) => {
  const { rootDir } = makeSandbox(t);
  writeSource(rootDir, 'cv.md');
  assertCode(
    () => select(rootDir, [validRef({ expectedSourceSha256: '0'.repeat(64) })]),
    'BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL'
  );
});

test('bounded evidence rejects a source changed during its single read', (t) => {
  const { rootDir } = makeSandbox(t);
  const sourcePath = writeSource(rootDir, 'cv.md');
  const changedText = `${FIXTURE_TEXT}Changed during selection.\n`;
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readThenChange(target, ...args) {
    const text = originalReadFileSync.call(fs, target, ...args);
    const targetPath = typeof target === 'number' ? sourcePath : String(target);
    if (path.resolve(targetPath) === path.resolve(sourcePath)) {
      fs.writeFileSync(sourcePath, changedText, 'utf8');
    }
    return text;
  };
  t.after(() => { fs.readFileSync = originalReadFileSync; });

  assertCode(
    () => select(rootDir, [validRef()]),
    'BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL'
  );
});

test('bounded evidence rejects a same-source cache changed before a second reference', (t) => {
  const { rootDir } = makeSandbox(t);
  const firstQuote = 'First synthetic approved fact.';
  const secondQuote = 'Second synthetic approved fact.';
  const approvedText = `${firstQuote}\n${secondQuote}\n`;
  const sourcePath = writeSource(rootDir, 'cv.md', approvedText);
  const common = { source: 'cv.md', expectedSourceSha256: sha256(approvedText) };
  const second = validRef({
    ...common,
    factKey: 'synthetic.second',
    quote: secondQuote
  });
  let changed = false;
  Object.defineProperty(second, 'id', {
    enumerable: true,
    get() {
      if (!changed) {
        fs.writeFileSync(sourcePath, `${approvedText}Changed before cache reuse.\n`, 'utf8');
        changed = true;
      }
      return 'fact-second';
    }
  });

  assertCode(() => select(rootDir, [
    validRef({ ...common, id: 'fact-first', factKey: 'synthetic.first', quote: firstQuote }),
    second
  ]), 'BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL');
  assert.equal(changed, true);
});

test('bounded evidence rejects a parent directory replaced by a junction during selection', (t) => {
  const { base, rootDir } = makeSandbox(t);
  const sourcePath = writeSource(rootDir, 'interview-prep/synthetic.md');
  const originalDirectory = path.dirname(sourcePath);
  const movedDirectory = path.join(rootDir, 'original-interview-prep');
  const outsideDirectory = path.join(base, 'outside-interview-prep');
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(path.join(outsideDirectory, 'synthetic.md'), FIXTURE_TEXT, 'utf8');

  const originalOpenSync = fs.openSync;
  let junctionInserted = false;
  fs.openSync = function swapParentThenOpen(target, ...args) {
    if (!junctionInserted && path.resolve(String(target)) === path.resolve(sourcePath)) {
      fs.renameSync(originalDirectory, movedDirectory);
      const type = process.platform === 'win32' ? 'junction' : 'dir';
      if (!createSymlinkOrSkip(t, outsideDirectory, originalDirectory, type)) {
        return originalOpenSync.call(fs, path.join(movedDirectory, 'synthetic.md'), ...args);
      }
      junctionInserted = true;
    }
    return originalOpenSync.call(fs, target, ...args);
  };
  t.after(() => { fs.openSync = originalOpenSync; });

  assertCode(
    () => select(rootDir, [validRef({ source: 'interview-prep/synthetic.md' })]),
    'BLOCKED_SYMLINK_SOURCE'
  );
  assert.equal(junctionInserted, true);
});

const invalidMetadataCases = [
  ['future factual time', { factRecordedAt: '2026-07-29T12:00:01Z' }],
  ['future approval time', { approvedAt: '2026-07-29T12:00:01Z' }],
  ['approval before factual time', {
    factRecordedAt: '2026-07-29T10:00:00Z', approvedAt: '2026-07-29T09:59:59Z'
  }],
  ['approver other than Van', { approvedBy: 'Someone Else' }],
  ['unapproved authority', { authority: 'MODEL_INFERRED' }],
  ['unapproved source type', { sourceType: 'STYLE_ONLY' }],
  ['invalid factual time', { factRecordedAt: 'not-a-date' }],
  ['impossible factual date', { factRecordedAt: '2026-02-30T10:00:00Z' }],
  ['invalid approval time', { approvedAt: 'not-a-date' }],
  ['invalid fact key', { factKey: '' }],
  ['invalid fact id', { id: '' }],
  ['invalid hash metadata', { expectedSourceSha256: 'abc' }],
  ['invalid freshness mode', { freshness: { mode: 'FOREVER' } }],
  ['missing current valid-until', { freshness: { mode: 'CURRENT' } }],
  ['invalid current valid-until', { freshness: { mode: 'CURRENT', validUntil: 'later' } }],
  ['static freshness with a validity field', {
    freshness: { mode: 'STATIC', validUntil: '2026-07-30T12:00:00Z' }
  }],
  ['non-array supersession metadata', { supersedesFactIds: 'fact-old' }]
];

for (const [name, overrides] of invalidMetadataCases) {
  test(`bounded evidence rejects ${name}`, (t) => {
    const { rootDir } = makeSandbox(t);
    writeSource(rootDir, 'cv.md');
    assertCode(
      () => select(rootDir, [validRef(overrides)]),
      'BLOCKED_INVALID_EVIDENCE'
    );
  });
}

test('different values for one fact key remain unresolved without supersession', (t) => {
  const { rootDir } = makeSandbox(t);
  const oldQuote = 'Van uses one synthetic workflow.';
  const newQuote = 'Van uses two synthetic workflows.';
  const text = `${oldQuote}\n${newQuote}\n`;
  writeSource(rootDir, 'cv.md', text);
  const common = { expectedSourceSha256: sha256(text), factKey: 'workflow.count' };
  assertCode(() => select(rootDir, [
    validRef({ ...common, id: 'fact-old', quote: oldQuote, approvedAt: '2026-07-29T10:30:00Z' }),
    validRef({ ...common, id: 'fact-new', quote: newQuote, approvedAt: '2026-07-29T11:00:00Z' })
  ]), 'UNRESOLVED_CONFLICTING_EVIDENCE');
});

test('later-approved fact superseding every conflicting older ID is selected alone', (t) => {
  const { rootDir } = makeSandbox(t);
  const oldestQuote = 'Van uses one synthetic workflow.';
  const olderQuote = 'Van uses two synthetic workflows.';
  const newestQuote = 'Van uses three synthetic workflows.';
  const text = `${oldestQuote}\n${olderQuote}\n${newestQuote}\n`;
  writeSource(rootDir, 'cv.md', text);
  const common = { expectedSourceSha256: sha256(text), factKey: 'workflow.count' };
  const selected = select(rootDir, [
    validRef({ ...common, id: 'fact-oldest', quote: oldestQuote, approvedAt: '2026-07-29T10:20:00Z' }),
    validRef({ ...common, id: 'fact-older', quote: olderQuote, approvedAt: '2026-07-29T10:40:00Z' }),
    validRef({
      ...common,
      id: 'fact-newest',
      quote: newestQuote,
      approvedAt: '2026-07-29T11:00:00Z',
      supersedesFactIds: ['fact-oldest', 'fact-older']
    })
  ]);
  assert.deepEqual(selected.items.map((item) => item.id), ['fact-newest']);
  assert.deepEqual(selected.supersededEvidenceIds, ['fact-oldest', 'fact-older']);
});

test('superseding fact must name every older conflicting fact ID', (t) => {
  const { rootDir } = makeSandbox(t);
  const quotes = ['One synthetic value.', 'Two synthetic values.', 'Three synthetic values.'];
  const text = `${quotes.join('\n')}\n`;
  writeSource(rootDir, 'cv.md', text);
  const common = { expectedSourceSha256: sha256(text), factKey: 'synthetic.value' };
  assertCode(() => select(rootDir, [
    validRef({ ...common, id: 'fact-one', quote: quotes[0], approvedAt: '2026-07-29T10:20:00Z' }),
    validRef({ ...common, id: 'fact-two', quote: quotes[1], approvedAt: '2026-07-29T10:40:00Z' }),
    validRef({
      ...common,
      id: 'fact-three',
      quote: quotes[2],
      approvedAt: '2026-07-29T11:00:00Z',
      supersedesFactIds: ['fact-one']
    })
  ]), 'UNRESOLVED_CONFLICTING_EVIDENCE');
});

test('superseding fact must be approved later than every older conflict', (t) => {
  const { rootDir } = makeSandbox(t);
  const oldQuote = 'One synthetic value.';
  const newQuote = 'Two synthetic values.';
  const text = `${oldQuote}\n${newQuote}\n`;
  writeSource(rootDir, 'cv.md', text);
  const common = { expectedSourceSha256: sha256(text), factKey: 'synthetic.value' };
  assertCode(() => select(rootDir, [
    validRef({ ...common, id: 'fact-old', quote: oldQuote, approvedAt: '2026-07-29T11:00:00Z' }),
    validRef({
      ...common,
      id: 'fact-new',
      quote: newQuote,
      approvedAt: '2026-07-29T10:40:00Z',
      supersedesFactIds: ['fact-old']
    })
  ]), 'UNRESOLVED_CONFLICTING_EVIDENCE');
});

test('approved filename symlinked to an in-root system file is rejected', (t) => {
  const { rootDir } = makeSandbox(t);
  const target = writeSource(rootDir, 'modes/_shared.md');
  const link = path.join(rootDir, 'cv.md');
  if (!createSymlinkOrSkip(t, target, link, 'file')) return;
  assertCode(() => select(rootDir, [validRef()]), 'BLOCKED_SYMLINK_SOURCE');
});

test('approved filename symlinked outside the root is rejected', (t) => {
  const { base, rootDir } = makeSandbox(t);
  const target = path.join(base, 'outside.md');
  fs.writeFileSync(target, FIXTURE_TEXT, 'utf8');
  const link = path.join(rootDir, 'cv.md');
  if (!createSymlinkOrSkip(t, target, link, 'file')) return;
  assertCode(() => select(rootDir, [validRef()]), 'BLOCKED_SYMLINK_SOURCE');
});

test('symlinked directory segment is rejected before source realpath', (t) => {
  const { rootDir } = makeSandbox(t);
  const actual = path.join(rootDir, 'actual-interview-notes');
  fs.mkdirSync(actual);
  fs.writeFileSync(path.join(actual, 'synthetic.md'), FIXTURE_TEXT, 'utf8');
  const link = path.join(rootDir, 'interview-prep');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  if (!createSymlinkOrSkip(t, actual, link, type)) return;
  assertCode(
    () => select(rootDir, [validRef({ source: 'interview-prep/synthetic.md' })]),
    'BLOCKED_SYMLINK_SOURCE'
  );
});
