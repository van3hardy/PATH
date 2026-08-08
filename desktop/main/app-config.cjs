// Persists the resolved career-ops checkout path in Electron's userData so a
// packaged app remembers the user's data folder across launches.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function configPath(app) {
  return path.join(app.getPath("userData"), "config.json");
}

/** Load the persisted checkout path (or null). */
function loadRepoRoot(app) {
  try {
    const raw = fs.readFileSync(configPath(app), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.repoRoot === "string" && parsed.repoRoot) {
      return parsed.repoRoot;
    }
  } catch {
    /* not persisted yet */
  }
  return null;
}

/** Persist the chosen checkout path. */
function saveRepoRoot(app, repoRoot) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(configPath(app), JSON.stringify({ repoRoot }, null, 2), "utf8");
  } catch {
    /* best-effort persistence */
  }
}

module.exports = { loadRepoRoot, saveRepoRoot };