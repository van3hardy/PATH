import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRun,
  finishRun,
  loadRun,
  transitionRun,
  writeRunArtifact
} from '../../path-runner/lifecycle.mjs';

const NOW = '2026-07-29T12:00:00.000Z';

function makeSandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'path-run-lifecycle-'));
  const rootDir = path.join(base, 'root');
  fs.mkdirSync(rootDir);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, rootDir };
}

function options(overrides = {}) {
  let id = 0;
  return {
    now: () => new Date(NOW),
    idFactory: () => `temp-${++id}`,
    ...overrides
  };
}

function runPath(rootDir, runId = 'run-test-001') {
  return path.join(rootDir, 'data', 'path-runs', runId);
}

function statePath(rootDir, runId = 'run-test-001') {
  return path.join(runPath(rootDir, runId), 'run-state.json');
}

function eventsPath(rootDir, runId = 'run-test-001') {
  return path.join(runPath(rootDir, runId), 'events.jsonl');
}

function readEvents(rootDir, runId = 'run-test-001') {
  return fs.readFileSync(eventsPath(rootDir, runId), 'utf8').trim().split('\n').map(JSON.parse);
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

// A symlinked artifact is refused by whichever guard sees it first: the run-path
// safety check, or the untracked/tampered artifact checks. Assert the security
// property (refused, target untouched) rather than which guard won the race.
const ARTIFACT_ESCAPE_CODES = [
  'BLOCKED_UNSAFE_RUN_PATH',
  'UNRESOLVED_UNTRACKED_ARTIFACT',
  'UNRESOLVED_TAMPERED_ARTIFACT'
];

function assertBlockedBy(fn, codes) {
  assert.throws(fn, (error) => {
    assert.ok(
      codes.includes(error.code),
      `expected one of ${codes.join(', ')}, got ${error.code}`
    );
    return true;
  });
}

function fsWith(overrides = {}) {
  return { ...fs, ...overrides };
}

function create(rootDir, runId = 'run-test-001', extraOptions = {}) {
  return createRun({ rootDir, runId }, options(extraOptions));
}

function transition(rootDir, to, extraOptions = {}) {
  return transitionRun({ rootDir, runId: 'run-test-001', to }, options(extraOptions));
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

test('createRun creates one bounded CREATED state and a bound run_created event', (t) => {
  const { rootDir } = makeSandbox(t);
  const state = create(rootDir);

  assert.deepEqual(state, {
    schemaVersion: 'path.run-state.v1',
    runId: 'run-test-001',
    status: 'CREATED',
    artifactHashes: {},
    updatedAt: NOW
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath(rootDir), 'utf8')), state);
  const events = readEvents(rootDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].schemaVersion, 'path.run-event.v1');
  assert.equal(events[0].event, 'run_created');
  assert.equal(events[0].sequence, 1);
  assert.equal(events[0].runId, 'run-test-001');
  assert.match(events[0].stateHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(loadRun({ rootDir, runId: 'run-test-001' }).state, state);
});

test('createRun rejects duplicate and invalid run IDs without changing the first run', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  const before = fs.readFileSync(statePath(rootDir), 'utf8');
  assertCode(() => create(rootDir), 'BLOCKED_DUPLICATE_RUN');
  assert.equal(fs.readFileSync(statePath(rootDir), 'utf8'), before);

  for (const runId of ['../outside', 'run-Upper', 'run-a/b', 'C:\\run-bad', '/run-bad', 'run-a:b', 'run-a\0b']) {
    assertCode(() => create(rootDir, runId), 'BLOCKED_INVALID_RUN_ID');
  }
});

