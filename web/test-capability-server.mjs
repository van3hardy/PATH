import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
process.env.CAREER_OPS_ROOT = ROOT;

import {
  authorizeWebCapability,
  approveWebCapability,
  executeWebCapability,
  recordTerminalReceipt,
  authorizeDirectUiGesture,
  getReceiptPath,
} from "./src/lib/server/capability-gateway.ts";

function tempReceiptPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "path-web-receipts-"));
  return path.join(dir, "test-receipts.jsonl");
}

test("authorizeWebCapability without approval returns REQUIRE_APPROVAL for consequential capability", async () => {
  const result = await authorizeWebCapability(
    "model.invoke",
    "agent",
    { adapter: "claude", locality: "local" },
    [{ type: "model", id: "research" }],
    null,
  );
  assert.equal(result.decision, "REQUIRE_APPROVAL");
  assert.equal(result.httpStatus, 409);
  assert.ok(result.scopeHash);
});

test("authorizeWebCapability without approval returns REQUIRE_APPROVAL for browser.navigate", async () => {
  const result = await authorizeWebCapability(
    "browser.navigate",
    "agent",
    { hostname: "careers.example.test", sessionIdHash: "abc123", fieldCount: 0 },
    [{ type: "external", id: "application-form", destination: "careers.example.test" }],
    null,
  );
  assert.equal(result.decision, "REQUIRE_APPROVAL");
  assert.equal(result.httpStatus, 409);
});

test("authorizeWebCapability with a valid direct_ui approval returns ALLOW", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "research" }];
  const approval = await approveWebCapability(
    "model.invoke", "direct_user", metadata, resources,
    "web-ui", "direct_ui", 5 * 60 * 1000,
  );
  const result = await authorizeWebCapability("model.invoke", "direct_user", metadata, resources, approval);
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.httpStatus, 200);
});

test("authorizeWebCapability with a valid human approval returns ALLOW for agent actor", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "evaluate" }];
  const approval = await approveWebCapability(
    "model.invoke", "agent", metadata, resources,
    "human-user", "human", 5 * 60 * 1000,
  );
  const result = await authorizeWebCapability("model.invoke", "agent", metadata, resources, approval);
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.httpStatus, 200);
});

test("authorizeWebCapability with a scopeHash mismatch returns REQUIRE_APPROVAL", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "research" }];
  const approval = await approveWebCapability(
    "model.invoke", "agent", metadata, resources,
    "human-user", "human", 5 * 60 * 1000,
  );
  const differentResources = [{ type: "model", id: "evaluate" }];
  const result = await authorizeWebCapability("model.invoke", "agent", metadata, differentResources, approval);
  assert.equal(result.decision, "REQUIRE_APPROVAL");
  assert.equal(result.httpStatus, 409);
});

test("authorizeWebCapability denies browser.submit (prohibited capability)", async () => {
  const result = await authorizeWebCapability(
    "browser.submit",
    "agent",
    { hostname: "careers.example.test", sessionIdHash: "abc", fieldCount: 5 },
    [{ type: "external", id: "application-form", destination: "careers.example.test" }],
    null,
  );
  assert.equal(result.decision, "DENY");
  assert.equal(result.httpStatus, 403);
});

test("authorizeWebCapability denies unknown capability", async () => {
  const result = await authorizeWebCapability(
    "unknown.cap", "agent", {}, [{ type: "model", id: "x" }], null,
  );
  assert.equal(result.decision, "DENY");
  assert.equal(result.httpStatus, 403);
});

test("authorizeWebCapability denies agent with direct_ui source (actor/Source mismatch)", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "research" }];
  const approval = await approveWebCapability(
    "model.invoke", "agent", metadata, resources,
    "web-ui", "direct_ui", 5 * 60 * 1000,
  );
  const result = await authorizeWebCapability("model.invoke", "agent", metadata, resources, approval);
  assert.equal(result.decision, "REQUIRE_APPROVAL");
  assert.equal(result.httpStatus, 409);
});

test("authorizeDirectUiGesture auto-creates a direct_ui approval and returns ALLOW", async () => {
  const result = await authorizeDirectUiGesture(
    "model.invoke",
    { adapter: "claude", locality: "local" },
    [{ type: "model", id: "research" }],
  );
  assert.equal(result.decision, "ALLOW");
  assert.ok(result.approval);
  assert.equal(result.approval.source, "direct_ui");
  assert.ok(result.scopeHash);
});

