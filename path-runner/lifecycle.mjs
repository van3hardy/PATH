import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RUN_ID = /^run-[a-z0-9-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TEMP_ID = /^[a-zA-Z0-9-]+$/;
const STATE_SCHEMA = 'path.run-state.v1';
const EVENT_SCHEMA = 'path.run-event.v1';
const MUTATION_LOCK = '.lifecycle.lock';
const PAYLOAD_ARTIFACTS = new Set([
  'request.json',
  'evidence-selection.json',
  'draft.md',
  'claim-report.json',
  'run-summary.md'
]);
const INTERNAL_FILES = new Set([...PAYLOAD_ARTIFACTS, 'run-state.json', 'events.jsonl']);
const STATUSES = new Set([
  'CREATED',
  'VALIDATED',
  'EVIDENCE_SELECTED',
  'DRAFTED',
  'CLAIMS_VERIFIED',
  'PACKET_QUEUED',
  'HUMAN_REVIEW',
  'FAILED',
  'BLOCKED',
  'UNRESOLVED'
]);
const TERMINAL_STATUSES = new Set(['HUMAN_REVIEW', 'FAILED', 'BLOCKED', 'UNRESOLVED']);
const TRANSITIONS = new Map([
  ['CREATED', new Set(['VALIDATED', 'BLOCKED', 'FAILED', 'UNRESOLVED'])],
  ['VALIDATED', new Set(['EVIDENCE_SELECTED', 'BLOCKED', 'FAILED', 'UNRESOLVED'])],
  ['EVIDENCE_SELECTED', new Set(['DRAFTED', 'BLOCKED', 'FAILED', 'UNRESOLVED'])],
  ['DRAFTED', new Set(['CLAIMS_VERIFIED', 'BLOCKED', 'FAILED', 'UNRESOLVED'])],
  ['CLAIMS_VERIFIED', new Set(['PACKET_QUEUED', 'BLOCKED', 'FAILED', 'UNRESOLVED'])],
  ['PACKET_QUEUED', new Set(['HUMAN_REVIEW', 'FAILED', 'UNRESOLVED'])],
  ['HUMAN_REVIEW', new Set()]
]);

export function createRun({ rootDir, runId } = {}, options = {}) {
  assertRunId(runId);
  const deps = dependencies(options);
  const root = resolveRoot(rootDir, deps.fsImpl);
  const data = ensureDirectory(root, 'data', deps.fsImpl);
  const runs = ensureDirectory(data, 'path-runs', deps.fsImpl);
  const candidate = path.join(runs.real, runId);
  const existing = safeLstat(candidate, deps.fsImpl);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw codedError('BLOCKED_UNSAFE_RUN_PATH');
    }
    throw codedError('BLOCKED_DUPLICATE_RUN');
  }

  assertIdentityChain([root, data, runs], deps.fsImpl);
  try {
    deps.fsImpl.mkdirSync(candidate);
  } catch (error) {
    if (safeLstat(candidate, deps.fsImpl)) throw codedError('BLOCKED_DUPLICATE_RUN', error);
    throw codedError('BLOCKED_UNSAFE_RUN_PATH', error);
  }
  const run = resolveDirectChild(runs, candidate, deps.fsImpl);
  const context = makeContext(root, data, runs, run, runId);
  const state = {
    schemaVersion: STATE_SCHEMA,
    runId,
    status: 'CREATED',
    artifactHashes: {},
    updatedAt: timestamp(deps.now)
  };

  try {
    atomicWrite(context, 'run-state.json', stableStringify(state), {
      ...deps,
      allowReplace: false,
      errorCode: 'FAILED_STATE_WRITE'
    });
  } catch (error) {
    if (error.targetReplaced) throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION', error);
    throw error;
  }
  try {
    appendEvent(context, {
      schemaVersion: EVENT_SCHEMA,
      event: 'run_created',
      sequence: 1,
      timestamp: timestamp(deps.now),
      runId,
      stateHash: stateHash(state)
    }, deps.fsImpl, true);
  } catch (error) {
    throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION', error);
  }
  return clone(state);
}

