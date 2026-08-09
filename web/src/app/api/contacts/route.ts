import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { parsePathContacts, buildContactGraph } from "@/lib/contact-graph.mjs";
import { parseApplications } from "@/lib/tracker-table.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only surface of the contact graph (data/contacts.jsonl) — every person
// the ledger has ever recorded contact with, plus their outreach history.
// We re-decode the append-only ledger here (never a second source of truth),
// exactly like the core's loadContacts: last line per contactId wins. This is a
// GET-only read: writes go through scripts/contacts-backfill.mjs / dispatch.
//
// The response also carries a derived `graph` block — person ↔ company / role /
// timeline edges. The company/role strings come from the application tracker
// (data/applications.md), the job-side of the graph; a ledger event whose
// applicationId can't be resolved there (deleted/renumbered row) still yields an
// edge with null company/role — the ledger remains truth for "contacted".
export async function GET() {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(path.join(careerOpsRoot(), "data/contacts.jsonl"), "utf8");
  } catch {
    return Response.json({ available: false, contacts: [], count: 0, graph: null });
  }
  const contacts = parsePathContacts(raw);

  let apps: Array<{ n: string; company: string; role: string }> = [];
  try {
    const md = fs.readFileSync(path.join(careerOpsRoot(), "data/applications.md"), "utf8");
    apps = parseApplications(md, careerOpsRoot());
  } catch {
    // Missing/corrupt tracker → edges still produced with null company/role.
  }

  return Response.json({
    available: true,
    count: contacts.length,
    contacts: contacts.map((c) => ({
      contactId: c.contactId,
      name: c.name,
      email: c.email,
      firstContactedAt: c.history?.[0]?.at ?? c.lastContactedAt,
      lastContactedAt: c.lastContactedAt,
      contactCount: Array.isArray(c.history) ? c.history.length : 0,
      channels: (c.channels ?? []).map((ch) => ch.channel).filter(Boolean),
    })),
    graph: buildContactGraph(contacts, apps),
  });
}