test('the exact transition graph reaches HUMAN_REVIEW and finishRun preserves terminality', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  for (const status of [
    'VALIDATED',
    'EVIDENCE_SELECTED',
    'DRAFTED',
    'CLAIMS_VERIFIED',
    'PACKET_QUEUED'
  ]) {
    assert.equal(transition(rootDir, status).status, status);
  }
  assert.equal(finishRun({
    rootDir, runId: 'run-test-001', status: 'HUMAN_REVIEW'
  }, options()).status, 'HUMAN_REVIEW');
  assertCode(() => transition(rootDir, 'FAILED'), 'BLOCKED_INVALID_TRANSITION');

  const events = readEvents(rootDir);
  assert.equal(events.filter((entry) => entry.event === 'transition_intent').length, 6);
  assert.equal(events.filter((entry) => entry.event === 'transition_committed').length, 6);
  for (let index = 1; index < events.length; index += 2) {
    assert.equal(events[index].event, 'transition_intent');
    assert.equal(events[index + 1].event, 'transition_committed');
    assert.equal(events[index].sequence, events[index + 1].sequence);
    assert.equal(events[index].proposedStateHash, events[index + 1].finalStateHash);
  }
});

test('UNRESOLVED is reachable from every nonterminal state and remains terminal', (t) => {
  const paths = [
    [],
    ['VALIDATED'],
    ['VALIDATED', 'EVIDENCE_SELECTED'],
    ['VALIDATED', 'EVIDENCE_SELECTED', 'DRAFTED'],
    ['VALIDATED', 'EVIDENCE_SELECTED', 'DRAFTED', 'CLAIMS_VERIFIED'],
    ['VALIDATED', 'EVIDENCE_SELECTED', 'DRAFTED', 'CLAIMS_VERIFIED', 'PACKET_QUEUED']
  ];

  for (const pathToState of paths) {
    const { rootDir } = makeSandbox(t);
    create(rootDir);
    for (const status of pathToState) transition(rootDir, status);

    const state = finishRun({
      rootDir, runId: 'run-test-001', status: 'UNRESOLVED'
    }, options());

    assert.equal(state.status, 'UNRESOLVED', pathToState.at(-1) ?? 'CREATED');
    assert.equal(loadRun({ rootDir, runId: 'run-test-001' }).state.status, 'UNRESOLVED');
    assertCode(() => transition(rootDir, 'FAILED'), 'BLOCKED_INVALID_TRANSITION');
    assertCode(() => finishRun({
      rootDir, runId: 'run-test-001', status: 'UNRESOLVED'
    }, options()), 'BLOCKED_INVALID_TRANSITION');
  }
});

test('illegal and invented transitions block without appending or replacing state', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  const beforeState = fs.readFileSync(statePath(rootDir), 'utf8');
  const beforeEvents = fs.readFileSync(eventsPath(rootDir), 'utf8');
  for (const to of ['DRAFTED', 'SUCCESS', 'APPROVED', 'REJECTED', 'READY_TO_SEND']) {
    assertCode(() => transition(rootDir, to), 'BLOCKED_INVALID_TRANSITION');
  }
  assert.equal(fs.readFileSync(statePath(rootDir), 'utf8'), beforeState);
  assert.equal(fs.readFileSync(eventsPath(rootDir), 'utf8'), beforeEvents);
});

test('artifact names are exact, immutable, and rejected before path construction', (t) => {
  const { base, rootDir } = makeSandbox(t);
  create(rootDir);
  for (const name of [
    '../draft.md',
    '..\\draft.md',
    '/draft.md',
    'C:\\draft.md',
    'DRAFT.md',
    'draft.md:stream',
    'draft.md\0',
    'events.jsonl',
    'unknown.json'
  ]) {
    assertCode(() => writeRunArtifact({
      rootDir, runId: 'run-test-001', name, content: 'synthetic'
    }, options()), 'BLOCKED_INVALID_ARTIFACT_NAME');
  }
  assert.equal(fs.existsSync(path.join(base, 'draft.md')), false);
  assert.equal(readEvents(rootDir).length, 1);
});

