#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractContacts } from '../followup-cadence.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import {
  loadContacts as loadContactsLedger,
  findPersonByEmail,
  markContactedFromBackfill
} from '../path-safety/contacts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS_FILE = path.join(ROOT, 'data', 'applications.md');
const OUTBOX_FILE = path.join(ROOT, 'data', 'path-outbox.jsonl');
const DISPATCH_FILE = path.join(ROOT, 'data', 'path-dispatch.jsonl');
const CONTACTS_FILE = process.env.PATH_CONTACTS_FILE || path.join(ROOT, 'data', 'contacts.jsonl');

function readRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, colmap)).filter(Boolean);
}

function readRecipients(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((entry) => entry && entry.recipient && typeof entry.recipient.address === 'string');
}

export function seed() {
  const ledger = loadContactsLedger(CONTACTS_FILE);
  let contacts = 0;
  let events = 0;

  // Existing ledger (last line per id) is the protected baseline.
  for (const row of readRows(APPS_FILE)) {
    for (const contact of extractContacts(row.notes ?? '')) {
      const email = contact?.email;
      if (!email) continue; // name-only contacts can't be deduped — skip silently
      if (findPersonByEmail(ledger, email)) continue; // idempotent
      markContactedFromBackfill(CONTACTS_FILE, {
        name: contact.name ?? row.company ?? null,
        email,
        channel: contact.channel ?? 'email',
        at: row.date ? `${row.date}T00:00:00.000Z` : undefined,
        applicationId: row.num ?? null
      });
      contacts += 1;
    }
  }

  for (const file of [OUTBOX_FILE, DISPATCH_FILE]) {
    for (const entry of readRecipients(file)) {
      const email = entry.recipient.address;
      if (findPersonByEmail(ledger, email)) continue; // idempotent
      markContactedFromBackfill(CONTACTS_FILE, {
        name: entry.recipient.name ?? null,
        email,
        channel: 'email',
        at: entry.createdAt ?? entry.timestamp,
        applicationId: null
      });
      events += 1;
    }
  }

  console.log(`Backfill complete: ${contacts} contacts from applications, ${events} from outbox/dispatch.`);
  return { contacts, events };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    seed();
  } catch (error) {
    console.error(error?.code ?? error?.message ?? String(error));
    process.exit(1); // corrupt ledger / schema is a real failure; absent sources are not
  }
}