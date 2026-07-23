import fs from 'node:fs';
import path from 'node:path';
import { buildApprovalPacket } from './approval-packet.mjs';
import { appendAuditRecord } from './audit-ledger.mjs';

const DEFAULT_PATHS = {
  outboxPath: 'data/path-outbox.jsonl',
  auditPath: 'data/path-audit.jsonl'
};

export function gateOutbound(input, paths = DEFAULT_PATHS) {
  const packet = buildApprovalPacket(input);

  if (packet.tier === 'RED') {
    appendAuditRecord(paths.auditPath, {
      event: 'outbound_blocked',
      packetId: packet.id,
      tier: packet.tier,
      reasons: packet.reasons,
      recipient: packet.recipient
    });
    return { decision: 'BLOCK_RED', packet };
  }

  if (packet.tier === 'YELLOW') {
    fs.mkdirSync(path.dirname(paths.outboxPath), { recursive: true });
    fs.appendFileSync(paths.outboxPath, `${JSON.stringify(packet)}\n`, 'utf8');
    appendAuditRecord(paths.auditPath, {
      event: 'approval_packet_queued',
      packetId: packet.id,
      tier: packet.tier,
      recipient: packet.recipient
    });
    return { decision: 'QUEUE_FOR_APPROVAL', packet };
  }

  appendAuditRecord(paths.auditPath, {
    event: 'green_action_allowed',
    packetId: packet.id,
    tier: packet.tier,
    action: packet.action
  });
  return { decision: 'ALLOW_GREEN', packet };
}
