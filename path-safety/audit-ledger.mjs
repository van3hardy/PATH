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