test('allowed artifact rename, event, and state update are hash-bound in that order', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  const result = writeRunArtifact({
    rootDir,
    runId: 'run-test-001',
    name: 'draft.md',
    content: 'Synthetic draft.\n'
  }, options());
  const expectedHash = crypto.createHash('sha256').update('Synthetic draft.\n').digest('hex');
  assert.equal(result.name, 'draft.md');
  assert.equal(result.sha256, expectedHash);
  assert.equal(result.state.artifactHashes['draft.md'], expectedHash);

  const events = readEvents(rootDir);
  assert.deepEqual(events.map((entry) => entry.event), [
    'run_created', 'artifact_written', 'transition_intent', 'transition_committed'
  ]);
  assert.equal(events[1].artifactHash, expectedHash);
  assert.equal(events[2].from, 'CREATED');
  assert.equal(events[2].to, 'CREATED');
  assert.equal(events[2].proposedStateHash, events[3].finalStateHash);
  assert.equal(loadRun({ rootDir, runId: 'run-test-001' }).state.artifactHashes['draft.md'], expectedHash);
});

test('atomic artifact write failure closes the descriptor, removes only its exact temp, and never returns success', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  const removed = [];
  let temporaryDescriptor;
  let temporaryCloseCount = 0;
  const injected = fsWith({
    openSync(target, flags) {
      const descriptor = fs.openSync(target, flags);
      if (flags === 'wx') temporaryDescriptor = descriptor;
      return descriptor;
    },
    writeFileSync(target, data, encoding) {
      if (typeof target === 'number') throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
      return fs.writeFileSync(target, data, encoding);
    },
    closeSync(descriptor) {
      if (descriptor === temporaryDescriptor) temporaryCloseCount += 1;
      return fs.closeSync(descriptor);
    },
    unlinkSync(target) {
      removed.push(target);
      return fs.unlinkSync(target);
    }
  });

  assertCode(() => writeRunArtifact({
    rootDir, runId: 'run-test-001', name: 'draft.md', content: 'synthetic'
  }, options({ fsImpl: injected })), 'FAILED_ARTIFACT_WRITE');
  assert.equal(temporaryCloseCount, 1);
  assert.equal(fs.existsSync(path.join(runPath(rootDir), 'draft.md')), false);
  assert.equal(removed.length, 1);
  assert.match(path.basename(removed[0]), /^\.draft\.md\.[a-z0-9-]+\.tmp$/);
  assert.equal(path.dirname(removed[0]), runPath(rootDir));
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath(rootDir), 'utf8')).artifactHashes, {});
});

test('transition intent append failure preserves the prior committed state and returns no false success', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  const before = fs.readFileSync(statePath(rootDir), 'utf8');
  const injected = fsWith({
    appendFileSync(target, text, encoding) {
      if (text.includes('transition_intent')) throw new Error('synthetic intent append failure');
      return fs.appendFileSync(target, text, encoding);
    }
  });
  assertCode(() => transition(rootDir, 'VALIDATED', { fsImpl: injected }), 'FAILED_EVENT_WRITE');
  assert.equal(fs.readFileSync(statePath(rootDir), 'utf8'), before);
  assert.deepEqual(readEvents(rootDir).map((entry) => entry.event), ['run_created']);
});

test('state replacement failure after intent appends aborted and returns unresolved', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  const before = fs.readFileSync(statePath(rootDir), 'utf8');
  const injected = fsWith({
    renameSync(source, target) {
      if (target === statePath(rootDir)) throw new Error('synthetic state replace failure');
      return fs.renameSync(source, target);
    }
  });
  assertCode(
    () => transition(rootDir, 'VALIDATED', { fsImpl: injected }),
    'UNRESOLVED_INCOMPLETE_TRANSITION'
  );
  assert.equal(fs.readFileSync(statePath(rootDir), 'utf8'), before);
  assert.deepEqual(readEvents(rootDir).map((entry) => entry.event), [
    'run_created', 'transition_intent', 'transition_aborted'
  ]);
});

