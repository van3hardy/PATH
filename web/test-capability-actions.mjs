import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { actionExists, dispatch } from "./src/app/actions/registry.ts";

function makeCtx({ inbox = [], applications = [], existingJobs = new Map() } = {}) {
  const effects = [];
  let nextJob = 1;
  return {
    effects,
    ctx: {
      push: (path) => effects.push(["push", path]),
      replace: (path) => effects.push(["replace", path]),
      startJob: (input) => {
        effects.push(["startJob", structuredClone(input)]);
        return `job-${nextJob++}`;
      },
      inbox,
      applications,
      jobForUrl: (url) => existingJobs.get(url),
      rememberFact: (fact) => effects.push(["rememberFact", fact]),
      writeStatus: (n, status) => effects.push(["writeStatus", n, status]),
      setApplyField: (field, value) => effects.push(["setApplyField", field, value]),
      startApply: (url) => effects.push(["startApply", url]),
      applyExplore: (raw, options) => effects.push(["applyExplore", structuredClone(raw), structuredClone(options)]),
      writeProfile: (patch) => effects.push(["writeProfile", structuredClone(patch)]),
      writePortals: (roles, location) => effects.push(["writePortals", [...roles], location ? [...location] : undefined]),
    },
  };
}

function assertConfirm(result, capabilityId, resources) {
  assert.equal(result.status, "confirm");
  assert.equal(result.capabilityId, capabilityId);
  assert.deepEqual(result.resources, resources);
  assert.equal(Object.isFrozen(result.resources), true);
  assert.equal(result.resources.every(Object.isFrozen), true);
  assert.equal(typeof result.summary, "string");
  assert.ok(result.summary.length > 0);
  assert.equal(typeof result.run, "function");
}

test("navigation and pipeline filtering remain immediate local reads", () => {
  const first = makeCtx();
  assert.deepEqual(dispatch("navigate", { path: "/pipeline/42" }, first.ctx), { status: "done" });
  assert.deepEqual(first.effects, [["push", "/pipeline/42"]]);

  const second = makeCtx();
  assert.deepEqual(dispatch("filterPipeline", { tab: "applied", min: 4, q: "ML", sort: "score", dir: -1 }, second.ctx), { status: "done" });
  assert.deepEqual(second.effects, [["replace", "/pipeline?tab=APPLIED&min=4&q=ML&sort=score&dir=-1"]]);
});

const consequentialCases = [
  {
    name: "evaluate",
    args: { url: "https://jobs.example.test/1", title: "Evaluate role" },
    capabilityId: "model.invoke",
    resources: [{ type: "model", id: "evaluate" }],
    expected: [["startJob", { title: "Evaluate role", kind: "evaluate", input: "https://jobs.example.test/1", page: "/pipeline" }]],
  },
  {
    name: "evaluateCompany",
    args: { company: "Example" },
    setup: { inbox: [{ company: "Example", role: "Engineer", url: "https://jobs.example.test/1", done: false }] },
    capabilityId: "model.invoke",
    resources: [{ type: "model", id: "evaluate" }],
    expected: [["startJob", { title: "Evaluate · Example", subtitle: "Engineer", kind: "evaluate", input: "https://jobs.example.test/1", page: "/pipeline" }]],
  },
  {
    name: "explore",
    args: { roles: ["AI Engineer"], run: true },
    capabilityId: "external.read",
    resources: [{ type: "external", id: "job-discovery", destination: "configured-ATS-providers" }],
    expected: [["push", "/explore"], ["applyExplore", { roles: ["AI Engineer"], run: true }, { merge: false, run: true }]],
  },
  {
    name: "research",
    args: { target: "Example Corp" },
    capabilityId: "model.invoke",
    resources: [{ type: "model", id: "research" }],
    expected: [["startJob", { title: "Research", kind: "research", input: "Example Corp", page: "/pipeline" }]],
  },
  {
    name: "generatePdf",
    args: { n: "42" },
    setup: { applications: [{ n: "42", company: "Example", role: "Engineer" }] },
    capabilityId: "model.invoke",
    resources: [{ type: "model", id: "pdf" }],
    expected: [["startJob", { title: "CV PDF · Example", subtitle: "tailored CV", kind: "pdf", input: "42", page: "/pipeline/42" }]],
  },
  {
    name: "setStatus",
    args: { n: "42", status: "Applied" },
    setup: { applications: [{ n: "42", company: "Example", role: "Engineer" }] },
    capabilityId: "local.write",
    resources: [{ type: "local", id: "data/applications.md" }],
    expected: [["writeStatus", "42", "Applied"]],
  },
  {
    name: "apply",
    args: { url: "https://careers.example.test/apply/42" },
    capabilityId: "browser.navigate",
    resources: [{ type: "external", id: "application-form", destination: "careers.example.test" }],
    expected: [["startApply", "https://careers.example.test/apply/42"]],
    summaryIncludes: "does not submit",
  },
  {
    name: "setApplyField",
    args: { field: "work-authorisation", value: "Yes" },
    capabilityId: "local.write",
    resources: [{ type: "local", id: "apply-session" }],
    expected: [["setApplyField", "work-authorisation", "Yes"]],
  },
  {
    name: "remember",
    args: { fact: "Prefers remote roles" },
    capabilityId: "local.write",
    resources: [{ type: "local", id: "modes/_profile.md" }],
    expected: [["rememberFact", "Prefers remote roles"]],
  },
  {
    name: "setProfile",
    args: { name: "Candidate", location: "Remote" },
    capabilityId: "local.write",
    resources: [{ type: "local", id: "config/profile.yml" }],
    expected: [["writeProfile", { name: "Candidate", location: "Remote" }]],
  },
  {
    name: "setPortals",
    args: { roles: ["AI Engineer"], location: ["Remote"] },
    capabilityId: "local.write",
    resources: [{ type: "local", id: "portals.yml" }],
    expected: [["writePortals", ["AI Engineer"], ["Remote"]]],
  },
];

