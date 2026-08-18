#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProvider, REAL_PROVIDER_IDS } from '../path-brain/provider-registry.mjs';
import { DEFAULT_MODEL, PROVIDER_IDS } from '../path-brain/provider-ids.mjs';

const USAGE = [
  'Usage: node scripts/path-run.mjs <request.json> --local-only',
  'MVP-1 writes a local review packet and never sends or submits.'
].join('\n');
const BRAIN_TIMEOUT_REAL_MS = 60 * 1000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

async function main(args) {
  if (args.length !== 2 || !args[0] || args[0].startsWith('--') ||
      args[1] !== '--local-only') {
    console.error(USAGE);
    return 2;
  }

  let pathIdentity;
  try {
    pathIdentity = verifyPathRoot();
  } catch {
    console.error('BLOCKED_INVALID_PATH_ROOT');
    return 2;
  }
  const { rootDir } = pathIdentity;

  let rawText;
  try {
    rawText = fs.readFileSync(path.resolve(args[0]), 'utf8');
  } catch {
    console.error('BLOCKED_REQUEST_UNREADABLE');
    return 2;
  }

  let rawRequest;
  try {
    rawRequest = JSON.parse(rawText);
  } catch {
    console.error('BLOCKED_INVALID_REQUEST_JSON');
    return 2;
  }

  if (!PROVIDER_IDS.includes(rawRequest?.provider)) {
    console.error('BLOCKED_UNSUPPORTED_PROVIDER');
    return 2;
  }

  let runRecruiterWorkflow;
  let provider;
  let brainTimeoutMs = 5000;
  try {
    const workflowModule = await import(
      new URL('../path-workflows/recruiter/recruiter-workflow.mjs', import.meta.url)
    );
    runRecruiterWorkflow = workflowModule.runRecruiterWorkflow;
    provider = await resolveProvider(rawRequest, rootDir);
    if (REAL_PROVIDER_IDS.includes(rawRequest.provider)) brainTimeoutMs = BRAIN_TIMEOUT_REAL_MS;
  } catch (error) {
    if (error?.code === 'BLOCKED_UNSUPPORTED_PROVIDER') {
      console.error('BLOCKED_UNSUPPORTED_PROVIDER');
      return 2;
    }
    console.error('FAILED_CLI');
    return 1;
  }

  try {
    revalidatePathIdentity(pathIdentity);
  } catch {
    console.error('BLOCKED_INVALID_PATH_ROOT');
    return 2;
  }

  try {
    const result = await runRecruiterWorkflow({
      rootDir,
      rawRequest,
      provider,
      brainTimeoutMs
    });
    console.log(JSON.stringify(result, null, 2));
    if (result?.resultCode === 'LOCAL_REVIEW_READY' && result?.status === 'HUMAN_REVIEW') {
      return 0;
    }
    if (['BLOCKED', 'FAILED', 'UNRESOLVED'].includes(result?.status)) return 1;
    return 1;
  } catch {
    console.error('FAILED_CLI');
    return 1;
  }
}

async function resolveProvider(rawRequest, rootDir) {
  const providerId = rawRequest.provider;
  if (!REAL_PROVIDER_IDS.includes(providerId)) {
    return getProvider(providerId);
  }
  const model = typeof process.env.GEMINI_MODEL === 'string' &&
    process.env.GEMINI_MODEL.trim().length > 0
    ? process.env.GEMINI_MODEL.trim()
    : DEFAULT_MODEL;
  const objective = rawRequest.objective ?? 'draft_first_touch';
  const runId = typeof rawRequest.runId === 'string' ? rawRequest.runId : null;

  const [{ createCapabilityApprovalAuthority, buildCapabilityIntent, approveCapability },
    { createJsonlReceiptSink }] = await Promise.all([
    import(new URL('../path-safety/capability-gateway.mjs', import.meta.url)),
    import(new URL('../path-safety/capability-receipts.mjs', import.meta.url))
  ]);

  const approvalAuthority = createCapabilityApprovalAuthority();
  const receiptSink = createJsonlReceiptSink(
    path.join(rootDir, 'data', 'path-capability-receipts.jsonl')
  );

  const intent = buildCapabilityIntent({
    capabilityId: 'model.invoke',
    actor: 'system',
    metadata: { runId, provider: providerId, model, objective },
    resources: [{ type: 'model', id: providerId }],
    approval: null
  });

  let approval = null;
  if (isRecord(rawRequest.requestApproval) &&
      typeof rawRequest.requestApproval.approvedAt === 'string') {
    approval = approveCapability(intent, {
      authority: approvalAuthority,
      source: 'human',
      approvedBy: 'Van',
      now: new Date(rawRequest.requestApproval.approvedAt),
      ttlMs: APPROVAL_TTL_MS
    });
  }

  return getProvider(providerId, {
    model,
    runId,
    objective,
    approvalAuthority,
    approval,
    receiptSink
  });
}

function verifyPathRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = fs.realpathSync(path.resolve(scriptDir, '..'));
  const packagePath = path.join(rootDir, 'package.json');
  const safetyPath = path.join(rootDir, 'path-safety');
  const sourcesPath = path.join(rootDir, 'docs', 'path', 'repo-sources.md');
  const root = snapshotEntry(rootDir, 'directory');
  const packageRead = readSnapshotBoundFile(packagePath);
  const safety = snapshotEntry(safetyPath, 'directory');
  const sources = snapshotEntry(sourcesPath, 'file');
  const packageInfo = JSON.parse(packageRead.text);
  if (packageInfo?.name !== 'path') {
    throw new Error('invalid Path identity');
  }
  const identity = {
    rootDir,
    entries: [root, packageRead.entry, safety, sources]
  };
  revalidatePathIdentity(identity);
  return identity;
}

function readSnapshotBoundFile(target) {
  const before = snapshotEntry(target, 'file');
  let descriptor;
  try {
    descriptor = fs.openSync(target, 'r');
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before.info, opened)) {
      throw new Error('identity changed before package read');
    }
    const text = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(target, { bigint: true });
    if (!sameFileSnapshot(opened, after) || !sameFileSnapshot(after, pathAfter) ||
        fs.realpathSync(target) !== before.real) {
      throw new Error('identity changed during package read');
    }
    return {
      text,
      entry: { ...before, info: pathAfter }
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function snapshotEntry(target, type) {
  const info = fs.lstatSync(target, { bigint: true });
  const validType = type === 'directory' ? info.isDirectory() : info.isFile();
  if (info.isSymbolicLink() || !validType) throw new Error('invalid identity entry');
  return { target, type, real: fs.realpathSync(target), info };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function revalidatePathIdentity(identity) {
  for (const expected of identity.entries) {
    const current = snapshotEntry(expected.target, expected.type);
    const unchanged = expected.type === 'file'
      ? sameFileSnapshot(expected.info, current.info)
      : sameIdentity(expected.info, current.info);
    if (!unchanged || current.real !== expected.real) {
      throw new Error('Path identity changed');
    }
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameFileSnapshot(left, right) {
  return sameIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

process.exitCode = await main(process.argv.slice(2));