test('commit append failure leaves state ahead and loadRun reports incomplete transition', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  const injected = fsWith({
    appendFileSync(target, text, encoding) {
      if (text.includes('transition_committed')) throw new Error('synthetic commit failure');
      return fs.appendFileSync(target, text, encoding);
    }
  });
  assertCode(
    () => transition(rootDir, 'VALIDATED', { fsImpl: injected }),
    'UNRESOLVED_INCOMPLETE_TRANSITION'
  );
  assert.equal(JSON.parse(fs.readFileSync(statePath(rootDir), 'utf8')).status, 'VALIDATED');
  assert.deepEqual(readEvents(rootDir).map((entry) => entry.event), [
    'run_created', 'transition_intent'
  ]);
  assertCode(
    () => loadRun({ rootDir, runId: 'run-test-001' }),
    'UNRESOLVED_INCOMPLETE_TRANSITION'
  );
});

test('artifact event failure after rename remains an unresolved untracked artifact', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  const injected = fsWith({
    appendFileSync(target, text, encoding) {
      if (text.includes('artifact_written')) throw new Error('synthetic artifact event failure');
      return fs.appendFileSync(target, text, encoding);
    }
  });
  assertCode(() => writeRunArtifact({
    rootDir, runId: 'run-test-001', name: 'draft.md', content: 'synthetic'
  }, options({ fsImpl: injected })), 'UNRESOLVED_UNTRACKED_ARTIFACT');
  assert.equal(fs.readFileSync(path.join(runPath(rootDir), 'draft.md'), 'utf8'), 'synthetic');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath(rootDir), 'utf8')).artifactHashes, {});
  assertCode(
    () => loadRun({ rootDir, runId: 'run-test-001' }),
    'UNRESOLVED_UNTRACKED_ARTIFACT'
  );
});

test('artifact state-update failure after rename and event remains unresolved and never adopts or deletes', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  const artifactPath = path.join(runPath(rootDir), 'draft.md');
  const injected = fsWith({
    appendFileSync(target, text, encoding) {
      if (text.includes('transition_intent')) throw new Error('synthetic artifact state failure');
      return fs.appendFileSync(target, text, encoding);
    }
  });
  assertCode(() => writeRunArtifact({
    rootDir, runId: 'run-test-001', name: 'draft.md', content: 'synthetic'
  }, options({ fsImpl: injected })), 'UNRESOLVED_UNTRACKED_ARTIFACT');
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'synthetic');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath(rootDir), 'utf8')).artifactHashes, {});
  assertCode(
    () => loadRun({ rootDir, runId: 'run-test-001' }),
    'UNRESOLVED_UNTRACKED_ARTIFACT'
  );
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'synthetic');
});

test('artifact state replacement failure is recovered as untracked, not as a false transition success', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  const artifactPath = path.join(runPath(rootDir), 'draft.md');
  const injected = fsWith({
    renameSync(source, target) {
      if (target === statePath(rootDir)) throw new Error('synthetic artifact state replace failure');
      return fs.renameSync(source, target);
    }
  });
  assertCode(() => writeRunArtifact({
    rootDir, runId: 'run-test-001', name: 'draft.md', content: 'synthetic'
  }, options({ fsImpl: injected })), 'UNRESOLVED_UNTRACKED_ARTIFACT');
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'synthetic');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath(rootDir), 'utf8')).artifactHashes, {});
  assert.deepEqual(readEvents(rootDir).map((entry) => entry.event), [
    'run_created', 'artifact_written', 'transition_intent', 'transition_aborted'
  ]);
  assertCode(
    () => loadRun({ rootDir, runId: 'run-test-001' }),
    'UNRESOLVED_UNTRACKED_ARTIFACT'
  );
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'synthetic');
});

