import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordApprovalDecision } from '../../path-safety/audit-ledger.mjs';

test('approval decision appends approval and audit records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-approval-'));
  const paths = {
    approvalsPath: path.join(dir, 'approvals.jsonl'),
    auditPath: path.join(dir, 'audit.jsonl')
  };

  const result = recordApprovalDecision(paths, {
    packetId: 'abc123',
    decision: 'APPROVED',
    decidedBy: 'Van'
  });

  assert.equal(result.packetId, 'abc123');
  assert.equal(result.decision, 'APPROVED');
  assert.match(fs.readFileSync(paths.approvalsPath, 'utf8'), /APPROVED/);
  assert.match(fs.readFileSync(paths.auditPath, 'utf8'), /approval_decision_recorded/);
});