test("authorizeDirectUiGesture auto-creates direct_ui approval for browser.navigate", async () => {
  const result = await authorizeDirectUiGesture(
    "browser.navigate",
    { hostname: "careers.example.test", sessionIdHash: "abc", fieldCount: 0 },
    [{ type: "external", id: "application-form", destination: "careers.example.test" }],
  );
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.approval.source, "direct_ui");
});

test("executeWebCapability does NOT call the operation without an approval", async () => {
  let called = false;
  const operation = async () => { called = true; return "result"; };

  await assert.rejects(
    executeWebCapability(
      "model.invoke", "agent",
      { adapter: "claude", locality: "local" },
      [{ type: "model", id: "research" }],
      operation,
      null,
      tempReceiptPath(),
    ),
    /Capability not executed/,
  );
  assert.equal(called, false);
});

test("executeWebCapability does NOT call the operation with a mismatched approval", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "research" }];
  const approval = await approveWebCapability(
    "model.invoke", "agent", metadata, resources,
    "human-user", "human", 5 * 60 * 1000,
  );
  let called = false;
  const operation = async () => { called = true; return "result"; };

  await assert.rejects(
    executeWebCapability(
      "model.invoke", "agent",
      { adapter: "claude", locality: "local" },
      [{ type: "model", id: "evaluate" }], // different resource → scopeHash mismatch
      operation,
      approval,
      tempReceiptPath(),
    ),
    /Capability not executed/,
  );
  assert.equal(called, false);
});

test("executeWebCapability RUNS the operation once with a valid approval", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "research" }];
  const approval = await approveWebCapability(
    "model.invoke", "direct_user", metadata, resources,
    "web-ui", "direct_ui", 5 * 60 * 1000,
  );
  let callCount = 0;
  const operation = async () => { callCount++; return "ok"; };

  const result = await executeWebCapability(
    "model.invoke", "direct_user", metadata, resources,
    operation, approval, tempReceiptPath(),
  );
  assert.equal(result, "ok");
  assert.equal(callCount, 1);
});

test("executeWebCapability throws if the operation throws and records a failed receipt", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "evaluate" }];
  const approval = await approveWebCapability(
    "model.invoke", "direct_user", metadata, resources,
    "web-ui", "direct_ui", 5 * 60 * 1000,
  );
  const receiptFile = tempReceiptPath();
  const boom = new Error("planner crashed");

  await assert.rejects(
    executeWebCapability(
      "model.invoke", "direct_user", metadata, resources,
      async () => { throw boom; },
      approval, receiptFile,
    ),
    /planner crashed/,
  );

  assert.ok(existsSync(receiptFile));
  const lines = readFileSync(receiptFile, "utf8").split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 2);
  const attempted = JSON.parse(lines[0]);
  assert.equal(attempted.event, "capability_attempted");
  const failed = JSON.parse(lines.at(-1));
  assert.equal(failed.event, "capability_failed");
  // The failed receipt records only the error name/message hash — NOT the full
  // stack trace or the operation's payload.
  assert.ok(failed.outcomeHash);
  assert.equal(failed.metadataHash, attempted.metadataHash);
  assert.equal(failed.resourcesHash, attempted.resourcesHash);
});

test("receipts never contain prompt, answer, token, or CV text", async () => {
  const sensitivePrompt = "SECRET_PROMPT_do_not_leak_this_api_key_sk-12345";
  const sensitiveAnswer = "CONFIDENTIAL_ANSWER_salary:150000";
  const sensitiveToken = "TOKEN_leaked_auth_token_xyz";
  const sensitiveCvText = "CV_SECRET_past_experience_at_acme_corp";

  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "cv-ingest" }];
  const approval = await approveWebCapability(
    "model.invoke", "direct_user", metadata, resources,
    "web-ui", "direct_ui", 5 * 60 * 1000,
  );
  const receiptFile = tempReceiptPath();

  // Operation receives sensitive data but should NOT leak into receipts.
  await executeWebCapability(
    "model.invoke", "direct_user", metadata, resources,
    async () => {
      // Simulate the operation doing work with sensitive data
      const work = sensitivePrompt + sensitiveAnswer + sensitiveToken + sensitiveCvText;
      return { output: "done" };
    },
    approval, receiptFile,
  );

  const content = readFileSync(receiptFile, "utf8");
  assert.ok(!content.includes(sensitivePrompt), "receipt must not contain the prompt");
  assert.ok(!content.includes(sensitiveAnswer), "receipt must not contain the answer");
  assert.ok(!content.includes(sensitiveToken), "receipt must not contain the token");
  assert.ok(!content.includes(sensitiveCvText), "receipt must not contain CV text");
  // Metadata hash should be a hash, not the raw adapter string
  assert.ok(!content.includes("claude"), "receipt should not contain raw adapter name in plaintext");
});