test('loadRun rejects tampered, unknown, and untracked artifacts without repairing them', (t) => {
  const cases = [
    ['tampered', 'UNRESOLVED_TAMPERED_ARTIFACT', (rootDir) => {
      fs.writeFileSync(path.join(runPath(rootDir), 'draft.md'), 'changed', 'utf8');
    }],
    ['untracked allowlisted', 'UNRESOLVED_UNTRACKED_ARTIFACT', (rootDir) => {
      fs.writeFileSync(path.join(runPath(rootDir), 'request.json'), '{}', 'utf8');
    }],
    ['unknown file', 'UNRESOLVED_UNTRACKED_ARTIFACT', (rootDir) => {
      fs.writeFileSync(path.join(runPath(rootDir), 'unknown.txt'), 'synthetic', 'utf8');
    }]
  ];
  for (const [name, code, mutate] of cases) {
    const { rootDir } = makeSandbox(t);
    create(rootDir);
    writeRunArtifact({
      rootDir, runId: 'run-test-001', name: 'draft.md', content: 'synthetic'
    }, options());
    mutate(rootDir);
    const before = fs.readdirSync(runPath(rootDir)).sort();
    assertCode(() => loadRun({ rootDir, runId: 'run-test-001' }), code);
    assert.deepEqual(fs.readdirSync(runPath(rootDir)).sort(), before, name);
  }
});

test('loadRun strictly rejects malformed state and event JSON, schema, status, and sequence', (t) => {
  const cases = [
    ['malformed state JSON', (rootDir) => fs.writeFileSync(statePath(rootDir), '{bad', 'utf8')],
    ['unknown state key', (rootDir) => {
      const state = JSON.parse(fs.readFileSync(statePath(rootDir), 'utf8'));
      state.extra = true;
      fs.writeFileSync(statePath(rootDir), JSON.stringify(state), 'utf8');
    }],
    ['unknown status', (rootDir) => {
      const state = JSON.parse(fs.readFileSync(statePath(rootDir), 'utf8'));
      state.status = 'SUCCESS';
      fs.writeFileSync(statePath(rootDir), JSON.stringify(state), 'utf8');
    }],
    ['malformed event JSON', (rootDir) => fs.appendFileSync(eventsPath(rootDir), '{bad\n', 'utf8')],
    ['unknown event schema', (rootDir) => {
      const events = readEvents(rootDir);
      events[0].schemaVersion = 'path.run-event.v2';
      fs.writeFileSync(eventsPath(rootDir), `${events.map(JSON.stringify).join('\n')}\n`, 'utf8');
    }],
    ['duplicate sequence', (rootDir) => {
      const event = readEvents(rootDir)[0];
      fs.appendFileSync(eventsPath(rootDir), `${JSON.stringify(event)}\n`, 'utf8');
    }],
    ['out-of-order sequence', (rootDir) => {
      const event = { ...readEvents(rootDir)[0], sequence: 3 };
      fs.appendFileSync(eventsPath(rootDir), `${JSON.stringify(event)}\n`, 'utf8');
    }]
  ];
  for (const [name, mutate] of cases) {
    const { rootDir } = makeSandbox(t);
    create(rootDir);
    mutate(rootDir);
    assertCode(
      () => loadRun({ rootDir, runId: 'run-test-001' }),
      'UNRESOLVED_INCOMPLETE_TRANSITION'
    );
    assert.ok(name);
  }
});

test('loadRun rejects a mismatched intent/commit pair and final committed hash', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  transition(rootDir, 'VALIDATED');
  const events = readEvents(rootDir);
  events[2].finalStateHash = 'f'.repeat(64);
  fs.writeFileSync(eventsPath(rootDir), `${events.map(JSON.stringify).join('\n')}\n`, 'utf8');
  assertCode(
    () => loadRun({ rootDir, runId: 'run-test-001' }),
    'UNRESOLVED_INCOMPLETE_TRANSITION'
  );
});

