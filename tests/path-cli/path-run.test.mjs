import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = fs.realpathSync(path.resolve(testDir, '../..'));
const sourceScript = path.join(sourceRoot, 'scripts', 'path-run.mjs');
const fixtureRequest = path.join(
  sourceRoot,
  'tests',
  'fixtures',
  'path-recruiter',
  'request.json'
);
const fixtureProfile = path.join(
  sourceRoot,
  'tests',
  'fixtures',
  'path-recruiter',
  'approved-profile.md'
);
const usage = [
  'Usage: node scripts/path-run.mjs <request.json> --local-only',
  'MVP-1 writes a local review packet and never sends or submits.',
  ''
].join('\n');
const moduleDirectories = [
  'path-brain',
  'path-memory',
  'path-runner',
  'path-safety',
  'path-workflows'
];

function makeSyntheticPathRoot(t, { missingIdentity = null } = {}) {
  const prefix = path.join(os.tmpdir(), 'path-cli-');
  const rootDir = fs.mkdtempSync(prefix);
  t.after(() => {
    assert.equal(path.dirname(rootDir), path.dirname(prefix));
    assert.match(path.basename(rootDir), /^path-cli-/);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  for (const directory of moduleDirectories) {
    if (missingIdentity === directory) continue;
    fs.cpSync(path.join(sourceRoot, directory), path.join(rootDir, directory), {
      recursive: true
    });
  }

  fs.mkdirSync(path.join(rootDir, 'scripts'), { recursive: true });
  if (fs.existsSync(sourceScript)) {
    fs.copyFileSync(sourceScript, path.join(rootDir, 'scripts', 'path-run.mjs'));
  }

  if (missingIdentity !== 'package.json') {
    fs.writeFileSync(
      path.join(rootDir, 'package.json'),
      `${JSON.stringify({ name: 'path' }, null, 2)}\n`,
      'utf8'
    );
  }
  if (missingIdentity !== 'docs/path/repo-sources.md') {
    fs.mkdirSync(path.join(rootDir, 'docs', 'path'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'docs', 'path', 'repo-sources.md'),
      '# Synthetic Path source boundary\n',
      'utf8'
    );
  }
  fs.copyFileSync(fixtureProfile, path.join(rootDir, 'cv.md'));
  fs.copyFileSync(fixtureRequest, path.join(rootDir, 'request.json'));
  return rootDir;
}

function runCli(rootDir, args, { cwd = rootDir } = {}) {
  return spawnSync(
    process.execPath,
    [path.join(rootDir, 'scripts', 'path-run.mjs'), ...args],
    { cwd, encoding: 'utf8' }
  );
}

function writeRequest(rootDir, mutate, name = 'request-mutated.json') {
  const request = JSON.parse(fs.readFileSync(fixtureRequest, 'utf8'));
  mutate(request);
  const target = path.join(rootDir, name);
  fs.writeFileSync(target, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  return target;
}

function assertNoRunWrite(rootDir) {
  assert.equal(fs.existsSync(path.join(rootDir, 'data')), false);
}

function replaceIdentityWithSymlink(rootDir, relativePath, type) {
  const target = path.join(rootDir, ...relativePath.split('/'));
  const backing = `${target}.symlink-target`;
  fs.renameSync(target, backing);
  try {
    fs.symlinkSync(backing, target, type);
  } catch (error) {
    fs.renameSync(backing, target);
    throw error;
  }
}

function installImportIdentityReplacementWrapper(rootDir) {
  const providerPath = path.join(rootDir, 'path-brain', 'fake-provider.mjs');
  const originalPath = path.join(rootDir, 'path-brain', 'fake-provider-original.mjs');
  fs.copyFileSync(providerPath, originalPath);
  fs.writeFileSync(providerPath, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
    "const packagePath = path.join(rootDir, 'package.json');",
    "const replacementPath = path.join(rootDir, 'package.identity-replacement.json');",
    'fs.writeFileSync(replacementPath, fs.readFileSync(packagePath));',
    'fs.unlinkSync(packagePath);',
    'fs.renameSync(replacementPath, packagePath);',
    "const original = await import('./fake-provider-original.mjs');",
    'export const fakeProvider = original.fakeProvider;',
    ''
  ].join('\n'), 'utf8');
}

function allRelativeFiles(rootDir) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push(path.relative(rootDir, absolute).split(path.sep).join('/'));
    }
  }
  walk(rootDir);
  return files.sort();
}

