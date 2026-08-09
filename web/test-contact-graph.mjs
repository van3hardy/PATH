// Tests for parsePathContacts() using Node's built-in test runner.
// Imports directly from contact-graph.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test web/test-contact-graph.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePathContacts } from "./src/lib/contact-graph.mjs";

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