test('a run-directory symlink is rejected without following its target', (t) => {
  const { base, rootDir } = makeSandbox(t);
  const outsideRun = path.join(base, 'outside-run');
  fs.mkdirSync(path.join(rootDir, 'data', 'path-runs'), { recursive: true });
  fs.mkdirSync(outsideRun);
  const link = runPath(rootDir);
  if (createSymlinkOrSkip(t, outsideRun, link, 'dir')) {
    assertCode(() => create(rootDir), 'BLOCKED_UNSAFE_RUN_PATH');
    assert.deepEqual(fs.readdirSync(outsideRun), []);
  }
});

test('an artifact symlink is rejected without overwriting its target', (t) => {
  const { base, rootDir } = makeSandbox(t);
  create(rootDir);
  const outsideArtifact = path.join(base, 'outside.md');
  fs.writeFileSync(outsideArtifact, 'outside', 'utf8');
  const artifactLink = path.join(runPath(rootDir), 'draft.md');
  if (createSymlinkOrSkip(t, outsideArtifact, artifactLink)) {
    assertBlockedBy(() => writeRunArtifact({
      rootDir,
      runId: 'run-test-001',
      name: 'draft.md',
      content: 'replacement'
    }, options()), ARTIFACT_ESCAPE_CODES);
    assert.equal(fs.readFileSync(outsideArtifact, 'utf8'), 'outside');
    assert.ok(fs.lstatSync(artifactLink).isSymbolicLink(),
      'the symlink must not be replaced by a regular file');
  }
});

test('a tracked artifact swapped for a symlink is rejected without overwriting its target', (t) => {
  const { base, rootDir } = makeSandbox(t);
  create(rootDir);
  const artifact = path.join(runPath(rootDir), 'draft.md');
  writeRunArtifact({
    rootDir, runId: 'run-test-001', name: 'draft.md', content: 'legit'
  }, options());

  const outsideArtifact = path.join(base, 'outside.md');
  fs.writeFileSync(outsideArtifact, 'outside', 'utf8');
  fs.unlinkSync(artifact);
  if (createSymlinkOrSkip(t, outsideArtifact, artifact)) {
    assertBlockedBy(() => writeRunArtifact({
      rootDir,
      runId: 'run-test-001',
      name: 'draft.md',
      content: 'replacement'
    }, options()), ARTIFACT_ESCAPE_CODES);
    assert.equal(fs.readFileSync(outsideArtifact, 'utf8'), 'outside');
  }
});

test('a symlink whose target matches the recorded hash is still rejected', (t) => {
  const { base, rootDir } = makeSandbox(t);
  create(rootDir);
  const artifact = path.join(runPath(rootDir), 'draft.md');
  writeRunArtifact({
    rootDir, runId: 'run-test-001', name: 'draft.md', content: 'legit'
  }, options());

  // Byte-identical to the recorded content, so a content-hash check alone passes.
  const victim = path.join(base, 'victim.md');
  fs.writeFileSync(victim, 'legit', 'utf8');
  fs.unlinkSync(artifact);
  if (createSymlinkOrSkip(t, victim, artifact)) {
    assertBlockedBy(() => writeRunArtifact({
      rootDir,
      runId: 'run-test-001',
      name: 'draft.md',
      content: 'ATTACKER-CONTROLLED'
    }, options()), ARTIFACT_ESCAPE_CODES);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'legit');
  }
});

test('loadRun is read-only even when the run is inconsistent', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  fs.writeFileSync(path.join(runPath(rootDir), 'draft.md'), 'orphan', 'utf8');
  const beforeState = fs.readFileSync(statePath(rootDir));
  const beforeEvents = fs.readFileSync(eventsPath(rootDir));
  const beforeArtifact = fs.readFileSync(path.join(runPath(rootDir), 'draft.md'));
  assertCode(
    () => loadRun({ rootDir, runId: 'run-test-001' }),
    'UNRESOLVED_UNTRACKED_ARTIFACT'
  );
  assert.deepEqual(fs.readFileSync(statePath(rootDir)), beforeState);
  assert.deepEqual(fs.readFileSync(eventsPath(rootDir)), beforeEvents);
  assert.deepEqual(fs.readFileSync(path.join(runPath(rootDir), 'draft.md')), beforeArtifact);
});