test("receipts for browser capabilities contain only hashed metadata", async () => {
  const sensitiveUrl = "https://careers.example.test/apply/42?token=secret";
  const sessionId = "session_secret_id_xyz";
  const hostname = new URL(sensitiveUrl).hostname;

  const metadata = { hostname, sessionIdHash: "hash_of_" + sessionId.slice(0, 8), fieldCount: 5 };
  const resources = [{ type: "external", id: "application-form", destination: hostname }];
  const approval = await approveWebCapability(
    "browser.navigate", "direct_user", metadata, resources,
    "web-ui", "direct_ui", 5 * 60 * 1000,
  );
  const receiptFile = tempReceiptPath();

  await executeWebCapability(
    "browser.navigate", "direct_user", metadata, resources,
    async () => { return { reached: true }; },
    approval, receiptFile,
  );

  const content = readFileSync(receiptFile, "utf8");
  // The raw URL must not appear in the receipt
  assert.ok(!content.includes(sensitiveUrl), "receipt must not contain the raw URL");
  // The raw session ID must not appear
  assert.ok(!content.includes(sessionId), "receipt must not contain the raw session ID");
  // The hostname must NOT appear in plaintext either: destinations are bound
  // into scopeHash/resourcesHash and metadata into metadataHash (content-minimized).
  assert.ok(!content.includes(hostname), "receipt must not contain the raw hostname");
  // Metadata is hashed, not raw
  assert.ok(content.includes("metadataHash"), "receipt must use metadataHash");
});

test("recordTerminalReceipt writes a terminal receipt with the correct outcome", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "research" }];
  const approval = await approveWebCapability(
    "model.invoke", "direct_user", metadata, resources,
    "web-ui", "direct_ui", 5 * 60 * 1000,
  );
  const receiptFile = tempReceiptPath();

  await recordTerminalReceipt(
    "model.invoke", "direct_user", metadata, resources, approval,
    "succeeded", new Date(), receiptFile,
  );

  const lines = readFileSync(receiptFile, "utf8").split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.event, "capability_succeeded");
  assert.equal(receipt.decision, "ALLOW");
  assert.ok(receipt.scopeHash);
  assert.ok(receipt.metadataHash);
  assert.ok(receipt.resourcesHash);
  assert.equal(receipt.approvalSource, "direct_ui");
});

test("recordTerminalReceipt writes a failed receipt", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "eval" }];
  const approval = await approveWebCapability(
    "model.invoke", "direct_user", metadata, resources,
    "web-ui", "direct_ui", 5 * 60 * 1000,
  );
  const receiptFile = tempReceiptPath();

  await recordTerminalReceipt(
    "model.invoke", "direct_user", metadata, resources, approval,
    "failed", new Date(), receiptFile,
  );

  const receipt = JSON.parse(readFileSync(receiptFile, "utf8").trim());
  assert.equal(receipt.event, "capability_failed");
});

test("expired approval is rejected", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "research" }];
  // ttlMs = 1 → expires almost immediately
  const approval = await approveWebCapability(
    "model.invoke", "agent", metadata, resources,
    "human-user", "human", 1,
  );
  // Wait for it to expire
  await new Promise((r) => setTimeout(r, 10));
  const result = await authorizeWebCapability("model.invoke", "agent", metadata, resources, approval);
  assert.equal(result.decision, "REQUIRE_APPROVAL");
  assert.equal(result.httpStatus, 409);
});

test("consumed approval is rejected (one-shot)", async () => {
  const metadata = { adapter: "claude", locality: "local" };
  const resources = [{ type: "model", id: "research" }];
  const approval = await approveWebCapability(
    "model.invoke", "agent", metadata, resources,
    "human-user", "human", 5 * 60 * 1000,
  );

  // First execution consumes the approval
  await executeWebCapability(
    "model.invoke", "agent", metadata, resources,
    async () => "first",
    approval, tempReceiptPath(),
  );

  // Second execution with the same approval should fail
  await assert.rejects(
    executeWebCapability(
      "model.invoke", "agent", metadata, resources,
      async () => "second",
      approval, tempReceiptPath(),
    ),
    /Capability not executed/,
  );
});
