"use strict";

const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("node:path");

const { isCheckout, checkoutCandidates, nearestCheckout } = require("./common.cjs");
const { loadRepoRoot, saveRepoRoot } = require("./app-config.cjs");
const { launchWeb } = require("./server-manager.cjs");
const { buildMenu } = require("./menu.cjs");

const DEV_MODE = process.argv.includes("--dev");

// Persist diagnostics to a log file when PATH_DESKTOP_LOG is set (GUI stdout is
// unreliable on Windows). Every console.error line is also mirrored to it.
const LOG_FILE = process.env.PATH_DESKTOP_LOG;
const logTee = (args) => {
  if (!LOG_FILE) return;
  try {
    const fs = require("node:fs");
    fs.appendFileSync(LOG_FILE, args.map(String).join(" ") + "\n");
  } catch { /* best-effort */ }
};
const origError = console.error;
console.error = (...args) => { origError(...args); logTee(args); };

let serverUrl = null; // http://127.0.0.1:<port>
let stopServer = null; // kills the spawned next process
let win = null;

/** Resolve the checkout: persisted -> env -> defaults -> picker. Returns null if cancelled. */
async function resolveRepo() {
  const persisted = loadRepoRoot(app);
  if (persisted && isCheckout(persisted)) return persisted;

  // Dev: the shell lives at <checkout>/desktop/main.
  const climbed = nearestCheckout(__dirname);
  if (climbed) return climbed;

  const firstCandidate = checkoutCandidates().find(isCheckout);
  if (firstCandidate) {
    saveRepoRoot(app, firstCandidate);
    return firstCandidate;
  }

  // Packaged first run: ask the user where their checkout lives.
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Select your Path (career-ops) checkout folder",
    defaultPath: path.join(app.getPath("documents"), "GitHub"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled || !filePaths[0]) return null;
  const picked = filePaths[0];
  if (!isCheckout(picked)) {
    dialog.showMessageBoxSync({
      type: "warning",
      title: "Not a Path checkout",
      message: "That folder doesn't look like a Path (career-ops) checkout — it needs web/, cv.md and data/.",
    });
    return await resolveRepo();
  }
  saveRepoRoot(app, picked);
  return picked;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 500,
    show: false,
    backgroundColor: "#111111",
    title: "Path",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.once("ready-to-show", () => { win.show(); });
  win.on("closed", () => { win = null; });

  // External navigation (target="_blank", redirects out) -> OS default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  await win.loadURL(serverUrl);
}

app.whenReady().then(async () => {
  try {
    let repo = await resolveRepo();
    if (!repo) { console.error("[desktop] no checkout resolved; quitting"); app.quit(); return; }
    console.error("[desktop] checkout:", repo);

    if (!isCheckout(repo)) {
      // Repo vanished between resolve and launch (e.g. sandboxed path mapping).
      dialog.showErrorBox("Path failed to start", "The selected folder is no longer a Path checkout.");
      app.quit();
      return;
    }

    process.env.PATH_DESKTOP_REPO_ROOT = repo;

    buildMenu({
      repo,
      onOpenRepo: () => { if (repo) shell.openPath(repo); },
    });

    console.error(`[desktop] launching web (${DEV_MODE ? "dev" : "prod"})…`);
    const server = await launchWeb(repo, DEV_MODE ? "dev" : "prod");
    serverUrl = server.url;
    stopServer = server.stop;
    console.error("[desktop] web ready at", serverUrl);

    await createWindow();
  } catch (err) {
    console.error("[desktop] FATAL", err?.stack || err);
    dialog.showErrorBox("Path failed to start", String(err?.message || err));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (stopServer) stopServer();
});