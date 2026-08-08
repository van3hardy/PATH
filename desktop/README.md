# Path Desktop

An **Electron shell** around the existing local-first web UI (`web/`). Same files,
same toolkit — now in a desktop window with menus and a Windows installer.

It does **not** reimplement the toolkit: the renderer is the real `web/` Next.js
app, which drives the actual scripts (`scan.mjs`, `tracker.mjs`,
`generate-pdf.mjs`, …) and the AI CLIs. The shell just:

1. Resolves the career-ops checkout (your data folder).
2. Spawns `web/` (`next dev` in dev mode, `next build` + `next start` in prod).
3. Opens a `BrowserWindow` pointed at `http://127.0.0.1:<port>`.

## Requirements

- Node 20+ (the web app requirement), with `web/node_modules` installed.
- The career-ops checkout you use daily (this repo) — the shell runs it in place.

## Development

```bash
cd desktop
npm install
npm run dev        # electron . --dev  → next dev + hot-reload window (port 3213)
```

Or from the repo root: `npm run desktop:dev`.

## Production (run from source)

```bash
npm run desktop   # builds web into .next-desktop once, then next start
```

Or the same from the repo root: `npm run desktop`.

Prod builds into `web/.next-desktop` so a live `next dev` in `web/` is never
clobbered.

## Installer (Windows)

```bash
npm run desktop:dist    # root; or cd desktop && npm run dist
                        # → electron-builder nsis + portable under desktop/dist/
```

Installers are **not code-signed**, so SmartScreen will warn — that's expected for
a personal-use app.

## Data folder resolution

Order:

1. Persisted path in Electron `userData/config.json` (saved after first run).
2. `$HOME\Documents\GitHub\Path` / `...\career-ops` if it looks like a checkout.
3. In dev, the checkout containing `desktop/`.
4. Interactive folder picker (packaged app first run).

"Open Data Folder" (File → Open Data Folder) reveals the checkout in Explorer.

## Why not "bundle the app"?

The web UI is the toolkit's own files (data/, reports/, config/) — bundling a copy
would split the source of truth. The desktop shell runs the checkout you already
have, exactly like `web/` does from a terminal.