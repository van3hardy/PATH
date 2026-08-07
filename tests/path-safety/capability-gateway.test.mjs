import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getCapability,
  pluginCapabilityId
} from '../../path-safety/capability-catalog.mjs';
import {
  approveCapability,
  buildCapabilityIntent,
  createCapabilityApprovalAuthority,
  evaluateCapability,
  executeCapability
} from '../../path-safety/capability-gateway.mjs';
import {
  createJsonlReceiptSink,
  verifyCapabilityReceipts
} from '../../path-safety/capability-receipts.mjs';
import { sha256Hex, stableStringify } from '../../path-safety/packet-integrity.mjs';

const NOW = new Date('2026-08-01T16:00:00.000Z');

function localReadIntent(overrides = {}) {
  return buildCapabilityIntent({
    capabilityId: 'local.read',
    actor: 'agent',
    metadata: { purpose: 'read project configuration' },
    resources: [{ type: 'local', id: 'project-config' }],
    approval: null,
    ...overrides
  });
}

function externalReadIntent(overrides = {}) {
  return buildCapabilityIntent({
    capabilityId: 'external.read',
    actor: 'agent',
    metadata: { adapterId: 'fixture', locality: 'external' },
    resources: [{ type: 'external', id: 'job-posting', destination: 'example.test' }],
    approval: null,
    ...overrides
  });
}

function tempReceiptPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-capability-'));
  return path.join(dir, 'receipts.jsonl');
}

function receiptFixture(capabilityId = 'local.read') {
  return {
    timestamp: NOW.toISOString(),
    event: 'capability_attempted',
    capabilityId,
    scopeHash: 'a'.repeat(64),
    decision: 'ALLOW',
    code: 'ALLOW_LOCAL_READ',
    metadataHash: 'b'.repeat(64),
    resourcesHash: 'c'.repeat(64),
    approvalSource: null,
    outcomeHash: null
  };
}

test('catalog entries and plugin capability IDs are closed and frozen', () => {
  const localRead = getCapability('local.read');
  assert.equal(localRead.id, 'local.read');
  assert.deepEqual(localRead.effects, ['read']);
  assert.equal(Object.isFrozen(localRead), true);
  assert.equal(Object.isFrozen(localRead.effects), true);

  assert.equal(pluginCapabilityId('notion-sync', 'search'), 'plugin.notion-sync.search');
  assert.equal(getCapability('plugin.notion-sync.search').id, 'plugin.notion-sync.search');
  assert.equal(Object.isFrozen(getCapability('plugin.notion-sync.search')), true);
  assert.equal(pluginCapabilityId('../notion', 'search'), null);
  assert.equal(pluginCapabilityId('notion', 'submit'), null);
  assert.equal(getCapability('plugin.notion.submit'), null);
  assert.equal(getCapability('unknown.capability'), null);
});

test('local-only reads are allowed without approval', () => {
  const result = evaluateCapability(localReadIntent(), { now: NOW });
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.code, 'ALLOW_LOCAL_READ');
  assert.match(result.scopeHash, /^[a-f0-9]{64}$/);
  assert.equal(result.capability.id, 'local.read');
});

test('unknown capability, unknown fields, malformed resources, and browser submit fail closed', () => {
  const unknown = externalReadIntent({ capabilityId: 'invented.power' });
  assert.equal(evaluateCapability(unknown, { now: NOW }).decision, 'DENY');
  assert.equal(evaluateCapability(unknown, { now: NOW }).code, 'DENY_UNKNOWN_CAPABILITY');

  assert.throws(() => buildCapabilityIntent({
    capabilityId: 'local.read',
    actor: 'agent',
    metadata: {},
    resources: [{ type: 'local', id: 'project-config' }],
    approval: null,
    invented: true
  }), { code: 'INVALID_CAPABILITY_INTENT' });

  const unknownFieldIntent = { ...localReadIntent(), invented: true };
  assert.equal(evaluateCapability(unknownFieldIntent, { now: NOW }).code, 'DENY_INVALID_INTENT');

  assert.throws(() => buildCapabilityIntent({
    capabilityId: 'local.read',
    actor: 'agent',
    metadata: {},
    resources: [{ type: 'local', id: 'project-config', payload: 'not allowed' }],
    approval: null
  }), { code: 'INVALID_CAPABILITY_INTENT' });

  const submit = buildCapabilityIntent({
    capabilityId: 'browser.submit',
    actor: 'direct_user',
    metadata: { hostname: 'example.test' },
    resources: [{ type: 'external', id: 'application-form', destination: 'example.test' }],
    approval: null
  });
  assert.equal(evaluateCapability(submit, { now: NOW }).decision, 'DENY');
  assert.equal(evaluateCapability(submit, { now: NOW }).code, 'DENY_PROHIBITED_CAPABILITY');
});

