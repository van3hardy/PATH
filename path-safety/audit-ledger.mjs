import fs from 'node:fs';
import path from 'node:path';

export function appendAuditRecord(auditPath, record) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...record
  };

  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export function recordApprovalDecision(paths, decision) {
  const entry = {
    timestamp: new Date().toISOString(),
    packetId: decision.packetId,
    decision: decision.decision,
    decidedBy: decision.decidedBy
  };

  fs.mkdirSync(path.dirname(paths.approvalsPath), { recursive: true });
  fs.appendFileSync(paths.approvalsPath, `${JSON.stringify(entry)}\n`, 'utf8');

  appendAuditRecord(paths.auditPath, {
    event: 'approval_decision_recorded',
    packetId: decision.packetId,
    decision: decision.decision,
    decidedBy: decision.decidedBy
  });

  return entry;
}
