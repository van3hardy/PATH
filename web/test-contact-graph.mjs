// Tests for parsePathContacts() using Node's built-in test runner.
// Imports directly from contact-graph.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test web/test-contact-graph.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePathContacts, buildContactGraph } from "./src/lib/contact-graph.mjs";

const aLine = JSON.stringify({
  contactId: "c-aaa",
  name: "Ada",
  email: "ada@example.test",
  channels: [{ channel: "email", address: "ada@example.test" }],
  history: [{ event: "contacted", at: "2026-07-01T00:00:00.000Z", channel: "email", source: "dispatch" }],
  lastContactedAt: "2026-07-01T00:00:00.000Z",
});
const bLine = JSON.stringify({
  contactId: "c-bbb",
  name: "Bob",
  email: "bob@example.test",
  channels: [],
  history: [],
  lastContactedAt: "2026-07-02T00:00:00.000Z",
});

test("null / empty input -> []", () => {
  assert.deepEqual(parsePathContacts(null), []);
  assert.deepEqual(parsePathContacts(""), []);
  assert.deepEqual(parsePathContacts("  \n\n  "), []);
});

test("parses valid lines into records", () => {
  const got = parsePathContacts(`${aLine}\n${bLine}\n`);
  assert.equal(got.length, 2);
  assert.equal(got[0].contactId, "c-bbb"); // most-recently-contacted first
  assert.equal(got[1].contactId, "c-aaa");
});

test("last line per contactId wins (append-only replay, same as core loadContacts)", () => {
  const later = JSON.stringify({ contactId: "c-aaa", name: "Ada L.", email: "ada@example.test", history: [], lastContactedAt: "2026-07-10T00:00:00.000Z" });
  const got = parsePathContacts(`${aLine}\n${bLine}\n${later}\n`);
  assert.equal(got.length, 2); // still two people
  const ada = got.find((c) => c.contactId === "c-aaa");
  assert.equal(ada.name, "Ada L.");
  assert.equal(ada.lastContactedAt, "2026-07-10T00:00:00.000Z");
});

test("malformed lines are skipped, never thrown", () => {
  const got = parsePathContacts(`${aLine}\n{not json\ndata: [1,2\n${bLine}\n`);
  assert.equal(got.length, 2);
  const got2 = parsePathContacts("[]\nnull\n123\n" + aLine);
  assert.equal(got2.length, 1);
  assert.equal(got2[0].contactId, "c-aaa");
});

test("ties broken by contactId lexicographic", () => {
  const c1 = JSON.stringify({ contactId: "c-zzz", email: "z@example.test", history: [], lastContactedAt: "2026-07-01T00:00:00.000Z" });
  const c2 = JSON.stringify({ contactId: "c-aaa", email: "a@example.test", history: [], lastContactedAt: "2026-07-01T00:00:00.000Z" });
  const got = parsePathContacts(`${c1}\n${c2}\n`);
  assert.equal(got[0].contactId, "c-aaa");
  assert.equal(got[1].contactId, "c-zzz");
});

test("records without lastContactedAt sort to the end", () => {
  const none = JSON.stringify({ contactId: "c-none", email: "x@example.com", history: [], lastContactedAt: "" });
  const got = parsePathContacts(`${none}\n${bLine}\n`);
  assert.deepEqual(got.map((c) => c.contactId), ["c-bbb", "c-none"]);
});

// ---- buildContactGraph: person ↔ company / role / timeline edges ----

const apps = [
  { n: "041", company: "Alpha Corp", role: "Data Engineer" },
  { n: "042", company: "Example Corp", role: "Ops Manager" },
];

function personFixture(history) {
  return { contactId: "c-aaa", name: "Ada", email: "ada@example.test", history, lastContactedAt: history.at(-1)?.at ?? "" };
}

test("edges resolve applicationId against the tracker and sort by at", () => {
  const contact = personFixture([
    { event: "contacted", at: "2026-07-02T00:00:00.000Z", channel: "email", applicationId: 41, source: "dispatch" },
    { event: "contacted", at: "2026-07-01T00:00:00.000Z", channel: "email", applicationId: 42, source: "dispatch" },
  ]);
  const graph = buildContactGraph([contact], apps);
  assert.equal(graph.edges.length, 2);
  // sorted ascending by at
  assert.deepEqual(graph.edges.map((e) => e.applicationId), [42, 41]);
  const first = graph.edges[0];
  assert.equal(first.company, "Example Corp");
  assert.equal(first.role, "Ops Manager");
  assert.equal(first.channel, "email");
  assert.equal(graph.companies["Example Corp"], 1);
  assert.equal(graph.companies["Alpha Corp"], 1);
  // applications = dedup'd set of application ids touched, order not part of contract
  assert.deepEqual([...graph.people[0].applications].sort((a, b) => a - b), [41, 42]);
});

test("company counts a person once even with multiple edges there", () => {
  const contact = personFixture([
    { event: "contacted", at: "2026-07-01T00:00:00.000Z", channel: "email", applicationId: 41 },
    { event: "contacted", at: "2026-07-02T00:00:00.000Z", channel: "email", applicationId: 41 },
  ]);
  const graph = buildContactGraph([contact], apps);
  assert.equal(graph.companies["Alpha Corp"], 1);
});

test("two people at the same company count 2", () => {
  const a = personFixture([{ event: "contacted", at: "2026-07-01T00:00:00.000Z", applicationId: 41 }]);
  const bContact = { ...personFixture([{ event: "contacted", at: "2026-07-02T00:00:00.000Z", applicationId: 41 }]), contactId: "c-bbb" };
  const graph = buildContactGraph([a, bContact], apps);
  assert.equal(graph.companies["Alpha Corp"], 2);
});

test("unresolved applicationId still yields an edge with null company/role", () => {
  const contact = personFixture([{ event: "contacted", at: "2026-07-01T00:00:00.000Z", channel: "email", applicationId: 999 }]);
  const graph = buildContactGraph([contact], apps);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].company, null);
  assert.equal(graph.edges[0].role, null);
  assert.equal(graph.edges[0].applicationId, 999);
  assert.deepEqual(graph.people[0].applications, [999]);
});

test("empty-string applicationId never resolves to tracker row 0", () => {
  const zeroApp = { n: "0", company: "Zero Co", role: "Zero Role" };
  const contact = personFixture([{ event: "contacted", at: "2026-07-01T00:00:00.000Z", applicationId: "" }]);
  const graph = buildContactGraph([contact], [zeroApp]);
  assert.equal(graph.edges[0].company, null);
  assert.equal(graph.edges[0].role, null);
});

test("no history -> person with zero edges, no throw", () => {
  const contact = personFixture([]);
  const graph = buildContactGraph([contact], apps);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.people[0].edges, 0);
  assert.deepEqual(graph.people[0].applications, []);
  assert.deepEqual(graph.companies, {});
});

test("empty contacts / empty apps degrade gracefully", () => {
  assert.deepEqual(buildContactGraph([], apps), { edges: [], companies: {}, people: [] });
  const contact = personFixture([{ event: "contacted", at: "2026-07-01T00:00:00.000Z", applicationId: 42 }]);
  const noApps = buildContactGraph([contact], []);
  assert.equal(noApps.edges.length, 1);
  assert.equal(noApps.edges[0].company, null);
});