export function writeRunArtifact(
  { rootDir, runId, name, content } = {},
  options = {}
) {
  assertRunId(runId);
  assertArtifactName(name);
  if (typeof content !== 'string') throw codedError('BLOCKED_INVALID_ARTIFACT_CONTENT');
  const deps = dependencies(options);
  return withMutationLock(rootDir, runId, deps, (loaded) => {
    const context = loaded.context;
    const target = path.join(context.run.real, name);
    if (safeLstat(target, deps.fsImpl)) throw codedError('BLOCKED_ARTIFACT_EXISTS');

    let written;
    try {
      written = atomicWrite(context, name, content, {
        ...deps,
        allowReplace: false,
        errorCode: 'FAILED_ARTIFACT_WRITE'
      });
    } catch (error) {
      if (error.targetReplaced) throw codedError('UNRESOLVED_UNTRACKED_ARTIFACT', error);
      throw error;
    }

    const artifactEvent = {
      schemaVersion: EVENT_SCHEMA,
      event: 'artifact_written',
      sequence: nextSequence(loaded.events),
      timestamp: timestamp(deps.now),
      runId,
      name,
      artifactHash: written.sha256
    };
    try {
      appendEvent(context, artifactEvent, deps.fsImpl);
    } catch (error) {
      throw codedError('UNRESOLVED_UNTRACKED_ARTIFACT', error);
    }

    const nextState = {
      ...loaded.state,
      artifactHashes: { ...loaded.state.artifactHashes, [name]: written.sha256 },
      updatedAt: timestamp(deps.now)
    };
    let state;
    try {
      state = updateState(
        context,
        loaded.state,
        nextState,
        artifactEvent.sequence + 1,
        deps
      );
    } catch (error) {
      throw codedError('UNRESOLVED_UNTRACKED_ARTIFACT', error);
    }
    return { name, sha256: written.sha256, state };
  });
}

export function transitionRun({ rootDir, runId, to } = {}, options = {}) {
  assertRunId(runId);
  const deps = dependencies(options);
  return withMutationLock(rootDir, runId, deps, (loaded) => {
    if (typeof to !== 'string' || TERMINAL_STATUSES.has(loaded.state.status) ||
        !TRANSITIONS.get(loaded.state.status)?.has(to)) {
      throw codedError('BLOCKED_INVALID_TRANSITION');
    }
    const nextState = {
      ...loaded.state,
      status: to,
      artifactHashes: { ...loaded.state.artifactHashes },
      updatedAt: timestamp(deps.now)
    };
    return updateState(
      loaded.context,
      loaded.state,
      nextState,
      nextSequence(loaded.events),
      deps
    );
  });
}

export function finishRun({ rootDir, runId, status } = {}, options = {}) {
  if (!TERMINAL_STATUSES.has(status)) throw codedError('BLOCKED_INVALID_TRANSITION');
  return transitionRun({ rootDir, runId, to: status }, options);
}

export function loadRun({ rootDir, runId } = {}, options = {}) {
  assertRunId(runId);
  const deps = dependencies(options);
  const loaded = loadValidatedRun(rootDir, runId, deps.fsImpl);
  return { state: clone(loaded.state), events: clone(loaded.events) };
}

function loadValidatedRun(rootDir, runId, fsImpl) {
  const context = resolveRun(rootDir, runId, fsImpl);
  return loadValidatedContext(context, fsImpl);
}

function loadValidatedContext(context, fsImpl, allowMutationLock = false) {
  let state;
  let events;
  try {
    state = parseState(readRegularFile(context, 'run-state.json', fsImpl), context.runId);
    events = parseEvents(readRegularFile(context, 'events.jsonl', fsImpl), context.runId);
  } catch (error) {
    if (error?.code?.startsWith('BLOCKED_') || error?.code?.startsWith('UNRESOLVED_')) {
      throw error;
    }
    throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION', error);
  }
  validateArtifacts(context, state, events, fsImpl, allowMutationLock);
  validateHistory(state, events);
  assertIdentityChain(context.chain, fsImpl);
  return { context, state, events };
}

function withMutationLock(rootDir, runId, deps, mutate) {
  const context = resolveRun(rootDir, runId, deps.fsImpl);
  const lockPath = path.join(context.run.real, MUTATION_LOCK);
  assertIdentityChain(context.chain, deps.fsImpl);
  try {
    deps.fsImpl.mkdirSync(lockPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw codedError('BLOCKED_CONCURRENT_RUN_MUTATION', error);
    }
    throw codedError('BLOCKED_UNSAFE_RUN_PATH', error);
  }
  const lockSnapshot = safeLstat(lockPath, deps.fsImpl);
  if (!lockSnapshot || lockSnapshot.isSymbolicLink() || !lockSnapshot.isDirectory()) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  }
  try {
    assertIdentityChain(context.chain, deps.fsImpl);
    return mutate(loadValidatedContext(context, deps.fsImpl, true));
  } finally {
    try {
      assertIdentityChain(context.chain, deps.fsImpl);
      const current = safeLstat(lockPath, deps.fsImpl);
      if (current?.isDirectory() && sameIdentity(lockSnapshot, current)) {
        deps.fsImpl.rmdirSync(lockPath);
      }
    } catch {
      // Never remove a lock path after its verified identity is lost.
    }
  }
}

