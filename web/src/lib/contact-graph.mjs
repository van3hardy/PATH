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
    // Tombstone: a superseded name-only row (email promotion). Skipped so the
    // web read model resolves to the same single live record per person as the
    // core loader loadContacts().
    if (typeof entry.supersededBy === "string" && entry.supersededBy.trim() !== "") continue;
    contacts.set(entry.contactId, entry); // last line per contactId wins
  }
  return [...contacts.values()].sort((a, b) => {
    const ta = a.lastContactedAt ?? "";
    const tb = b.lastContactedAt ?? "";
    if (ta === tb) return String(a.contactId).localeCompare(String(b.contactId));
    return ta < tb ? 1 : -1; // most-recently-contact first
  });
}

/**
 * Tracker row used to resolve an application's company/role for a history edge.
 * @typedef {Object} WebApplication
 * @property {string} n
 * @property {string} company
 * @property {string} role
 */

/**
 * One ledger history event, resolved against the application tracker.
 * @typedef {Object} ContactEdge
 * @property {string} contactId - owning person.
 * @property {string|null} applicationId - application the event was about (may be null).
 * @property {string|null} company - resolved from the tracker row (null when unresolved/missing).
 * @property {string|null} role - resolved from the tracker row.
 * @property {string|null} at - event timestamp.
 * @property {string|null} channel
 * @property {string|null} source
 */

/**
 * Resolve the tracker row for an application number. Tracks are zero-padded in
 * the markdown ("042") while ledger events carry the numeric applicationId (42);
 * compare numerically so the two sides of the graph agree.
 * @param {WebApplication[]} apps
 * @param {string|number|null|undefined} id
 * @returns {WebApplication|null}
 */
function appLookup(apps, id) {
  if (id == null || id === "" || typeof apps !== "object" || !apps) return null;
  const needle = Number(id);
  if (!Number.isInteger(needle)) return null;
  for (const app of apps) {
    if (app && Number(app.n) === needle) return app;
  }
  return null;
}

/**
 * Map one contact's ledger history to its graph edges (one per event),
 * resolving each event's applicationId against the tracker rows.
 * @param {Object} contact - a ContactRecord from parsePathContacts().
 * @param {WebApplication[]} apps
 * @returns {ContactEdge[]}
 */
export function buildContactEdges(contact, apps) {
  const history = Array.isArray(contact?.history) ? contact.history : [];
  return history.map((event) => {
    const app = appLookup(apps, event?.applicationId);
    return {
      contactId: contact.contactId,
      applicationId: event?.applicationId ?? null,
      company: app?.company ?? null,
      role: app?.role ?? null,
      at: event?.at ?? null,
      channel: event?.channel ?? null,
      source: event?.source ?? null,
    };
  });
}

/**
 * company → how many distinct people it appears in the ledger for (1 per person).
 * @param {Object[]} contacts
 * @param {WebApplication[]} apps
 * @returns {Record<string, number>}
 */
export function companyCountByPerson(contacts, apps) {
  const peopleByCompany = new Map();
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    for (const edge of buildContactEdges(contact, apps)) {
      if (!edge.company) continue;
      let ids = peopleByCompany.get(edge.company);
      if (!ids) {
        ids = new Set();
        peopleByCompany.set(edge.company, ids);
      }
      ids.add(contact.contactId);
    }
  }
  return Object.fromEntries([...peopleByCompany].map(([company, ids]) => [company, ids.size]));
}

/**
 * Per-contact summaries: total edges + the distinct application ids touched.
 * @param {Object[]} contacts
 * @param {WebApplication[]} apps
 * @returns {Array<{contactId: string, edges: number, applications: (string|number|null)[]}>}
 */
export function summarizeContacts(contacts, apps) {
  return (Array.isArray(contacts) ? contacts : []).map((contact) => {
    const edges = buildContactEdges(contact, apps);
    const applications = [...new Set(edges.map((e) => e.applicationId))];
    return { contactId: contact.contactId, edges: edges.length, applications };
  });
}

/**
 * Full graph read model: every ledger event as an edge + per-company &
 * per-person summaries. Companies follow the tracker's spelling (the tracker is
 * the application-side source of truth); missing tracker → null company/role.
 * @param {Object[]} contacts
 * @param {WebApplication[]} apps
 * @returns {{edges: ContactEdge[], companies: Record<string, number>, people: Array<{contactId: string, edges: number, applications: (string|number|null)[]}>}}
 */
export function buildContactGraph(contacts, apps) {
  const people = Array.isArray(contacts) ? contacts : [];
  const edges = people.flatMap((c) => buildContactEdges(c, apps)).sort((a, b) => {
    const ta = a.at ?? "";
    const tb = b.at ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a.applicationId ?? "").localeCompare(String(b.applicationId ?? ""));
  });
  return {
    edges,
    companies: companyCountByPerson(people, apps),
    people: summarizeContacts(people, apps),
  };
}