test('approval binds the exact normalized intent, human source, and expiry', () => {
  const approvalAuthority = createCapabilityApprovalAuthority();
  const intent = externalReadIntent({
    metadata: { locality: 'external', adapterId: 'fixture' }
  });
  const first = evaluateCapability(intent, { now: NOW });
  assert.equal(first.decision, 'REQUIRE_APPROVAL');
  assert.equal(first.code, 'REQUIRE_HUMAN_APPROVAL');

  const approval = approveCapability(intent, {
    authority: approvalAuthority,
    source: 'human',
    approvedBy: 'Van',
    now: NOW,
    ttlMs: 60_000
  });
  const approvedIntent = buildCapabilityIntent({ ...intent, approval });
  const allowed = evaluateCapability(approvedIntent, {
    now: new Date('2026-08-01T16:00:30.000Z'),
    approvalAuthority
  });
  assert.equal(allowed.decision, 'ALLOW');
  assert.equal(allowed.code, 'ALLOW_APPROVED');
  assert.equal(allowed.scopeHash, first.scopeHash);

  const changed = buildCapabilityIntent({
    ...intent,
    metadata: { adapterId: 'different', locality: 'external' },
    approval
  });
  assert.equal(evaluateCapability(changed, { now: NOW, approvalAuthority }).code,
    'REQUIRE_SCOPE_APPROVAL');
  assert.equal(evaluateCapability(approvedIntent, {
    now: new Date('2026-08-01T16:01:00.001Z'),
    approvalAuthority
  }).code, 'REQUIRE_FRESH_APPROVAL');

  const directApproval = approveCapability(intent, {
    authority: approvalAuthority,
    source: 'direct_cli',
    approvedBy: 'Van',
    now: NOW,
    ttlMs: 60_000
  });
  assert.equal(evaluateCapability(buildCapabilityIntent({
    ...intent,
    approval: directApproval
  }), { now: NOW, approvalAuthority }).code, 'REQUIRE_HUMAN_APPROVAL');
});

test('direct-user approval is bound to the exact direct call', () => {
  const approvalAuthority = createCapabilityApprovalAuthority();
  const intent = externalReadIntent({ actor: 'direct_user' });
  const approval = approveCapability(intent, {
    authority: approvalAuthority,
    source: 'direct_cli',
    approvedBy: 'Van',
    now: NOW,
    ttlMs: 60_000
  });
  assert.equal(evaluateCapability(buildCapabilityIntent({
    ...intent,
    approval
  }), { now: NOW, approvalAuthority }).code, 'ALLOW_APPROVED');
});

test('approvals require their opaque issuer, reject self-attestation, and carry unique IDs', () => {
  const authority = createCapabilityApprovalAuthority();
  const otherAuthority = createCapabilityApprovalAuthority();
  const intent = externalReadIntent();
  const first = approveCapability(intent, {
    authority, source: 'human', approvedBy: 'Van', now: NOW, ttlMs: 60_000
  });
  const second = approveCapability(intent, {
    authority, source: 'human', approvedBy: 'Van', now: NOW, ttlMs: 60_000
  });
  assert.notEqual(first.approvalId, second.approvalId);

  const approved = buildCapabilityIntent({ ...intent, approval: first });
  assert.equal(evaluateCapability(approved, { now: NOW }).code,
    'REQUIRE_TRUSTED_APPROVAL');
  assert.equal(evaluateCapability(approved, { now: NOW, approvalAuthority: otherAuthority }).code,
    'REQUIRE_TRUSTED_APPROVAL');

  const selfAttested = buildCapabilityIntent({
    ...intent,
    approval: { ...first, approvalId: 'f'.repeat(32) }
  });
  assert.equal(evaluateCapability(selfAttested, { now: NOW, approvalAuthority: authority }).code,
    'REQUIRE_TRUSTED_APPROVAL');
});