function updateState(context, currentState, nextState, sequence, deps) {
  const priorStateHash = stateHash(currentState);
  const proposedStateHash = stateHash(nextState);
  const eventBase = {
    schemaVersion: EVENT_SCHEMA,
    sequence,
    timestamp: timestamp(deps.now),
    runId: currentState.runId,
    from: currentState.status,
    to: nextState.status,
    priorStateHash,
    proposedStateHash
  };
  try {
    appendEvent(context, { ...eventBase, event: 'transition_intent' }, deps.fsImpl);
  } catch (error) {
    throw codedError('FAILED_EVENT_WRITE', error);
  }

  try {
    atomicWrite(context, 'run-state.json', stableStringify(nextState), {
      ...deps,
      allowReplace: true,
      errorCode: 'FAILED_STATE_WRITE'
    });
  } catch (error) {
    if (!error.targetReplaced) {
      try {
        appendEvent(context, { ...eventBase, event: 'transition_aborted' }, deps.fsImpl);
      } catch {
        // The unresolved result is authoritative when the ledger is unavailable.
      }
    }
    throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION', error);
  }

  try {
    appendEvent(context, {
      schemaVersion: EVENT_SCHEMA,
      event: 'transition_committed',
      sequence,
      timestamp: timestamp(deps.now),
      runId: currentState.runId,
      from: currentState.status,
      to: nextState.status,
      finalStateHash: proposedStateHash
    }, deps.fsImpl);
  } catch (error) {
    throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION', error);
  }
  return clone(nextState);
}

function atomicWrite(context, filename, content, options) {
  const { fsImpl, idFactory, allowReplace, errorCode } = options;
  const id = idFactory();
  if (typeof id !== 'string' || !TEMP_ID.test(id)) throw codedError('BLOCKED_INVALID_OPTIONS');
  const target = path.join(context.run.real, filename);
  const temporary = path.join(context.run.real, `.${filename}.${id}.tmp`);
  if (path.dirname(target) !== context.run.real || path.dirname(temporary) !== context.run.real) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  }
  assertIdentityChain(context.chain, fsImpl);
  const targetInfo = safeLstat(target, fsImpl);
  if (targetInfo?.isSymbolicLink() || targetInfo && !targetInfo.isFile()) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  }
  if (targetInfo && !allowReplace) throw codedError('BLOCKED_ARTIFACT_EXISTS');
  if (safeLstat(temporary, fsImpl)) throw codedError(errorCode);

  const bytes = Buffer.from(content, 'utf8');
  let descriptor;
  let temporarySnapshot;
  let targetReplaced = false;
  try {
    descriptor = fsImpl.openSync(temporary, 'wx');
    const openedTemporary = fsImpl.fstatSync(descriptor, { bigint: true });
    const pathTemporary = fsImpl.lstatSync(temporary, { bigint: true });
    if (!openedTemporary.isFile() || !sameIdentity(openedTemporary, pathTemporary)) {
      throw codedError('BLOCKED_UNSAFE_RUN_PATH');
    }
    temporarySnapshot = openedTemporary;
    fsImpl.writeFileSync(descriptor, bytes);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    assertIdentityChain(context.chain, fsImpl);
    const targetBeforeRename = safeLstat(target, fsImpl);
    if (targetBeforeRename?.isSymbolicLink() || targetBeforeRename && !targetBeforeRename.isFile()) {
      throw codedError('BLOCKED_UNSAFE_RUN_PATH');
    }
    if (targetBeforeRename && !allowReplace) throw codedError('BLOCKED_ARTIFACT_EXISTS');
    assertIdentityChain(context.chain, fsImpl);
    fsImpl.renameSync(temporary, target);
    targetReplaced = true;
    assertIdentityChain(context.chain, fsImpl);
    const finalBytes = readRegularFile(context, filename, fsImpl, true);
    return {
      sha256: crypto.createHash('sha256').update(finalBytes).digest('hex')
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch {
        // The caller still receives the primary bounded-write failure.
      }
    }
    if (temporarySnapshot) {
      try {
        assertIdentityChain(context.chain, fsImpl);
        const tempInfo = safeLstat(temporary, fsImpl);
        if (tempInfo && sameIdentity(temporarySnapshot, tempInfo)) {
          fsImpl.unlinkSync(temporary);
        }
      } catch {
        // Never unlink after the exact sibling or directory identity is lost.
      }
    }
    if (error?.code?.startsWith('BLOCKED_')) throw error;
    const wrapped = codedError(errorCode, error);
    wrapped.targetReplaced = targetReplaced;
    throw wrapped;
  }
}

