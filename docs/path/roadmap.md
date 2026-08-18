# PATH Roadmap (2026-08 redo)

> **Purpose:** Phase-by-phase plan for closing the gaps in `docs/path/gap-review.md`, rebuilt with explicit **skill gates** so each phase has a defined process (design → plan → execution) and an **exit criterion** (tests green + disciplined-work gate passed). Living reference, not a spec.
>
> **Date:** 2026-08-13.
> **Status legend:** ⬜ planned · 🟡 in-flight · ✅ done · 🔶 deferred.

---

## Source of truth

| Artifact | Role |
|---|---|
| `docs/path/gap-review.md` (2026-08-08) | Vision vs. repo reality — the authoritative gap list |
| `docs/path/recruiter-mvp1.md` | Approved recruiter MVP-1 contract (stops at HUMAN_REVIEW) |
| `docs/superpowers/plans/*` | Shipped/in-flight implementation plans |
| `docs/superpowers/specs/*` | Design docs for planned work |
| `config/profile.yml` · `cv.md` · `modes/_profile.md` | User layer — never auto-overwritten |

## Legend: skill gates

Each phase names the skills to run **in order**. Process skills first, then implementation skills. Exit criterion must be demonstrated (evidence, not assertion) before a phase is marked done.

- **brainstorming** — design work: explore intent before building
- **writing-plans** — turn approved design into a task checklist
- **subagent-driven-development** — execute the plan with parallel workers + review checkpoints
- **da** / **dave** — adversarial evaluation of the design before it's locked
- **checkpoint** — save state per task so work survives context resets
- **build-fix** — resolve build/test failures fast
- **verification-before-completion** — run tests + the disciplined-work gate before claiming done
- **gstack-setup-gbrain** — knowledge-graph/index infra for PATH Brain
- **coding-standards** — enforce repo conventions on new code
- **plan** / **orchestrate** — multi-worker coordination for the heavy phase

---

## Phase 0 — Stabilize

> **Goal:** Unbreak what's load-bearing but missing. No new features. Exit = `node test-all.mjs` green.

| # | Item | Evidence it's needed | Status |
|---|---|---|---|
| 0.1 | Create `modes/discover.md` | Breaks the mode-integrity gate in `test-all.mjs` (~line 1918) + web `/api/explore/ai` returns `MODE_MISSING` | ✅ |
| 0.2 | Create `interview-prep/story-bank.md` | Required by `match-star.mjs`, `modes/_shared.md`, `path-memory/evidence-selector.mjs` | ⬜ (optional user-layer file, not suite-gated) |
| 0.3 | Create `config/cv-facts.json` | Only `.example` exists; `verify-cv-facts.mjs` defaults to it | ⬜ (optional user-layer file, not suite-gated) |
| 0.4 | Create the 10 missing `.mjs` scripts referenced by `test-all.mjs` | `MODULE_NOT_FOUND` crashes: `check-table-freshness`, `discover-ats`, `company-history`, `weekly-digest`, `contacts`, `discover-ats.test`, `company-history.test`, `contacts.test`, `validate-untrusted-content-coverage`, `seed-fixture` | ✅ |
| 0.5 | (Optional) Update career-ops v1.22.0 → v1.26.0 | `node update-system.mjs check` reports update available; user data untouched | ✅ v1.26.0 |

**Skill gate:** `build-fix` → `verification-before-completion`.
**Exit criterion:** `node test-all.mjs` passes end-to-end.

---

## Phase 1 — Finish partial subsystems

> **Goal:** Close the ⚠️ subsystems so nothing is "offline / not wired / missing data." Exit = each item's plan complete + tests green.