test('received approvals enforce maximum TTL and exact expiry is excluded', () => {
  const approvalAuthority = createCapabilityApprovalAuthority();
  const intent = externalReadIntent();
  const approval = approveCapability(intent, {
    authority: approvalAuthority,
    source: 'human', approvedBy: 'Van', now: NOW, ttlMs: 60_000
  });
  const overlong = buildCapabilityIntent({
    ...intent,
    approval: {
      ...approval,
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1).toISOString()
    }
  });
  assert.equal(evaluateCapability(overlong, { now: NOW, approvalAuthority }).code,
    'REQUIRE_VALID_APPROVAL_TTL');

  const approved = buildCapabilityIntent({ ...intent, approval });
  assert.equal(evaluateCapability(approved, {
    now: new Date(NOW.getTime() + 60_000), approvalAuthority
  }).code, 'REQUIRE_FRESH_APPROVAL');
});

test('system configuration approval is allowed while source policy remains actor-bound', () => {
  const approvalAuthority = createCapabilityApprovalAuthority();
  const intent = externalReadIntent({ actor: 'system' });
  const approval = approveCapability(intent, {
    authority: approvalAuthority,
    source: 'configuration', approvedBy: 'Van', now: NOW, ttlMs: 60_000
  });
  assert.equal(evaluateCapability(buildCapabilityIntent({ ...intent, approval }), {
    now: NOW, approvalAuthority
  }).code, 'ALLOW_APPROVED');
});

test('normalized metadata safely binds collision keys and is recursively frozen', () => {
  const metadata = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"ctor","prototype":"proto",' +
    '"nested":{"__proto__":"nested-value"}}'
  );
  const intent = localReadIntent({ metadata });
  const withoutCollisionKeys = localReadIntent({ metadata: { nested: {} } });

  assert.equal(Object.getPrototypeOf(intent.metadata), null);
  assert.equal(Object.hasOwn(intent.metadata, '__proto__'), true);
  assert.equal(Object.hasOwn(intent.metadata, 'constructor'), true);
  assert.equal(Object.hasOwn(intent.metadata, 'prototype'), true);
  assert.equal(Object.isFrozen(intent.metadata), true);
  assert.equal(Object.isFrozen(intent.metadata.__proto__), true);
  assert.equal(Object.isFrozen(intent.metadata.nested), true);
  assert.notEqual(
    evaluateCapability(intent, { now: NOW }).scopeHash,
    evaluateCapability(withoutCollisionKeys, { now: NOW }).scopeHash
  );
  assert.equal({}.polluted, undefined);
});

test('effect-specific resource requirements reject local-only plugin and wrong resource classes', () => {
  const localPlugin = buildCapabilityIntent({
    capabilityId: pluginCapabilityId('notion', 'search'),
    actor: 'agent',
    metadata: {},
    resources: [{ type: 'local', id: 'cache' }],
    approval: null
  });
  assert.equal(evaluateCapability(localPlugin, { now: NOW }).code,
    'DENY_INVALID_RESOURCE_SCOPE');

  assert.throws(() => buildCapabilityIntent({
    capabilityId: pluginCapabilityId('notion', 'search'),
    actor: 'agent',
    metadata: {},
    resources: [{ type: 'external', id: 'account' }],
    approval: null
  }), { code: 'INVALID_CAPABILITY_INTENT' });

  for (const [capabilityId, resource] of [
    ['local.write', { type: 'external', id: 'file', destination: 'example.test' }],
    ['model.invoke', { type: 'local', id: 'adapter' }]
  ]) {
    const intent = buildCapabilityIntent({
      capabilityId, actor: 'agent', metadata: {}, resources: [resource], approval: null
    });
    assert.equal(evaluateCapability(intent, { now: NOW }).code,
      'DENY_INVALID_RESOURCE_SCOPE');
  }
});

