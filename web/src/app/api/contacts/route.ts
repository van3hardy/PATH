import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { parsePathContacts } from "@/lib/contact-graph.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only surface of the contact graph (data/contacts.jsonl) — every person
// the ledger has ever recorded contact with, plus their outreach history.
// We re-decode the append-only ledger here (never a second source of truth),
// exactly like the core's loadContacts: last line per contactId wins. This is a
// GET-only read: writes go through scripts/contacts-backfill.mjs / dispatch.
export async function GET() {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(path.join(careerOpsRoot(), "data/contacts.jsonl"), "utf8");
  } catch {
    return Response.json({ available: false, contacts: [], count: 0 });
  }
  const contacts = parsePathContacts(raw);
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
  });
}