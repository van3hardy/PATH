// Shared helpers for the Path desktop shell.
// The shell learns the local environment (Node, care-ops checkout) and drives the
// web/ Next.js app that already runs the real toolkit scripts.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 3213;

/** Does `dir` look like the career-ops checkout (has web/ + core data)? */
function isCheckout(dir) {
  if (!dir) return false;
  try {
    return (
      fs.existsSync(path.join(dir, "web", "package.json")) &&
      fs.existsSync(path.join(dir, "web", "node_modules", "next")) &&
      fs.existsSync(path.join(dir, "cv.md"))
    );
  } catch {
    return false;
  }
}

/** Checkout candidates in priority order (env -> default -> home). */
function checkoutCandidates() {
  const home = os.homedir();
  const list = [];
  if (process.env.CAREER_OPS_ROOT?.trim()) list.push(process.env.CAREER_OPS_ROOT.trim());
  list.push(path.join(home, "Documents", "GitHub", "Path"));
  list.push(path.join(home, "Documents", "github", "Path"));
  list.push(path.join(home, "Documents", "GitHub", "career-ops"));
  return list;
}

/** The nearest checkout above `dir` (dev-mode resolution). */
function nearestCheckout(dir) {
  let cur = path.resolve(dir);
  while (path.parse(cur).root !== cur) {
    if (isCheckout(cur)) return cur;
    cur = path.dirname(cur);
  }
  return null;
}

/** Node executable used to spawn next (spawn needs no .cmd shim). */
function nodeBin() {
  // Electron main does not embed a stand-alone node binary; use the system node.
  if (process.env.BUN_BINARY_PATH) return process.env.BUN_BINARY_PATH;
  return "node";
}

/** Read the next CLI entrypoint for `next build` / `next start` / `next dev`. */
function nextBinDir(checkout) {
  return path.join(checkout, "web", "node_modules", "next", "dist", "bin", "next");
}

/** A free-ish port (respect DESKTOP_PORT, else default). */
function pickPort() {
  const p = Number(process.env.DESKTOP_PORT || DEFAULT_PORT);
  return Number.isInteger(p) && p > 0 ? p : DEFAULT_PORT;
}

module.exports = {
  DEFAULT_PORT,
  isCheckout,
  checkoutCandidates,
  checkoutPaths: checkoutCandidates,
  nearestCheckout,
  nodeBin,
  nextBinDir,
  pickPort,
};