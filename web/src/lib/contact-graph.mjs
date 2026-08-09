/**
 * Contact-graph read model — pure parser shared by the web API surface
 * (web/src/app/api/contacts/route.ts). Imported directly by tests the same way
 * clean-chips.mjs is: no Next, no fs, just JSONL -> records.
 *
 * data/contacts.jsonl is write-once append-only; replaying it (last line per
 * contactId wins) is the ONLY correct reconstruction and matches the core
 * loader loadContacts(), so the web and CLI can never agree on different
 * people. Tolerant by construction: empty input -> [], and individual
 * malformed lines are skipped, never thrown (missing != corrupt).
 *
 * Run:  node --test web/test-contact-graph.mjs
 *
 * @typedef {Object} ContactHistoryEvent
 * @property {string} event
 * @property {string} at
 * @property {string|undefined} channel
 * @property {string|null|undefined} applicationId
 * @property {string|undefined} source
 *
 * @typedef {Object} ContactRecord
 * @property {string} contactId
 * @property {string|null} name
 * @property {string} email
 * @property {Array<{channel?: string, address?: string, firstSeenAt?: string}>} channels
 * @property {ContactHistoryEvent[]} history
 * @property {string} lastContactedAt
 */

/** Replay `data/contacts.jsonl` text into the canonical contact list,
 *  most-recently-contacted first (ties broken by contactId, lexicographic).
 *
 *  @param {string|null} raw
 *  @returns {ContactRecord[]}
 */
export function parsePathContacts(raw) {
  if (!raw) return [];
  const contacts = new Map();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // malformed line skipped, never thrown
    }
    if (!entry || typeof entry !== "object" || typeof entry.contactId !== "string") continue;
    contacts.set(entry.contactId, entry); // last line per contactId wins
  }
  return [...contacts.values()].sort((a, b) => {
    const ta = a.lastContactedAt ?? "";
    const tb = b.lastContactedAt ?? "";
    if (ta === tb) return String(a.contactId).localeCompare(String(b.contactId));
    return ta < tb ? 1 : -1; // most-recently-contact first
  });
}