test('denied and unapproved operations are never called and receive terminal receipts', async () => {
  for (const intent of [
    externalReadIntent(),
    buildCapabilityIntent({
      capabilityId: 'browser.submit',
      actor: 'direct_user',
      metadata: {},
      resources: [{ type: 'external', id: 'application-form', destination: 'example.test' }],
      approval: null
    })
  ]) {
    let calls = 0;
    const receipts = [];
    const result = await executeCapability(intent, async () => {
      calls += 1;
    }, {
      now: () => NOW,
      receiptSink: (receipt) => receipts.push(receipt)
    });
    assert.equal(calls, 0);
    assert.equal(result.executed, false);
    assert.deepEqual(receipts.map((receipt) => receipt.event), [
      'capability_attempted',
      result.decision === 'DENY' ? 'capability_denied' : 'capability_approval_required'
    ]);
  }
});

test('an approved operation runs exactly once and records success', async () => {
  const approvalAuthority = createCapabilityApprovalAuthority();
  const intent = externalReadIntent();
  const approval = approveCapability(intent, {
    authority: approvalAuthority,
    source: 'human', approvedBy: 'Van', now: NOW, ttlMs: 60_000
  });
  let calls = 0;
  const receipts = [];
  const result = await executeCapability(buildCapabilityIntent({ ...intent, approval }), async () => {
    calls += 1;
    return { count: 3 };
  }, {
    now: () => NOW,
    approvalAuthority,
    receiptSink: (receipt) => receipts.push(receipt)
  });

  assert.equal(calls, 1);
  assert.equal(result.executed, true);
  assert.deepEqual(result.result, { count: 3 });
  assert.deepEqual(receipts.map((receipt) => receipt.event), [
    'capability_attempted', 'capability_succeeded'
  ]);
});

test('approved execution consumes approval once before the consequential operation', async () => {
  const approvalAuthority = createCapabilityApprovalAuthority();
  const intent = externalReadIntent();
  const approval = approveCapability(intent, {
    authority: approvalAuthority,
    source: 'human', approvedBy: 'Van', now: NOW, ttlMs: 60_000
  });
  const approved = buildCapabilityIntent({ ...intent, approval });
  let calls = 0;
  const receiptSink = () => {};
  const first = await executeCapability(approved, async () => {
    calls += 1;
  }, { now: () => NOW, receiptSink, approvalAuthority });
  const replay = await executeCapability(approved, async () => {
    calls += 1;
  }, { now: () => NOW, receiptSink, approvalAuthority });

  assert.equal(first.executed, true);
  assert.equal(replay.executed, false);
  assert.equal(replay.code, 'REQUIRE_UNUSED_APPROVAL');
  assert.equal(calls, 1);
});

test('a thrown operation records a failed terminal receipt and rethrows', async () => {
  const receipts = [];
  await assert.rejects(() => executeCapability(localReadIntent(), async () => {
    throw new Error('fixture operation failed');
  }, {
    now: () => NOW,
    receiptSink: (receipt) => receipts.push(receipt)
  }), /fixture operation failed/);
  assert.deepEqual(receipts.map((receipt) => receipt.event), [
    'capability_attempted', 'capability_failed'
  ]);
  assert.match(receipts[1].outcomeHash, /^[a-f0-9]{64}$/);
});

test('success receipt failure reports unresolved outcome without recording operation failure', async () => {
  let calls = 0;
  let receiptCalls = 0;
  await assert.rejects(() => executeCapability(localReadIntent(), async () => {
    calls += 1;
    return 'completed';
  }, {
    now: () => NOW,
    receiptSink: () => {
      receiptCalls += 1;
      if (receiptCalls === 2) throw Object.assign(new Error('receipt unavailable'), {
        code: 'FAILED_CAPABILITY_RECEIPT_WRITE'
      });
    }
  }), { code: 'CAPABILITY_OUTCOME_UNRESOLVED' });
  assert.equal(calls, 1);
  assert.equal(receiptCalls, 2);
});