function appendEvent(context, event, fsImpl, allowCreate = false) {
  const target = path.join(context.run.real, 'events.jsonl');
  assertIdentityChain(context.chain, fsImpl);
  const info = safeLstat(target, fsImpl);
  if (info?.isSymbolicLink() || info && !info.isFile() ||
      allowCreate && info || !allowCreate && !info) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  }
  let descriptor;
  try {
    descriptor = fsImpl.openSync(target, allowCreate ? 'ax' : 'a');
    const opened = fsImpl.fstatSync(descriptor, { bigint: true });
    const pathBefore = fsImpl.lstatSync(target, { bigint: true });
    if (!opened.isFile() || !sameIdentity(opened, pathBefore) ||
        info && !sameIdentity(info, opened)) {
      throw codedError('BLOCKED_UNSAFE_RUN_PATH');
    }
    fsImpl.appendFileSync(descriptor, `${JSON.stringify(event)}\n`, 'utf8');
    const after = fsImpl.fstatSync(descriptor, { bigint: true });
    const pathAfter = fsImpl.lstatSync(target, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(after, pathAfter)) {
      throw codedError('BLOCKED_UNSAFE_RUN_PATH');
    }
    assertIdentityChain(context.chain, fsImpl);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function validateHistory(state, events) {
  if (events.length === 0 || events[0].event !== 'run_created' || events[0].sequence !== 1) {
    throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
  }
  let committedHash = events[0].stateHash;
  let committedStatus = 'CREATED';
  let expectedSequence = 2;
  let index = 1;
  const artifactEvents = new Map();

  while (index < events.length) {
    const entry = events[index];
    if (entry.sequence !== expectedSequence) {
      throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
    }
    if (entry.event === 'artifact_written') {
      if (artifactEvents.has(entry.name)) {
        throw codedError('UNRESOLVED_UNTRACKED_ARTIFACT');
      }
      const stateUpdate = events[index + 1];
      if (!stateUpdate || stateUpdate.event !== 'transition_intent' ||
          stateUpdate.sequence !== expectedSequence + 1 ||
          stateUpdate.from !== committedStatus || stateUpdate.to !== committedStatus) {
        throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
      }
      artifactEvents.set(entry.name, entry.artifactHash);
      expectedSequence += 1;
      index += 1;
      continue;
    }
    if (entry.event !== 'transition_intent' || entry.from !== committedStatus ||
        entry.priorStateHash !== committedHash) {
      throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
    }
    const sameStatusUpdate = entry.from === entry.to;
    if ((!sameStatusUpdate && !TRANSITIONS.get(entry.from)?.has(entry.to)) ||
        sameStatusUpdate && (index === 1 || events[index - 1].event !== 'artifact_written')) {
      throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
    }
    const conclusion = events[index + 1];
    if (!conclusion || conclusion.sequence !== entry.sequence ||
        conclusion.from !== entry.from || conclusion.to !== entry.to) {
      throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
    }
    if (conclusion.event === 'transition_aborted') {
      throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
    }
    if (conclusion.event !== 'transition_committed' ||
        conclusion.finalStateHash !== entry.proposedStateHash) {
      throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
    }
    committedHash = conclusion.finalStateHash;
    committedStatus = conclusion.to;
    expectedSequence += 1;
    index += 2;
  }

  if (committedHash !== stateHash(state) || committedStatus !== state.status) {
    throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
  }
  const stateNames = Object.keys(state.artifactHashes);
  if (stateNames.length !== artifactEvents.size || stateNames.some((name) =>
    artifactEvents.get(name) !== state.artifactHashes[name])) {
    throw codedError('UNRESOLVED_UNTRACKED_ARTIFACT');
  }
}

function validateArtifacts(context, state, events, fsImpl, allowMutationLock = false) {
  let names;
  try {
    names = fsImpl.readdirSync(context.run.real);
  } catch (error) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH', error);
  }
  const folded = new Set();
  for (const name of names) {
    const normalized = name.toLowerCase();
    if (folded.has(normalized) ||
        !INTERNAL_FILES.has(name) && !(allowMutationLock && name === MUTATION_LOCK)) {
      throw codedError('UNRESOLVED_UNTRACKED_ARTIFACT');
    }
    folded.add(normalized);
  }

  const written = new Map(events.filter((entry) => entry.event === 'artifact_written')
    .map((entry) => [entry.name, entry.artifactHash]));
  for (const name of PAYLOAD_ARTIFACTS) {
    const target = path.join(context.run.real, name);
    const info = safeLstat(target, fsImpl);
    const recorded = state.artifactHashes[name];
    if (!info && recorded === undefined && !written.has(name)) continue;
    if (!info || recorded === undefined || written.get(name) !== recorded) {
      throw codedError('UNRESOLVED_UNTRACKED_ARTIFACT');
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw codedError('UNRESOLVED_TAMPERED_ARTIFACT');
    }
    let real;
    try {
      real = fsImpl.realpathSync(target);
    } catch (error) {
      throw codedError('UNRESOLVED_TAMPERED_ARTIFACT', error);
    }
    if (path.dirname(real) !== context.run.real || path.basename(real) !== name) {
      throw codedError('UNRESOLVED_TAMPERED_ARTIFACT');
    }
    const bytes = readRegularFile(context, name, fsImpl, true);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== recorded) throw codedError('UNRESOLVED_TAMPERED_ARTIFACT');
  }
}