for (const fixture of consequentialCases) {
  test(`${fixture.name} is inert until its catalog-bound confirmation closure runs`, () => {
    const state = makeCtx(fixture.setup);
    const result = dispatch(fixture.name, fixture.args, state.ctx);
    assertConfirm(result, fixture.capabilityId, fixture.resources);
    assert.deepEqual(state.effects, []);
    if (fixture.summaryIncludes) assert.match(result.summary, new RegExp(fixture.summaryIncludes, "i"));
    result.run();
    assert.deepEqual(state.effects, fixture.expected);
  });
}

test("approval-shaped model arguments cannot self-approve", () => {
  for (const field of ["approved", "confirmed", "approval", "approvalSource", "execute"]) {
    const state = makeCtx();
    const result = dispatch("research", { target: "Example", [field]: true }, state.ctx);
    assertConfirm(result, "model.invoke", [{ type: "model", id: "research" }]);
    assert.deepEqual(state.effects, []);
  }
});

test("confirmation closure is bound to an immutable validated snapshot and is one-shot", () => {
  const args = { roles: ["AI Engineer"], location: ["Remote"] };
  const state = makeCtx();
  const result = dispatch("setPortals", args, state.ctx);
  assertConfirm(result, "local.write", [{ type: "local", id: "portals.yml" }]);

  args.roles[0] = "MUTATED";
  args.location.push("MUTATED");
  assert.throws(() => result.resources.push({ type: "local", id: "other" }), TypeError);
  result.run();
  result.run();
  assert.deepEqual(state.effects, [["writePortals", ["AI Engineer"], ["Remote"]]]);
});

test("evaluateCompany counts 1, 2, and 3 all confirm before starting exactly N workers", () => {
  for (const count of [1, 2, 3]) {
    const inbox = Array.from({ length: count }, (_, index) => ({
      company: "Example",
      role: `Engineer ${index + 1}`,
      url: `https://jobs.example.test/${index + 1}`,
      done: false,
    }));
    const state = makeCtx({ inbox });
    const result = dispatch("evaluateCompany", { company: "Example" }, state.ctx);
    assertConfirm(result, "model.invoke", [{ type: "model", id: "evaluate" }]);
    assert.deepEqual(state.effects, []);
    const info = result.run();
    assert.equal(state.effects.length, count);
    assert.equal(info.jobIds.length, count);
  }
});

test("unknown and prohibited action IDs fail closed without effects", () => {
  for (const id of ["unknown", "browser.submit"]) {
    const state = makeCtx();
    assert.equal(actionExists(id), false);
    assert.equal(dispatch(id, { execute: true, approved: true }, state.ctx).status, "ignored");
    assert.deepEqual(state.effects, []);
  }
});

test("driveSession has no submit action path (never-submit by construction)", () => {
  const src = readFileSync(new URL("./src/lib/apply/drive.ts", import.meta.url), "utf8");
  // The action grammar the planner is allowed to emit offers no submit action.
  const start = src.indexOf('{"action":"click"');
  const end = src.indexOf('Page: "', start);
  assert.ok(start > 0 && end > start, "action grammar block must be present");
  const grammar = src.slice(start, end);
  for (const action of ['"action":"click"', '"action":"type"', '"action":"select"', '"action":"scroll"', '"action":"stuck"']) {
    assert.ok(grammar.includes(action), `grammar must offer ${action}`);
  }
  assert.ok(!/["']action["']\s*:\s*["']submit["']/i.test(grammar), "grammar must not offer a submit action");
  // The click handler refuses submit/apply-final controls before acting.
  assert.ok(src.includes("SUBMIT_RX"), "drive.ts must define SUBMIT_RX");
  assert.ok(/submit|send application|finish application|complete application|apply and submit|enviar|finalizar/i.test(src), "SUBMIT_RX must cover submit/apply-final controls");
  assert.ok(src.includes("refused to click a submit control"), "click handler must refuse submit controls");
  assert.ok(src.includes("there is no submit action"), "drive prompt must state there is no submit action");
});

test("setProfile binds profile and portals resources only when roles are present", () => {
  const withoutRoles = makeCtx();
  const first = dispatch("setProfile", { name: "Candidate" }, withoutRoles.ctx);
  assertConfirm(first, "local.write", [{ type: "local", id: "config/profile.yml" }]);

  const withRoles = makeCtx();
  const second = dispatch("setProfile", { name: "Candidate", roles: ["AI Engineer"] }, withRoles.ctx);
  assertConfirm(second, "local.write", [
    { type: "local", id: "config/profile.yml" },
    { type: "local", id: "portals.yml" },
  ]);
  second.run();
  assert.deepEqual(withRoles.effects, [
    ["writeProfile", { name: "Candidate", roles: ["AI Engineer"] }],
    ["writePortals", ["AI Engineer"], undefined],
  ]);
});
