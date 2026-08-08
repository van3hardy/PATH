"use strict";

// Preload bridge. Exposes a tiny, safe surface to the renderer. Under `sandbox: true`
// the preload has limited `process`/require, so everything here is hardcoded truth the
// web app can render ("running inside Path desktop") without needing the repo path.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("pathDesktop", {
  /** True when running inside the desktop shell (vs a plain browser). */
  isDesktop: () => true,
  /** Version of the desktop shell (from the app package). */
  version: () => "0.1.0",
});