test('valid local-only request returns one bounded review-ready JSON result', (t) => {
  const rootDir = makeSyntheticPathRoot(t);
  const result = runCli(rootDir, ['request.json', '--local-only']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output).sort(), [
    'decision',
    'packetId',
    'resultCode',
    'runId',
    'status'
  ]);
  assert.equal(output.resultCode, 'LOCAL_REVIEW_READY');
  assert.equal(output.status, 'HUMAN_REVIEW');
  assert.equal(output.runId, 'run-cli-fixture-001');
  assert.equal(result.stdout.trim(), JSON.stringify(output, null, 2));
});

test('every invalid argument shape prints exact usage, exits 2, and performs no run write', (t) => {
  const cases = [
    [],
    ['request.json'],
    ['--local-only', 'request.json'],
    ['request.json', '--wrong'],
    ['request.json', '--local-only', 'extra'],
    ['--local-only', '--local-only']
  ];

  for (const args of cases) {
    const rootDir = makeSyntheticPathRoot(t);
    const result = runCli(rootDir, args);
    assert.equal(result.status, 2, JSON.stringify({ args, stderr: result.stderr }));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, usage);
    assertNoRunWrite(rootDir);
  }
});

test('unsupported provider exits 2 before workflow writes', (t) => {
  const rootDir = makeSyntheticPathRoot(t);
  const requestPath = writeRequest(rootDir, (request) => {
    request.provider = 'remote';
  });
  const result = runCli(rootDir, [requestPath, '--local-only']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'BLOCKED_UNSUPPORTED_PROVIDER\n');
  assertNoRunWrite(rootDir);
});

test('malformed JSON exits 2 without echoing raw input or writing a run', (t) => {
  const rootDir = makeSyntheticPathRoot(t);
  const malformed = path.join(rootDir, 'malformed.json');
  const secretMarker = 'RAW_MALFORMED_INPUT_MUST_NOT_ECHO';
  fs.writeFileSync(malformed, `{"provider":"fake","secret":"${secretMarker}"`, 'utf8');
  const result = runCli(rootDir, [malformed, '--local-only']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'BLOCKED_INVALID_REQUEST_JSON\n');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretMarker));
  assertNoRunWrite(rootDir);
});

test('missing request path has bounded stderr, exit 2, and no data write', (t) => {
  const rootDir = makeSyntheticPathRoot(t);
  const result = runCli(rootDir, ['missing-request.json', '--local-only']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'BLOCKED_REQUEST_UNREADABLE\n');
  assertNoRunWrite(rootDir);
});

test('no-model request exits 1 with the stable workflow block', (t) => {
  const rootDir = makeSyntheticPathRoot(t);
  const requestPath = writeRequest(rootDir, (request) => {
    request.provider = 'none';
  });
  const result = runCli(rootDir, [requestPath, '--local-only']);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'BLOCKED',
    resultCode: 'BLOCKED_NO_MODEL_CONFIGURED',
    decision: null,
    packetId: null,
    runId: 'run-cli-fixture-001'
  });
  assert.equal(fs.existsSync(path.join(rootDir, 'data', 'path-outbox.jsonl')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'data', 'path-audit.jsonl')), false);
});

test('another working directory cannot become the factual or write root', (t) => {
  const rootDir = makeSyntheticPathRoot(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'path-cli-cwd-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const requestPath = path.join(cwd, 'copied-request.json');
  fs.copyFileSync(fixtureRequest, requestPath);

  const result = runCli(rootDir, [requestPath, '--local-only'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).resultCode, 'LOCAL_REVIEW_READY');
  assert.equal(fs.existsSync(path.join(rootDir, 'data', 'path-runs')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'data')), false);
});

