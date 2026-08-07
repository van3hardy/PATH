/**
 * Server-side capability gateway adapter for the Path web app.
 *
 * Delegates to the root `path-safety/capability-gateway.mjs` (single source of
 * truth for the catalog + decision engine) and stores receipts below
 * `.career-ops-web/capability-receipts.jsonl`.
 *
 * Designed to be imported by Next.js API route handlers (server-side only).
 * The root gateway modules are loaded once via dynamic import and cached.
 */
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

function resolveRoot() {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  if (env) return env;
  // Walk up from this module's directory until the repo root
  // (identifiable by path-safety/capability-gateway.mjs) is found.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(path.join(dir, 'path-safety', 'capability-gateway.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), '..');
}

const ROOT = resolveRoot();
const GATEWAY_URL = pathToFileURL(path.join(ROOT, 'path-safety', 'capability-gateway.mjs')).href;
const RECEIPTS_URL = pathToFileURL(path.join(ROOT, 'path-safety', 'capability-receipts.mjs')).href;
const PACKET_URL = pathToFileURL(path.join(ROOT, 'path-safety', 'packet-integrity.mjs')).href;

let _gateway = null;
let _authority = null;
let _receipts = null;
let _packet = null;

async function loadGateway() {
  if (!_gateway) {
    const mod = await import(GATEWAY_URL);
    _gateway = mod;
    _authority = mod.createCapabilityApprovalAuthority();
  }
  if (!_receipts) {
    _receipts = await import(RECEIPTS_URL);
  }
  if (!_packet) {
    _packet = await import(PACKET_URL);
  }
  return { gateway: _gateway, authority: _authority, receipts: _receipts, packet: _packet };
}

export function getReceiptPath() {
  const dir = path.join(ROOT, '.career-ops-web');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'capability-receipts.jsonl');
}

export function getRoot() {
  return ROOT;
}

/**
 * Evaluate a web capability request against the root gateway.
 *
 * @param {string} capabilityId - Catalog capability ID (e.g. 'model.invoke')
 * @param {string} actor - 'agent' or 'direct_user'
 * @param {object} metadata - Normalized metadata (adapter ID, locality, etc.)
 * @param {Array<{type:string,id:string,destination?:string}>} resources
 * @param {object|null} [approval] - Optional approval object from the client
 * @returns {{decision:string,code:string,scopeHash:string|null,httpStatus:number}}
 */
export async function authorizeWebCapability(capabilityId, actor, metadata, resources, approval = null) {
  const { gateway, authority } = await loadGateway();
  const intent = gateway.buildCapabilityIntent({
    capabilityId,
    actor,
    metadata: metadata || {},
    resources,
    approval,
  });
  const evaluation = gateway.evaluateCapability(intent, { approvalAuthority: authority });
  let httpStatus;
  if (evaluation.decision === 'DENY') httpStatus = 403;
  else if (evaluation.decision === 'REQUIRE_APPROVAL') httpStatus = 409;
  else httpStatus = 200;
  return {
    decision: evaluation.decision,
    code: evaluation.code,
    scopeHash: evaluation.scopeHash,
    httpStatus,
  };
}

/**
 * Create a server-side approval for a web capability.
 * Used for: direct UI gestures (source = 'direct_ui'), or to pre-approve
 * an agent-originated call before the human confirms.
 */
export async function approveWebCapability(
  capabilityId, actor, metadata, resources,
  approvedBy, source = 'human', ttlMs = 5 * 60 * 1000,
) {
  const { gateway, authority } = await loadGateway();
  const intent = gateway.buildCapabilityIntent({
    capabilityId,
    actor,
    metadata: metadata || {},
    resources,
    approval: null,
  });
  return gateway.approveCapability(intent, { authority, source, approvedBy, ttlMs });
}

/**
 * Execute a web capability operation with gateway enforcement and receipt recording.
 * Throws if the capability is not ALLOWED (e.g. no approval, expired, consumed).
 */
export async function executeWebCapability(
  capabilityId, actor, metadata, resources,
  operation, approval, receiptPathOpt,
) {
  const { gateway, authority, receipts } = await loadGateway();
  const receiptPath = receiptPathOpt || getReceiptPath();
  const sink = receipts.createJsonlReceiptSink(receiptPath);
  const result = await gateway.executeCapability(
    { capabilityId, actor, metadata: metadata || {}, resources, approval },
    operation,
    { receiptSink: sink, approvalAuthority: authority },
  );
  if (!result.executed) {
    const err = new Error(`Capability not executed: ${result.code}`);
    err.code = result.code;
    err.decision = result.decision;
    err.scopeHash = result.scopeHash;
    throw err;
  }
  return result.result;
}

/**
 * Record a terminal receipt for a streaming operation that has already been
 * authorized and is now completing (succeeded or failed).
 *
 * Used by streaming API routes (assistant, run, explore/ai, cv/ingest, apply/drive,
 * apply/prefill) that cannot fully wrap their operation in executeWebCapability
 * because the Response stream is returned immediately while the child process
 * runs in the background.
 */
export async function recordTerminalReceipt(
  capabilityId, actor, metadata, resources, approval,
  outcome = 'succeeded', now = new Date(), receiptPathOpt,
) {
  const { gateway, authority, receipts, packet } = await loadGateway();
  const intent = gateway.buildCapabilityIntent({
    capabilityId,
    actor,
    metadata: metadata || {},
    resources,
    approval,
  });
  const evaluation = gateway.evaluateCapability(
    intent, { approvalAuthority: authority, now },
  );
  const receipt = {
    timestamp: now.toISOString(),
    event: outcome === 'succeeded' ? 'capability_succeeded' : 'capability_failed',
    capabilityId,
    scopeHash: evaluation.scopeHash,
    decision: evaluation.decision,
    code: evaluation.code,
    metadataHash: packet.sha256Hex(packet.stableStringify(intent.metadata)),
    resourcesHash: packet.sha256Hex(packet.stableStringify(intent.resources)),
    approvalSource: intent.approval?.source ?? null,
    outcomeHash: packet.sha256Hex(packet.stableStringify({ status: outcome })),
  };
  const sink = receipts.createJsonlReceiptSink(receiptPathOpt || getReceiptPath());
  await sink(receipt);
}

/**
 * Authorizer helper for API routes: authorizes a capability for a direct UI
 * gesture, auto-creating a direct_ui approval. Returns { decision, code,
 * scopeHash, approval }.
 *
 * For routes that want to accept client-supplied approvals (agent-initiated
 * calls), call authorizeWebCapability directly with the approval from the
 * request body.
 */
export async function authorizeDirectUiGesture(capabilityId, metadata, resources) {
  const { gateway, authority } = await loadGateway();
  const intentNoApproval = gateway.buildCapabilityIntent({
    capabilityId,
    actor: 'direct_user',
    metadata: metadata || {},
    resources,
    approval: null,
  });
  const approval = gateway.approveCapability(intentNoApproval, {
    authority,
    source: 'direct_ui',
    approvedBy: 'web-ui-direct-gesture',
    ttlMs: 5 * 60 * 1000,
  });
  // Rebuild intent WITH the approval so evaluateCapability sees it.
  const intent = gateway.buildCapabilityIntent({
    capabilityId,
    actor: 'direct_user',
    metadata: metadata || {},
    resources,
    approval,
  });
  const evaluation = gateway.evaluateCapability(intent, { approvalAuthority: authority });
  return {
    decision: evaluation.decision,
    code: evaluation.code,
    scopeHash: evaluation.scopeHash,
    approval,
  };
}
