import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendAuditRecord } from '../../path-safety/audit-ledger.mjs';

test('appendAuditRecord writes one JSONL record with timestamp', () => {
  const auditPath = path.join(os.tmpdir(), `path-audit-${Date.now()}.jsonl`);
  const record = appendAuditRecord(auditPath, {
    event: 'approval_packet_created',
    tier: 'YELLOW',
    recipient: 'hm@example.com'
  });

  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, 'approval_packet_created');
  assert.equal(parsed.tier, 'YELLOW');
  assert.equal(parsed.recipient, 'hm@example.com');
  assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(record.event, 'approval_packet_created');
});