test('event append stays bound to the checked ledger instead of a swapped pathname', (t) => {
  const { base, rootDir } = makeSandbox(t);
  create(rootDir);
  const redirected = path.join(base, 'redirected-events.jsonl');
  fs.writeFileSync(redirected, 'outside\n', 'utf8');
  let swapped = false;
  const injected = fsWith({
    appendFileSync(target, text, encoding) {
      if (!swapped && typeof target === 'string' && text.includes('transition_intent')) {
        swapped = true;
        return fs.appendFileSync(redirected, text, encoding);
      }
      return fs.appendFileSync(target, text, encoding);
    }
  });

  assert.equal(transition(rootDir, 'VALIDATED', { fsImpl: injected }).status, 'VALIDATED');
  assert.equal(fs.readFileSync(redirected, 'utf8'), 'outside\n');
  assert.equal(loadRun({ rootDir, runId: 'run-test-001' }).state.status, 'VALIDATED');
});

test('atomic rename blocks a swapped run directory and preserves an unowned replacement temp', (t) => {
  const { base, rootDir } = makeSandbox(t);
  create(rootDir);
  const originalRun = runPath(rootDir);
  const movedRun = path.join(base, 'moved-run');
  const artifact = path.join(originalRun, 'draft.md');
  let temporaryName;
  let replacementTemporary;
  let swapped = false;
  const injected = fsWith({
    openSync(target, flags) {
      const descriptor = fs.openSync(target, flags);
      if (flags === 'wx' && path.basename(target).startsWith('.draft.md.')) {
        temporaryName = path.basename(target);
      }
      return descriptor;
    },
    lstatSync(target, options) {
      if (!swapped && temporaryName && target === artifact) {
        swapped = true;
        fs.renameSync(originalRun, movedRun);
        fs.mkdirSync(originalRun);
        replacementTemporary = path.join(originalRun, temporaryName);
        fs.writeFileSync(replacementTemporary, 'concurrent-owner', 'utf8');
      }
      return fs.lstatSync(target, options);
    }
  });

  assertCode(() => writeRunArtifact({
    rootDir, runId: 'run-test-001', name: 'draft.md', content: 'synthetic'
  }, options({ fsImpl: injected })), 'BLOCKED_UNSAFE_RUN_PATH');
  assert.equal(fs.existsSync(artifact), false);
  assert.equal(fs.readFileSync(replacementTemporary, 'utf8'), 'concurrent-owner');
});

test('exclusive temp collision never unlinks a concurrently owned sibling', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  let concurrentTemporary;
  const injected = fsWith({
    openSync(target, flags) {
      if (flags === 'wx' && path.basename(target).startsWith('.draft.md.')) {
        concurrentTemporary = target;
        fs.writeFileSync(target, 'concurrent-owner', 'utf8');
        throw Object.assign(new Error('synthetic exclusive collision'), { code: 'EEXIST' });
      }
      return fs.openSync(target, flags);
    }
  });

  assertCode(() => writeRunArtifact({
    rootDir, runId: 'run-test-001', name: 'draft.md', content: 'synthetic'
  }, options({ fsImpl: injected })), 'FAILED_ARTIFACT_WRITE');
  assert.equal(fs.readFileSync(concurrentTemporary, 'utf8'), 'concurrent-owner');
  assert.equal(fs.existsSync(path.join(runPath(rootDir), 'draft.md')), false);
});