function parseState(text, runId) {
  const state = JSON.parse(text);
  if (!isRecord(state) || !hasExactKeys(state, [
    'schemaVersion', 'runId', 'status', 'artifactHashes', 'updatedAt'
  ]) || state.schemaVersion !== STATE_SCHEMA || state.runId !== runId ||
      !STATUSES.has(state.status) || !validTimestamp(state.updatedAt) ||
      !isRecord(state.artifactHashes)) {
    throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
  }
  for (const [name, hash] of Object.entries(state.artifactHashes)) {
    if (!PAYLOAD_ARTIFACTS.has(name) || !SHA256.test(hash)) {
      throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
    }
  }
  return state;
}

function parseEvents(text, runId) {
  if (typeof text !== 'string' || text.length === 0 || !text.endsWith('\n')) {
    throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) {
    throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
  }
  return lines.map((line) => validateEvent(JSON.parse(line), runId));
}

function validateEvent(event, runId) {
  if (!isRecord(event) || event.schemaVersion !== EVENT_SCHEMA || event.runId !== runId ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      !validTimestamp(event.timestamp)) {
    throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
  }
  const common = ['schemaVersion', 'event', 'sequence', 'timestamp', 'runId'];
  if (event.event === 'run_created' && hasExactKeys(event, [...common, 'stateHash']) &&
      SHA256.test(event.stateHash)) return event;
  if (event.event === 'artifact_written' && hasExactKeys(event, [
    ...common, 'name', 'artifactHash'
  ]) && PAYLOAD_ARTIFACTS.has(event.name) && SHA256.test(event.artifactHash)) return event;
  if (['transition_intent', 'transition_aborted'].includes(event.event) &&
      hasExactKeys(event, [
        ...common, 'from', 'to', 'priorStateHash', 'proposedStateHash'
      ]) && STATUSES.has(event.from) && STATUSES.has(event.to) &&
      SHA256.test(event.priorStateHash) && SHA256.test(event.proposedStateHash)) return event;
  if (event.event === 'transition_committed' && hasExactKeys(event, [
    ...common, 'from', 'to', 'finalStateHash'
  ]) && STATUSES.has(event.from) && STATUSES.has(event.to) &&
      SHA256.test(event.finalStateHash)) return event;
  throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
}

