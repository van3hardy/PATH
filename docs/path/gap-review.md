# PATH — Vision vs. Repo Gap Review

> **Purpose:** Reconcile the PATH vision (sections 1–19) with what the repository at `C:\Users\van1h\Documents\GitHub\Path` (branch `main`, v1.22.0) actually implements today. This is a living reference for planning, not a spec.
>
> **Method:** Four parallel exploration passes over the repo (core pipeline & evidence, communications/outreach, web UI surface, desktop shell) plus direct spot-checks of every path and claim cited here.
>
> **Status legend:** ✅ implemented and mature · ⚠️  partial (machinery exists, but offline / not wired / missing data) · ❌ missing or stub-only.
>
> **Scope note:** The real repo lives at `C:\Users\van1h\Documents\GitHub\Path`. The `C:\Users\van1h\OneDrive\Documents\path` directory is a separate near-empty location and is **not** taken as evidence.
>
> **Date:** 2026-08-08.

---

## 1. Vision sections → repo reality

| Section | Status | Key repo evidence | Notes |
|---|---|---|---|
| §2 Discovery network | ⚠️ | `providers/` (~60 adapters), `scan.mjs`, `scan-ats-full.mjs`, `portals.yml`, `plugins-registry/` | **ATS + company career sites are complete** (Greenhouse, Lever, Ashby, Workday, BambooHR, … with unit tests in `tests/providers/`). **Missing from the vision's explicit list: LinkedIn, Indeed, ZipRecruiter, Monster** — auth-gated sources are deliberately outside core; LinkedIn reaches the scanner only via the optional Gmail job-alert ingest plugin. |
| §3 Opportunity intelligence (discover→parse→research→score) | ✅ | `scan.mjs`, `modes/oferta.md`, `modes/_shared.md` (scoring), `browser-extract.mjs`, `detect-reposts.mjs`, `fingerprint-core.mjs`, `check-liveness.mjs` + `liveness-core/api/browser.mjs`, `gemini/ollama/openai-eval.mjs`, `eval-golden.mjs` | Mature. Includes liveness gate (dead-postings), repost detection, free-tier evaluators, golden regression fixtures. |
| §4 Career truth store (§14 #3) | ⚠️ | `cv.md`, `article-digest.md`, `config/profile.yml`, `modes/_profile.md` (sources of truth), `verify-cv-facts.mjs`, `path-safety/fact-resolver.mjs`, `path-memory/evidence-selector.mjs`, `config/path.facts.yml` | The "no invented qualifications" rule is enforced in prompt layer + `verify-cv-facts.mjs` + claim reports. **Partial:** no external verification integration; the approved-fact store is minimal (2 facts). |
| §5 CV / application factory | ✅ | `build-cv-html/latex.mjs`, `generate-latex/pdf.mjs`, `prepare-application.mjs` (never POSTs), `application-artifacts.mjs` (versioned dirs), `application-answers.mjs`, `generate-cover-letter.mjs`, `outcome.mjs` | Full CV→PDF→cover-letter chain; per-application artifacts track exactly which CV version was used. |
| §6 Professional network engine | ⚠️ | `modes/contacto.md`, `followup-cadence.mjs` `extractContacts()`, `invite-match.mjs`, `path-workflows/recruiter/request-boundary.mjs`, `path-safety/contacts.mjs` + `data/contacts.jsonl` | **Now has a people ledger + read-only web surface.** Contacts are seeded (`scripts/contacts-backfill.mjs`) and deduped by person via `contactId` in the dispatch gate; `/api/contacts` (`09c0bc5`) exposes the ledger read-only. Still no graph/edges — see [`contact-graph.md`](contact-graph.md). |
| §7 Recruiter / human-path outreach | ⚠️ | `modes/contacto.md`, `modes/email.md`, `modes/followup.md`, `path-workflows/recruiter/*`, `scripts/path-run.mjs`, `data/path-outbox.jsonl` | Draft + evidence + approval pipeline exists (MVP-1). Dispatch is **dry-run only** — see §8. |
| §8 Two-way communications hub | ❌ | `plugins/gmail/index.mjs` (read-only ingest), `paste-reply.mjs` (manual), `modes/email.md` (draft-mode) | **No outbound transport anywhere.** No SMTP send, no LinkedIn send, no telephony. Only Gmail *read-only* job-lead ingestion is real. |
| §9 Conversation intelligence | ⚠️ | `reply-watch.mjs`, `reply-matcher.mjs`, `paste-reply.mjs`, `invite-match.mjs`, `data/reply-candidates.json` | Recognize/respond/record machinery exists and is local. Feed is manual (pasted text); no Gmail inbox scan (`paste-reply.mjs` header documents `#1583 unbuilt`). |
| §10 CRM & follow-up | ⚠️ | `data/applications.md`, `tracker*.mjs`, `merge/dedup/reconcile-pipeline.mjs`, `followup-cadence.mjs`, `followup-seed.mjs`, `reply-watch.mjs`, `agent-inbox.mjs`, `data/contacts.jsonl` | Application CRM is mature. **Partial:** people ledger now exists and the dispatch gate blocks per-person duplicate contact; deadlines computed on demand, not pushed. |
| §11 Interview & offer | ⚠️ | `modes/interview/plan.md\|practice.md\|debrief.md`, `match-star.mjs`, `modes/offer-prep.md` | Prep/plan/debrief prompts + STAR matcher exist. **No scheduling/booking** (calendar plugins are ingest-only); `interview-prep/story-bank.md` **missing** but required by `match-star.mjs` and `evidence-selector.mjs`. |
| §12 Authority & safety architecture | ✅ | `path-safety/policy.mjs` (green/yellow/red), `capability-catalog.mjs`, `capability-gateway.mjs`, `approval-packet.mjs`, `packet-integrity.mjs` (SHA-256 + idempotency + 24h TTL), `audit-ledger.mjs` (hash-chained), `config/path.autonomy.yml`, `data/path-outbox.jsonl` + `path-audit.jsonl` | **The fork's flagship, fully tested.** YELLOW→approval, RED→block, `browser.submit` hard-`deny`. Air-gapped at HUMAN_REVIEW by design. |
| §13 Representation rule (act for, not as) | ✅ | `packet-integrity.mjs`, `approval-packet.mjs`, `recruiter-template.mjs` (voice = `'path-recruiter-persistent-respectful-v1'`, disclosure = `'always-disclose-ai-assistance-v1'`) | Draft sample signs "by Van / attached by Path" with AI-assistance disclosure forced `true`. |
| §14 Subsystem architecture | see table | see table in §2 below | Existence check column-by-column. |
| §15 End-to-end loop | ⚠️ | `modes/auto-pipeline.md`, `modes/pipeline.md`, `modes/apply.md`, `modes/followup.md`, `path-runner/lifecycle.mjs` | Job-seeker half is real; recruiter loop stops at `HUMAN_REVIEW` with no live send. |
| §16 Verified so far | ✅ | `docs/path/recruiter-mvp1.md`, `data/path-runs/run-safe-demo-20260729-2130/` | The **2026-07-29** MVP completion gate is recorded; a single demo packet sits in the outbox. |
| §17 Still vision / not yet capabilities | ⚠️ | cross-reference §3 below | List matches; most items are genuinely unimplemented. |
| §18 Known hardening | ⚠️ | `test-trust-validator.mjs`, `verify-cv-facts.mjs`, `plugin-audit.mjs`, `validate-system-paths-coverage.mjs` | Already partially hardened; see §6 tail. |

---

## 2. §14 subsystem existence check (the 10-subsystem table)

| # | Subsystem | Status | Evidence |
|---|---|---|---|
| 1 | **Source adapters** | ✅ ATS/company-sites; ⚠️ vision list | `providers/`, `scan.mjs`, `scan-ats-full.mjs`. Missing LinkedIn/Indeed/ZipRecruiter/Monster. |
| 2 | **Opportunity engine** | ✅ | `scan.mjs`, `oferta.md`+`_shared.md` scoring, evaluators, `classify-tier.mjs`, liveness suite. |
| 3 | **Career truth store** | ⚠️ | `verify-cv-facts.mjs`, `fact-resolver.mjs`, `evidence-selector.mjs`. Store is user-file-based + minimally populated. |
| 4 | **CV/application engine** | ✅ | `build-cv-*`, `generate-pdf/latex`, `prepare-application`, `application-artifacts`. |
| 5 | **Contact graph** | ⚠️ | People ledger ships: `path-safety/contacts.mjs`, `data/contacts.jsonl`, `--contacts` gate in `scripts/path-dispatch.mjs`, read-only web surface `/api/contacts` + `web/src/lib/contact-graph.mjs` (`09c0bc5`), `docs/path/contact-graph.md`. Still no graph/edges. |
| 6 | **Communications hub** | ❌ | Outbox + approval gate exist; **no transport/send channel.** `scripts/path-dispatch.mjs` dry-run only. |
| 7 | **Opportunity CRM** | ✅ | `applications.mjs` tracker, `tracker*.mjs`, `followup-cadence`, `reply-watch`, `agent-inbox`. |
| 8 | **Approval / policy engine** | ✅ | `path-safety/{policy,outbound-gate,capability-gateway,approval-packet,audit-ledger}.mjs`, `config/path.autonomy.yml`. |
| 9 | **PATH Brain** | ❌ | `path-brain/` scaffold: schemas (`contract.mjs`) + `fake-provider.mjs` + `no-model-provider.mjs`. **No real model provider wired.** `path-run.mjs` forces `fake`/`none`. |
| 10 | **Learning loop** | ⚠️ | `analyze-patterns.mjs`, `upskill.mjs`, `outcome.mjs`, `assessment-log.mjs`, `stats.mjs`, `funnel-velocity.mjs`. Analytics yes; **no automated feedback** into graph/brain/strategy. |

---

## 3. §17 "Still vision" — concrete status

| Vision item | Status | Repo evidence |
|---|---|---|
| Live LinkedIn integration + 2-way messaging | ❌ | No `api.linkedin`; `send_linkedin` exists only as a YELLOW policy type. |
| Live Indeed / Monster / ZipRecruiter / broad ATS connectivity | ⚠️ | Broad ATS *is* real (`providers/`). Indeed/Monster/ZipRecruiter absent. |
| Automatic job-specific CV rebuilt end-to-end vs live postings | ⚠️ | Tailoring exists (`openai-tailor.mjs`, `build-cv-*`); "live CV rebuild" is wired into the web apply/explore flow only partially. |
| Production email send | ❌ | No email transport. Gmail only read-ingest. |
| Auto email reply | ❌ | Reply classification exists; send doesn't. |
| LinkedIn outreach sending | ❌ | Drafts only (`modes/contacto.md`, `modes/email.md`); no `send_linkedin` transport. |
| Calling / voicemail | ❌ | No telephony anywhere. |
| Calendar / interview scheduling | ❌ | Ingest-only plugins, no booking/write. |
| Contact/extended-network workflows | ❌ | No contact graph. |
| Production deployment & autonomous scheduling | ❌ | Local-first; no deploy/scheduler. |

---

## 4. Desktop shell — shipped wrapper (this gap review covers it)

The `desktop/` Electron shell wraps the same `web/` Next.js app and launches it locally (`npm run desktop` or `desktop:dev`; `desktop:dist` builds installers).

- **Packaged-app fix (uncommitted working-tree change):** in a packaged app `__dirname` lives inside a **temp-extracted asar**, so `resolveRepo()` falls through to the candidate scan, which called the intended-but-not-imported alias `checkoutPaths()` → `ReferenceError: checkoutPaths is not defined` → Electron's default "Error" box and quit. Fixed by calling the imported `checkoutCandidates()` instead (one-line change in `desktop/main/index.cjs`). Dev/prod runs never hit this because `nearestCheckout()` returns first.
- Status: installer + portable build clean; window title `career-ops - official web experience` verified live.

**Desktop known issues:**
- **winCodeSign symlink workaround (machine-local):** `app-builder` tries to extract `winCodeSign` with `-snld` (force symlinks) on Windows → fails creating macOS `.dylib` symlinks. This machine pre-seeded `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` (content of the archive minus `darwin/`). Any machine without that dir will hit the failure — **needs CI/docs note, not a source fix.**
- Unsigned installers, default Electron icon, `author` missing from `desktop/package.json`.

---

## 5. Data state (fresh install, not "empty code")

- **Present:** `data/pipeline.md` (~147 KB URL inbox), `data/applications.md` + `.db`, `portal-health.tsv`, `scan-history.tsv`, `scan-runs.tsv`, `path-outbox.jsonl`, `path-audit.jsonl`, `cache/ats-companies/*.json`, `path-runs/run-safe-demo-*`.
- **Referenced-but-absent (created on demand):** `follow-ups.md`, `agent-inbox.md`, `reply-candidates.json`, `salary-observations.tsv`, `status-log.tsv`, `assessments.tsv`, `blacklist.md`, `outcomes/`, `path-approvals.jsonl`, `path-dispatch.jsonl`. `reports/` and `jds/` are `.gitkeep`-only.

---

## 6. Cross-cutting gaps worth flagging

1. **`modes/discover.md` missing but load-bearing** — required by the mode-integrity gate in `test-all.mjs` (line ~1918) and read at runtime by `web/src/app/api/explore/ai/route.ts` (returns `MODE_MISSING`). `modes/regional/eu-swe.md` **does** exist.
2. **`interview-prep/story-bank.md` missing** — required by `match-star.mjs`, `modes/_shared.md`, and `path-memory/evidence-selector.mjs`.
3. **`config/cv-facts.json` missing** (only `.example`) — `verify-cv-facts.mjs` defaults to it.
4. **Cover letter has no web surface** — core `generate-cover-letter.mjs` exists, but no `/api/run` kind or page in `web/` exposes it.
5. **People ledger shipped, graph edges deferred** — the ledger (`path-safety/contacts.mjs`, `data/contacts.jsonl`) now prevents per-person duplicate contact, and a read-only `/api/contacts` web surface exposes it (`09c0bc5`). Graph edges, and channel-scoped dedup remain unbuilt.
6. **PATH Brain is not functional** — no real provider; `path-run.mjs` hard-forces `fake`/`none`.
7. **Approval gate is air-tight but terminates at HUMAN_REVIEW** — real physical sending doesn't exist; audit + outbox + approvals are fully wired *for the record*.

---

## 7. Verdict

The repo is the vision's **job-seeker core, fully and maturely built**, plus a **hardened human-in-the-loop recruiter MVP-1** that stops at review. Everything downstream of "prepared draft + approved" (§7 communications, real LinkedIn/call/email, contact graph, PATH Brain, learning loop, deployment) is genuinely **not yet built** — matching §17 of the vision honestly.

The gaps are **not empty code**: the machinery (approval packets, outboxes, claim checks, versioned artifacts, tracker, contact ledger) is real and tested. The core missing piece across the remaining vision items is still **transport** — with the people ledger groundwork now in place for the contact graph.