| # | Subsystem | Work | Design exists? | Status |
|---|---|---|---|---|
| 1.1 | Contact graph (#5) | Name-only dedup (last unbuilt piece of the ledger) — `findPersonByName` + `isContactedByNameOnChannel` + distinct `c-n-` identity namespace + backfill seeds name+channel records; gate consults name path after email path; tests + docs updated | `2026-08-09-name-only-dedup-design.md` | ✅ |
| 1.2 | Career truth store (#3) | Populate approved-fact store (currently 2 facts); wire external verification into `verify-cv-facts.mjs` | `2026-08-14-career-truth-store-design.md` | ✅ |
| 1.3 | Learning loop (#10) | Close the loop: `analyze-patterns.mjs`/`stats.mjs` analytics → feedback into graph/brain/strategy | `2026-08-14-learning-loop-design.md` | ✅ |

**Skill gate:** per item: `brainstorming` → `da`/`dave` on design → `writing-plans` → `subagent-driven-development` → `checkpoint` per task → `verification-before-completion`.
**Exit criterion:** each item's plan file ticked, `node test-all.mjs` green, `.disciplined-work` gate passed.

---

## Phase 2 — PATH Brain

> **Goal:** Make subsystem #9 functional — a real model provider replaces the hard-forced `fake`/`none` in `path-run.mjs`.

| # | Work | Status |
|---|---|---|
| 2.1 | Wire a real model provider into `path-brain/` (currently `fake-provider.mjs` + `no-model-provider.mjs` only) | ✅ |
| 2.2 | Remove the hard-force in `path-run.mjs`; route through the approval/policy engine | ✅ |

**Skill gate:** `gstack-setup-gbrain` (index/infra) → `brainstorming` → `da` → `writing-plans` → `subagent-driven-development` → `verification-before-completion`.
**Exit criterion:** an evaluation runs through PATH Brain with a real provider under the YELLOW/GREEN approval rules; `fake`/`none` become explicit opt-in, not the default.

---

## Phase 3 — Communications hub / transport

> **Goal:** The largest gap (#6, 20% done). Outbox + approval gate exist; **no transport/send channel anywhere.** Exit = a human-approved packet actually sends.

| # | Work | Design exists? | Status |
|---|---|---|---|
| 3.1 | Gmail send (production email outbound) | `2026-08-08-gmail-send-design.md` | ⬜ |
| 3.2 | Auto email reply (reply classification exists; send doesn't) | — | ⬜ |
| 3.3 | LinkedIn outreach send | Drafts-only today (`modes/contacto.md`, `modes/email.md`); `send_linkedin` exists as a YELLOW policy type only | 🔶 deferred |
| 3.4 | Calling / voicemail / telephony | Not on this roadmap | 🔶 deferred |

**Skill gate:** `brainstorming` → `da`/`dave` (high-stakes: real send = real consequences) → `writing-plans` → `coding-standards` → `subagent-driven-development` with `plan` + `orchestrate` → `verification-before-completion`.
**Exit criterion:** a packet built by the approval pipeline sends via Gmail with the audit ledger + outbox reconciled. User reviews before every send — never auto-send.

---

## Phase 4 — Deployment & scheduling

> **Goal:** Local-first → scheduled/autonomous operation (still human-gated for anything YELLOW/RED).

| # | Work | Status |
|---|---|---|
| 4.1 | Scheduler (scan cadence, follow-up cadence, reply-watch cadence) | ⬜ |
| 4.2 | Production deployment path (packaged desktop shell exists; scheduler + headless ops don't) | ⬜ |

**Skill gate:** `plan` → `da` → `subagent-driven-development` → `verification-before-completion`.
**Exit criterion:** a scheduled pipeline run executes unattended; approval-gated actions still stop at HUMAN_REVIEW.

---

## Cross-cutting rules

- **Never fabricate claims.** Proof points come from `cv.md`, `article-digest.md`, `config/profile.yml` only. "Keywords get reformulated, never fabricated."
- **User layer vs system layer.** Customization → `modes/_profile.md`, `config/profile.yml`, `modes/_custom.md`. Never `modes/_shared.md`.
- **Ethics.** Below-4.0/5 fit → recommend against applying. Never submit without human review.
- **Pipeline integrity.** Tracker additions via `batch/tracker-additions/*.tsv` + `merge-tracker.mjs`. Status changes via `set-status.mjs`.
- **Verification.** Every phase ends with `node test-all.mjs` + `.disciplined-work/run_gate.py` before "done" is claimed. **Note (2026-08-14):** `.disciplined-work/run_gate.py` does not exist and never was committed (`git log --all -- .disciplined-work/` empty; the AGENTS.md marker is a plugin injection). Until the gate is created, phases 1.2/1.3 record the full test-all suite + targeted suites as the standing-in evidence (variance documented in each plan file).

---

## Open risks

1. **Duplicate repo locations** — `gap-review.md` says the real repo is `C:\Users\van1h\Documents\GitHub\Path` and the OneDrive copy is "near-empty"; this session verified the OneDrive dir is the full active repo. Confirm the canonical copy before any deployment/backup assumes one.
2. **Playwright MCP not detected** for the active CLI — offer-liveness verification falls back to WebFetch/`unconfirmed` until configured.
3. **Drive backup is a snapshot, not sync** — `career-ops/backups/` uploads are point-in-time. For continuous backup, consider a scheduled re-upload.