function readRegularFile(context, filename, fsImpl, asBuffer = false) {
  const target = path.join(context.run.real, filename);
  assertIdentityChain(context.chain, fsImpl);
  const before = safeLstat(target, fsImpl);
  if (!before) throw codedError('UNRESOLVED_INCOMPLETE_TRANSITION');
  if (before.isSymbolicLink() || !before.isFile()) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  }
  let descriptor;
  try {
    descriptor = fsImpl.openSync(target, 'r');
    const opened = fsImpl.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw codedError('BLOCKED_UNSAFE_RUN_PATH');
    }
    const value = fsImpl.readFileSync(descriptor, asBuffer ? undefined : 'utf8');
    const after = fsImpl.fstatSync(descriptor, { bigint: true });
    const pathAfter = fsImpl.lstatSync(target, { bigint: true });
    if (!sameFileSnapshot(opened, after) || !sameFileSnapshot(after, pathAfter)) {
      throw codedError('BLOCKED_UNSAFE_RUN_PATH');
    }
    assertIdentityChain(context.chain, fsImpl);
    return value;
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function resolveRoot(rootDir, fsImpl) {
  if (typeof rootDir !== 'string' || rootDir.length === 0 || rootDir.includes('\0')) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  }
  const absolute = path.resolve(rootDir);
  const info = safeLstat(absolute, fsImpl);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  }
  let real;
  try {
    real = fsImpl.realpathSync(absolute);
  } catch (error) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH', error);
  }
  return { path: absolute, real, snapshot: info };
}

function ensureDirectory(parent, name, fsImpl) {
  assertIdentity(parent, fsImpl);
  const target = path.join(parent.real, name);
  let info = safeLstat(target, fsImpl);
  if (!info) {
    try {
      fsImpl.mkdirSync(target);
    } catch (error) {
      throw codedError('BLOCKED_UNSAFE_RUN_PATH', error);
    }
    info = safeLstat(target, fsImpl);
  }
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  }
  assertIdentity(parent, fsImpl);
  return resolveDirectChild(parent, target, fsImpl);
}

function resolveDirectChild(parent, target, fsImpl) {
  const info = safeLstat(target, fsImpl);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  }
  let real;
  try {
    real = fsImpl.realpathSync(target);
  } catch (error) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH', error);
  }
  if (path.dirname(real) !== parent.real) throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  return { path: target, real, snapshot: info };
}

function resolveRun(rootDir, runId, fsImpl) {
  const root = resolveRoot(rootDir, fsImpl);
  const data = existingDirectory(root, 'data', fsImpl);
  const runs = existingDirectory(data, 'path-runs', fsImpl);
  const run = existingDirectory(runs, runId, fsImpl);
  return makeContext(root, data, runs, run, runId);
}

function existingDirectory(parent, name, fsImpl) {
  assertIdentity(parent, fsImpl);
  return resolveDirectChild(parent, path.join(parent.real, name), fsImpl);
}

function makeContext(root, data, runs, run, runId) {
  return { root, data, runs, run, runId, chain: [root, data, runs, run] };
}

function assertIdentityChain(chain, fsImpl) {
  for (const entry of chain) assertIdentity(entry, fsImpl);
}

function assertIdentity(entry, fsImpl) {
  const current = safeLstat(entry.path, fsImpl);
  if (!current || current.isSymbolicLink() || !current.isDirectory() ||
      !sameIdentity(entry.snapshot, current)) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH');
  }
  let real;
  try {
    real = fsImpl.realpathSync(entry.path);
  } catch (error) {
    throw codedError('BLOCKED_UNSAFE_RUN_PATH', error);
  }
  if (real !== entry.real) throw codedError('BLOCKED_UNSAFE_RUN_PATH');
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameFileSnapshot(left, right) {
  return sameIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function safeLstat(target, fsImpl) {
  try {
    return fsImpl.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function dependencies(options) {
  const fsImpl = options.fsImpl ?? fs;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  if (!fsImpl || typeof now !== 'function' || typeof idFactory !== 'function') {
    throw codedError('BLOCKED_INVALID_OPTIONS');
  }
  return { fsImpl, now, idFactory };
}

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw codedError('BLOCKED_INVALID_OPTIONS');
  }
  return value.toISOString();
}

function stateHash(state) {
  return crypto.createHash('sha256').update(stableStringify(state), 'utf8').digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nextSequence(events) {
  return Math.max(...events.map((event) => event.sequence)) + 1;
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
    throw codedError('BLOCKED_INVALID_RUN_ID');
  }
}

function assertArtifactName(name) {
  if (typeof name !== 'string' || name.includes('\0') || path.isAbsolute(name) ||
      name.includes('/') || name.includes('\\') || name.includes(':') ||
      !PAYLOAD_ARTIFACTS.has(name)) {
    throw codedError('BLOCKED_INVALID_ARTIFACT_NAME');
  }
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function clone(value) {
  return structuredClone(value);
}

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}