for (const missingIdentity of [
  'package.json',
  'path-safety',
  'docs/path/repo-sources.md'
]) {
  test(`missing ${missingIdentity} identity blocks before request-controlled writes`, (t) => {
    const rootDir = makeSyntheticPathRoot(t, { missingIdentity });
    const malformed = path.join(rootDir, 'request.json');
    fs.writeFileSync(malformed, '{not-json', 'utf8');
    const result = runCli(rootDir, [malformed, '--local-only']);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'BLOCKED_INVALID_PATH_ROOT\n');
    assertNoRunWrite(rootDir);
  });
}

test('wrong package name blocks before malformed request read and workflow writes', (t) => {
  const rootDir = makeSyntheticPathRoot(t);
  fs.writeFileSync(
    path.join(rootDir, 'package.json'),
    `${JSON.stringify({ name: 'not-path' }, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(rootDir, 'request.json'), '{not-json', 'utf8');
  const result = runCli(rootDir, ['request.json', '--local-only']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'BLOCKED_INVALID_PATH_ROOT\n');
  assertNoRunWrite(rootDir);
});

for (const identity of [
  { label: 'package.json file symlink', path: 'package.json', type: 'file' },
  { label: 'path-safety junction', path: 'path-safety', type: 'junction' },
  {
    label: 'docs/path/repo-sources.md file symlink',
    path: 'docs/path/repo-sources.md',
    type: 'file'
  }
]) {
  test(`${identity.label} is rejected before request-controlled writes`, (t) => {
    const rootDir = makeSyntheticPathRoot(t);
    try {
      replaceIdentityWithSymlink(rootDir, identity.path, identity.type);
    } catch (error) {
      if (process.platform === 'win32' && error?.code === 'EPERM') {
        t.skip(`${identity.label} fixture unavailable: EPERM`);
        return;
      }
      throw error;
    }
    fs.writeFileSync(path.join(rootDir, 'request.json'), '{not-json', 'utf8');
    const result = runCli(rootDir, ['request.json', '--local-only']);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'BLOCKED_INVALID_PATH_ROOT\n');
    assertNoRunWrite(rootDir);
  });
}

test('identity replaced during provider import blocks before workflow data writes', (t) => {
  const rootDir = makeSyntheticPathRoot(t);
  installImportIdentityReplacementWrapper(rootDir);
  const result = runCli(rootDir, ['request.json', '--local-only']);

  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'BLOCKED_INVALID_PATH_ROOT\n');
  assertNoRunWrite(rootDir);
});

test('CLI source imports and calls no dispatch, connector, transport, browser, or network capability', () => {
  const source = fs.readFileSync(sourceScript, 'utf8');
  assert.doesNotMatch(
    source,
    /(?:from\s*|import\s*\()\s*['"][^'"]*(?:dispatch|connector|transport|browser|playwright|node:https?|node:net|node:tls|node:dgram|node:child_process)/i
  );
  assert.doesNotMatch(
    source,
    /\b(?:fetch|send|submit|dispatch|connect)\s*\(|\bnew\s+WebSocket\b|\bhttps?\s*\.\s*request\s*\(/i
  );
});

test('successful local run creates no approval, dispatch, connector, transport, or external ledger', (t) => {
  const rootDir = makeSyntheticPathRoot(t);
  const result = runCli(rootDir, ['request.json', '--local-only']);

  assert.equal(result.status, 0, result.stderr);
  const files = allRelativeFiles(rootDir);
  assert.ok(files.includes('data/path-outbox.jsonl'));
  assert.ok(files.includes('data/path-audit.jsonl'));
  assert.equal(files.some((name) => /path-approvals|path-dispatch|connector|transport|external/i.test(name)), false);
});