test('stale concurrent transitions cannot both succeed or corrupt committed state', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  let nestedOutcome;
  let triggered = false;
  let eventLstatCount = 0;
  const injected = fsWith({
    lstatSync(target, options) {
      if (target === eventsPath(rootDir)) eventLstatCount += 1;
      if (!triggered && target === eventsPath(rootDir) && eventLstatCount === 3) {
        triggered = true;
        try {
          nestedOutcome = { state: transition(rootDir, 'BLOCKED') };
        } catch (error) {
          nestedOutcome = { error };
        }
      }
      return fs.lstatSync(target, options);
    }
  });
  let outerOutcome;
  try {
    outerOutcome = { state: transition(rootDir, 'VALIDATED', { fsImpl: injected }) };
  } catch (error) {
    outerOutcome = { error };
  }

  const outcomes = [nestedOutcome, outerOutcome];
  assert.equal(outcomes.filter((outcome) => outcome?.state).length, 1);
  assert.equal(outcomes.filter((outcome) => outcome?.error).length, 1);
  assert.match(outcomes.find((outcome) => outcome.error).error.code, /^(BLOCKED|UNRESOLVED)_/);
  const winner = outcomes.find((outcome) => outcome.state).state;
  assert.deepEqual(loadRun({ rootDir, runId: 'run-test-001' }).state, winner);
});

test('state without its creation event is an unresolved incomplete transition', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  fs.unlinkSync(eventsPath(rootDir));

  assertCode(
    () => loadRun({ rootDir, runId: 'run-test-001' }),
    'UNRESOLVED_INCOMPLETE_TRANSITION'
  );
});

test('create state rename followed by verification failure is unresolved split-brain', (t) => {
  const { rootDir } = makeSandbox(t);
  const targetState = statePath(rootDir, 'run-create-split');
  let stateRenamed = false;
  const injected = fsWith({
    renameSync(source, target) {
      const result = fs.renameSync(source, target);
      if (target === targetState) stateRenamed = true;
      return result;
    },
    openSync(target, flags) {
      if (stateRenamed && target === targetState && flags === 'r') {
        throw Object.assign(new Error('synthetic post-rename verification failure'), { code: 'EIO' });
      }
      return fs.openSync(target, flags);
    }
  });

  assertCode(
    () => create(rootDir, 'run-create-split', { fsImpl: injected }),
    'UNRESOLVED_INCOMPLETE_TRANSITION'
  );
  assert.equal(fs.existsSync(targetState), true);
  assert.equal(fs.existsSync(eventsPath(rootDir, 'run-create-split')), false);
});

test('each artifact_written event must be immediately followed by its own same-status state update', (t) => {
  const { rootDir } = makeSandbox(t);
  create(rootDir);
  writeRunArtifact({
    rootDir, runId: 'run-test-001', name: 'draft.md', content: 'draft'
  }, options());
  writeRunArtifact({
    rootDir, runId: 'run-test-001', name: 'request.json', content: '{}'
  }, options());
  const events = readEvents(rootDir);
  const interleaved = [
    events[0],
    { ...events[1], sequence: 2 },
    { ...events[4], sequence: 3 },
    { ...events[5], sequence: 4, priorStateHash: events[0].stateHash },
    { ...events[6], sequence: 4 }
  ];
  fs.writeFileSync(eventsPath(rootDir), `${interleaved.map(JSON.stringify).join('\n')}\n`, 'utf8');

  assertCode(
    () => loadRun({ rootDir, runId: 'run-test-001' }),
    'UNRESOLVED_INCOMPLETE_TRANSITION'
  );
});

test('safe lstat suppresses missing paths but propagates access errors without creating', (t) => {
  const { rootDir } = makeSandbox(t);
  const dataPath = path.join(rootDir, 'data');
  let mkdirCalled = false;
  const injected = fsWith({
    lstatSync(target, options) {
      if (target === dataPath) {
        throw Object.assign(new Error('synthetic access denial'), { code: 'EACCES' });
      }
      return fs.lstatSync(target, options);
    },
    mkdirSync(target, options) {
      mkdirCalled = true;
      return fs.mkdirSync(target, options);
    }
  });

  assertCode(() => create(rootDir, 'run-denied', { fsImpl: injected }), 'EACCES');
  assert.equal(mkdirCalled, false);
  assert.equal(fs.existsSync(dataPath), false);
});