test('operation error is preserved when the failed terminal receipt also fails', async () => {
  const operationError = new Error('operation root cause');
  let receiptCalls = 0;
  let caught;
  try {
    await executeCapability(localReadIntent(), async () => {
      throw operationError;
    }, {
      now: () => NOW,
      receiptSink: () => {
        receiptCalls += 1;
        if (receiptCalls === 2) throw Object.assign(new Error('receipt unavailable'), {
          code: 'FAILED_CAPABILITY_RECEIPT_WRITE'
        });
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, operationError);
  assert.equal(caught.receiptError.code, 'FAILED_CAPABILITY_RECEIPT_WRITE');
  assert.equal(receiptCalls, 2);
});

test('receipt sink fails closed on a held lock and removes owned locks after failure', () => {
  const receiptPath = tempReceiptPath();
  const lockPath = `${receiptPath}.lock`;
  fs.writeFileSync(lockPath, 'held by fixture', 'utf8');
  try {
    assert.throws(() => createJsonlReceiptSink(receiptPath)(receiptFixture()), {
      code: 'FAILED_CAPABILITY_RECEIPT_LOCKED'
    });
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.unlinkSync(lockPath);
  }

  fs.writeFileSync(receiptPath, '{malformed\n', 'utf8');
  assert.throws(() => createJsonlReceiptSink(receiptPath)(receiptFixture()), {
    code: 'FAILED_CAPABILITY_RECEIPT_MALFORMED'
  });
  assert.equal(fs.existsSync(lockPath), false);
});

test('concurrent processes serialize receipt sequence and hash-chain append', async () => {
  const receiptPath = tempReceiptPath();
  const moduleUrl = new URL('../../path-safety/capability-receipts.mjs', import.meta.url).href;
  const script = `
    import { createJsonlReceiptSink } from ${JSON.stringify(moduleUrl)};
    const [receiptPath, capabilityId] = process.argv.slice(1);
    createJsonlReceiptSink(receiptPath)({
      timestamp: '2026-08-01T16:00:00.000Z', event: 'capability_attempted',
      capabilityId, scopeHash: 'a'.repeat(64), decision: 'ALLOW',
      code: 'ALLOW_LOCAL_READ', metadataHash: 'b'.repeat(64),
      resourcesHash: 'c'.repeat(64), approvalSource: null, outcomeHash: null
    });
  `;
  const children = Array.from({ length: 4 }, (_, index) => spawn(process.execPath, [
    '--input-type=module', '--eval', script, receiptPath, `local.read.${index}`
  ], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const results = await Promise.all(children.map(async (child) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return { code, stderr };
  }));
  assert.deepEqual(results, Array.from({ length: 4 }, () => ({ code: 0, stderr: '' })));
  const verification = verifyCapabilityReceipts(receiptPath);
  assert.equal(verification.ok, true);
  assert.equal(verification.recordCount, 4);
});

test('JSONL receipts are hash-chained, verifiable, and exclude raw metadata and resources', async () => {
  const receiptPath = tempReceiptPath();
  const secret = 'TOKEN-do-not-record';
  const payload = 'CV-payload-do-not-record';
  const intent = localReadIntent({
    metadata: { secret, nested: { payload } },
    resources: [{ type: 'local', id: payload }]
  });
  await executeCapability(intent, async () => 'sensitive operation result', {
    now: () => NOW,
    receiptSink: createJsonlReceiptSink(receiptPath)
  });

  const raw = fs.readFileSync(receiptPath, 'utf8');
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes(payload), false);
  assert.equal(raw.includes('sensitive operation result'), false);
  const entries = raw.trim().split('\n').map(JSON.parse);
  assert.equal(entries[0].previousHash, 'GENESIS');
  assert.equal(entries[1].previousHash, entries[0].recordHash);
  assert.deepEqual(verifyCapabilityReceipts(receiptPath), {
    ok: true,
    code: 'CAPABILITY_RECEIPTS_OK',
    recordCount: 2,
    lastRecordHash: entries[1].recordHash
  });

  const brokenChain = structuredClone(entries);
  brokenChain[1].previousHash = 'f'.repeat(64);
  const { recordHash: ignored, ...withoutHash } = brokenChain[1];
  brokenChain[1].recordHash = sha256Hex(stableStringify(withoutHash));
  fs.writeFileSync(receiptPath, `${brokenChain.map(JSON.stringify).join('\n')}\n`, 'utf8');
  assert.deepEqual(verifyCapabilityReceipts(receiptPath), {
    ok: false,
    code: 'FAILED_CAPABILITY_RECEIPT_CHAIN',
    recordIndex: 1
  });

  entries[0].decision = 'TAMPERED';
  fs.writeFileSync(receiptPath, `${entries.map(JSON.stringify).join('\n')}\n`, 'utf8');
  assert.deepEqual(verifyCapabilityReceipts(receiptPath), {
    ok: false,
    code: 'FAILED_CAPABILITY_RECEIPT_HASH',
    recordIndex: 0
  });
});
