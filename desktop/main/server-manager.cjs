// Starts the web/ Next.js app (the real toolkit GUI) as a child process and
// waits until it responds on the chosen port. Handles both dev (hot reload) and
// production (build-if-missing + next start) modes.
"use strict";

const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { nodeBin, nextBinDir, pickPort } = require("./common.cjs");

// Next/Turbopack (Next 16) forbids distDir outside the project root. Build into
// web/.next-desktop (web/.gitignore already ignores /.*next*). End independent of
// a live `next dev` which uses web/.next.
const PROD_BUILD_DIR = ".next-desktop";
const READY_TIMEOUT_MS = 120_000; // build can be slow on first run

// Resolved per-checkout: in a packaged app __dirname lives inside app.asar
// (read-only), so the build dir must be derived from the checkout, not __dirname.
function prodBuildAbs(checkout) {
  return path.join(checkout, "web", PROD_BUILD_DIR);
}

function buildNext(checkout) {
  const webDir = path.join(checkout, "web");
  return new Promise((resolve, reject) => {
    const child = spawn(
      nodeBin(),
      [nextBinDir(checkout), "build"],
      {
        cwd: webDir,
        env: { ...process.env, BUILD_DIST: PROD_BUILD_DIR, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`next build failed (exit ${code}): ${err.slice(0, 2000)}`));
    });
  });
}

function startServer(checkout, mode) {
  const port = pickPort();
  const webDir = path.join(checkout, "web");
  const args = mode === "dev"
    ? [nextBinDir(checkout), "dev", "-p", String(port)]
    : [nextBinDir(checkout), "start", "-p", String(port)];
  const env = { ...process.env, ...(mode === "dev" ? {} : { BUILD_DIST: PROD_BUILD_DIR }) };
  const child = spawn(nodeBin(), args, { cwd: webDir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  const logs = [];
  const onLog = (prefix) => (d) => {
    const text = d.toString().trim();
    if (text) logs.push(prefix + text);
  };
  child.stdout.on("data", onLog("[next] "));
  child.stderr.on("data", onLog("[next] "));

  return { child, port, url: `http://127.0.0.1:${port}`, logs };
}

function waitForReady(url, timeoutMs = READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const req = http.get(url, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(url);
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`server did not become ready within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 500);
        }
      });
      req.on("timeout", () => req.destroy());
    };
    attempt();
  });
}

/** Start (and if needed, build) the web app. Returns { url, stop }. */
async function launchWeb(checkout, mode) {
  if (mode !== "dev") {
    // Production: build once into a dedicated dir so a live `next dev` is untouched.
    if (!fs.existsSync(path.join(prodBuildAbs(checkout), "BUILD_ID"))) {
      await buildNext(checkout);
    }
  }
  const { child, port, url } = startServer(checkout, mode);
  await waitForReady(url).catch((err) => {
    child.kill();
    throw err;
  });
  const stop = () => {
    try { child.kill(); } catch { /* already gone */ }
  };
  return { url, port, stop };
}

module.exports = { launchWeb, buildNext };