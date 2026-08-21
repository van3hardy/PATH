// The ONE action registry — the single source of truth for "what can be done".
// Both UI controls and the assistant dispatch the SAME entries via dispatch(),
// so the human UI and the agentic UI can never drift. Pure module (no React
// hooks): the caller assembles `ctx` from its hooks and passes it in.
//
// The model emits intents as a vendor-neutral text envelope (<<act:ID {json}>>),
// parsed CLIENT-SIDE; the registry validates args by hand (no zod dep) and gates
// side-effects. Resolution of "all the Anthropic ones" happens here, off the
// client pipeline snapshot — the model never sees or invents URLs.
//
// Every consequential action returns a `confirm` result with a catalog
// capabilityId and frozen resources. The `run` closure is one-shot and captures
// arguments by value, so model-supplied JSON cannot self-approve or mutate
// behaviour after dispatch. Navigation and filtering are immediate local reads.

import type { Application, InboxJob } from "@/lib/career-ops";
import type { Job } from "@/components/jobs/job-store";

export const BATCH_CAP = 12; // hard ceiling on a single fan-out

// Canonical states (templates/states.yml) — the web validates against the same set.
const CANON_STATUS = ["Evaluated", "Applied", "Responded", "Interview", "Offer", "Rejected", "Discarded", "SKIP", "Hired"];

const TAB_VALUES = [
  "INBOX", "ALL", "EVALUATED", "APPLIED", "RESPONDED", "INTERVIEW", "OFFER", "REJECTED", "DISCARDED", "SKIP", "HIRED",
] as const;
const SORT_VALUES = ["company", "role", "score", "status", "date"] as const;

export type StartJobInput = {
  title: string;
  subtitle?: string;
  kind: string;
  input: string;
  page?: string;
  batchId?: string;
};

export type ActionCtx = {
  push: (path: string) => void; // router.push — section/detail change
  replace: (path: string) => void; // router.replace — incremental filter tweak
  startJob: (opts: StartJobInput) => string | null;
  inbox: InboxJob[];
  applications: Application[]; // tracker snapshot — resolve #n → company/role for confirms
  jobForUrl: (url: string) => Job | undefined; // skip-if-done / retry logic
  rememberFact: (fact: string) => void;
  writeStatus: (n: string, status: string) => void; // UPDATE-only writeback via /api/status
  setApplyField: (idOrLabel: string, value: string) => void; // edit an apply-proxy answer
  startApply: (url: string) => void; // open the apply form-proxy for a posting URL
  applyExplore?: (patch: Record<string, unknown>, opts?: { merge?: boolean; run?: boolean }) => void; // build a FREE discovery search
  writeProfile?: (patch: Record<string, unknown>) => void; // merge-safe config/profile.yml write
  writePortals?: (roles: string[], location?: string[]) => void; // merge-safe portals.yml title_filter write
};

export type ProfilePatch = {
  name?: string;
  email?: string;
  location?: string;
  roles?: string[];
  compMin?: number;
  compMax?: number;
  currency?: string;
  remote?: string;
  seniority?: string;
};

export type DoneInfo = { jobIds?: string[]; batchId?: string; note?: string };

export type ResourceRef = {
  type: "local" | "external" | "model";
  id: string;
  destination?: string;
};

export type ConfirmResult = {
  status: "confirm";
  summary: string;
  capabilityId: string;
  resources: ReadonlyArray<Readonly<ResourceRef>>;
  run: () => DoneInfo;
};

export type DispatchResult =
  | ({ status: "done" } & DoneInfo)
  | { status: "ignored"; note?: string }
  | ConfirmResult;

// ── helpers ──────────────────────────────────────────────────────────────
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const normCompany = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// Allow only in-app routes (with optional :segment and ?query). Blocks anything
// that isn't one of the app's own sections — the model can't navigate offsite.
function isAllowedPath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (/^(https?:)?\/\//i.test(p)) return false;
  const path = p.split(/[?#]/)[0];
  if (path === "/") return true;
  return /^\/(explore|pipeline|portals|analytics|cv|config|apply|jobs)(\/[^/]+)?$/.test(path);
}

function genBatchId(): string {
  return `batch-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

// House-style hand validation (no zod). Keeps only well-formed, confident fields.
function coerceProfile(raw: Record<string, unknown>): ProfilePatch {
  const out: ProfilePatch = {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  out.name = str(raw.name);
  out.email = str(raw.email);
  out.location = str(raw.location);
  out.currency = str(raw.currency);
  out.remote = str(raw.remote);
  out.seniority = str(raw.seniority);
  out.compMin = num(raw.compMin);
  out.compMax = num(raw.compMax);
  if (Array.isArray(raw.roles)) out.roles = raw.roles.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim()).slice(0, 6);
  return out;
}

// Build a confirm result with frozen resources and a one-shot run closure.
// The closure captures arguments by value so post-dispatch mutation cannot
// change the executed intent.
function confirm(
  capabilityId: string,
  resources: ResourceRef[],
  summary: string,
  run: () => DoneInfo,
): ConfirmResult {
  const frozenResources = Object.freeze(
    resources.map((r) => Object.freeze({ ...r })),
  ) as unknown as ReadonlyArray<Readonly<ResourceRef>>;
  let called = false;
  return {
    status: "confirm",
    capabilityId,
    resources: frozenResources,
    summary,
    run: () => {
      if (called) return {} as DoneInfo;
      called = true;
      return run();
    },
  };
}

// ── actions ──────────────────────────────────────────────────────────────
type ActionDef = {
  run: (raw: Record<string, unknown>, ctx: ActionCtx) => DispatchResult;
};

const ACTIONS: Record<string, ActionDef> = {
  navigate: {
    run: (raw, ctx) => {
      const p = raw.path;
      if (!isStr(p) || !isAllowedPath(p)) return { status: "ignored", note: "blocked navigation" };
      ctx.push(p);
      return { status: "done" };
    },
  },

  filterPipeline: {
    run: (raw, ctx) => {
      const sp = new URLSearchParams();
      const tab = typeof raw.tab === "string" ? raw.tab.toUpperCase() : "";
      if ((TAB_VALUES as readonly string[]).includes(tab)) sp.set("tab", tab);
      const min = typeof raw.min === "number" ? raw.min : parseFloat(String(raw.min ?? ""));
      if (Number.isFinite(min) && min >= 0 && min <= 5) sp.set("min", String(min));
      if (isStr(raw.q)) sp.set("q", String(raw.q).slice(0, 80));
      const sort = typeof raw.sort === "string" ? raw.sort : "";
      if ((SORT_VALUES as readonly string[]).includes(sort)) sp.set("sort", sort);
      const dir = Number(raw.dir);
      if (dir === 1 || dir === -1) sp.set("dir", String(dir));
      const qs = sp.toString();
      ctx.replace(`/pipeline${qs ? `?${qs}` : ""}`);
      return { status: "done" };
    },
  },

  evaluate: {
    run: (raw, ctx) => {
      const url = raw.url;
      if (!isStr(url) || !/^https?:\/\//i.test(url)) return { status: "ignored", note: "invalid url" };
      const ex = ctx.jobForUrl(url);
      if (ex && ex.status !== "error" && !raw.rerun) return { status: "ignored", note: "already evaluated" };
      const title = isStr(raw.title) ? String(raw.title) : "Evaluate";
      const input = String(url);
      return confirm("model.invoke", [{ type: "model", id: "evaluate" }],
        `Evaluate "${title}"?`,
        () => {
          const id = ctx.startJob({ title, kind: "evaluate", input, page: "/pipeline" });
          return { jobIds: id ? [id] : [] };
        });
    },
  },

  evaluateCompany: {
    run: (raw, ctx) => {
      const company = raw.company;
      if (!isStr(company)) return { status: "ignored", note: "missing company" };
      const target = normCompany(company);
      const rerun = raw.rerun === true;
      const cap = Number.isFinite(Number(raw.max)) ? Math.min(BATCH_CAP, Number(raw.max)) : BATCH_CAP;

      const matches = ctx.inbox.filter((j) => {
        if (j.done) return false;
        const c = normCompany(j.company);
        return c === target || c.includes(target) || target.includes(c);
      });
      const pending = matches
        .filter((j) => {
          if (rerun) return true;
          const ex = ctx.jobForUrl(j.url);
          return !ex || ex.status === "error";
        })
        .slice(0, cap);

      if (pending.length === 0) {
        return {
          status: "ignored",
          note: matches.length > 0 ? `Already evaluated every ${company} posting.` : `No pending ${company} postings in your inbox.`,
        };
      }

      // Snapshot by value so post-dispatch inbox mutation cannot change the batch.
      const snapshot = pending.map((j) => ({ company: j.company, role: j.role, url: j.url }));

      return confirm("model.invoke", [{ type: "model", id: "evaluate" }],
        `Evaluate ${pending.length} ${company} posting${pending.length > 1 ? "s" : ""}?`,
        () => {
          const batchId = snapshot.length > 1 ? genBatchId() : undefined;
          const ids = snapshot
            .map((j) =>
              ctx.startJob({
                title: `Evaluate · ${j.company}`,
                subtitle: j.role,
                kind: "evaluate",
                input: j.url,
                page: "/pipeline",
                ...(batchId !== undefined ? { batchId } : {}),
              }),
            )
            .filter((x): x is string => !!x);
          return { jobIds: ids, batchId };
        });
    },
  },

  explore: {
    // Opens the Explorer and builds a discovery search. Zero tokens — it never
    // spends, so it bypasses the confirm gate. The provider clamps/validates.
    run: (raw, ctx) => {
      const applyExplore = ctx.applyExplore;
      if (!applyExplore) return { status: "ignored", note: "explore unavailable here" };
      const run = raw.run === true;
      const merge = raw.merge === true;
      // Clone raw so post-dispatch mutation cannot alter the explore payload.
      const rawClone = structuredClone(raw) as Record<string, unknown>;
      const opts = Object.freeze({ merge, run });
      return confirm("external.read",
        [{ type: "external", id: "job-discovery", destination: "configured-ATS-providers" }],
        `Open Explore with your filters?${run ? " (will start scanning)" : ""}`,
        () => {
          ctx.push("/explore");
          applyExplore(rawClone, opts);
          return {};
        });
    },
  },

  research: {
    run: (raw, ctx) => {
      const target = raw.target;
      if (!isStr(target)) return { status: "ignored", note: "missing target" };
      const title = isStr(raw.title) ? String(raw.title) : "Research";
      const input = String(target);
      return confirm("model.invoke", [{ type: "model", id: "research" }],
        `Research "${title}"?`,
        () => {
          const id = ctx.startJob({ title, kind: "research", input, page: "/pipeline" });
          return { jobIds: id ? [id] : [] };
        });
    },
  },

  generatePdf: {
    run: (raw, ctx) => {
      const n = String(raw.n ?? "").trim();
      if (!n) return { status: "ignored", note: "need an application #" };
      const app = ctx.applications.find((a) => a.n === n);
      const title = `CV PDF · ${app?.company ?? `#${n}`}`;
      const page = `/pipeline/${n}`;
      const input = n;
      return confirm("model.invoke", [{ type: "model", id: "pdf" }],
        `Generate CV PDF for ${app ? `${app.company} · ${app.role}` : `#${n}`}?`,
        () => {
          const id = ctx.startJob({ title, subtitle: "tailored CV", kind: "pdf", input, page });
          return { jobIds: id ? [id] : [] };
        });
    },
  },

  setStatus: {
    run: (raw, ctx) => {
      const n = String(raw.n ?? "").trim();
      const status = String(raw.status ?? "").trim();
      const canon = CANON_STATUS.find((s) => s.toLowerCase() === status.toLowerCase());
      if (!n || !canon) return { status: "ignored", note: "need an application # and a canonical status" };
      const app = ctx.applications.find((a) => a.n === n);
      const label = app ? `${app.company} · ${app.role}` : `#${n}`;
      const nn = n;
      const cc = canon;
      return confirm("local.write", [{ type: "local", id: "data/applications.md" }],
        `Mark ${label} → ${cc}?`,
        () => {
          ctx.writeStatus(nn, cc);
          return { note: `Marked #${nn} as ${cc}.` };
        });
    },
  },

  apply: {
    run: (raw, ctx) => {
      const url = raw.url;
      if (!isStr(url) || !/^https?:\/\//i.test(url)) return { status: "ignored", note: "need an application form URL" };
      let destination: string;
      try {
        destination = new URL(url).hostname;
      } catch {
        return { status: "ignored", note: "need an application form URL" };
      }
      const u = url;
      return confirm("browser.navigate",
        [{ type: "external", id: "application-form", destination }],
        `Open the application form for ${destination}? (does not submit)`,
        () => {
          ctx.startApply(u);
          return { note: "Opening the application form…" };
        });
    },
  },

  setApplyField: {
    run: (raw, ctx) => {
      const field = (raw.field ?? raw.label) as unknown;
      const value = raw.value;
      if (!isStr(field) || typeof value !== "string") return { status: "ignored", note: "need a field and a value" };
      const f = String(field);
      const v = value;
      return confirm("local.write", [{ type: "local", id: "apply-session" }],
        `Set "${f}" to "${v}"?`,
        () => {
          ctx.setApplyField(f, v);
          return { note: `Updated "${f}".` };
        });
    },
  },

  remember: {
    run: (raw, ctx) => {
      const fact = raw.fact;
      if (!isStr(fact)) return { status: "ignored" };
      const trimmed = String(fact).trim();
      return confirm("local.write", [{ type: "local", id: "modes/_profile.md" }],
        `Remember: "${trimmed}"?`,
        () => {
          ctx.rememberFact(trimmed);
          return { note: `Remembered: "${trimmed}".` };
        });
    },
  },

  // Propose the user's profile → on confirm, merge-safe write to config/profile.yml
  // AND seed the scanner (portals.yml title_filter) so the very first scan has roles.
  // DATA_CONTRACT: deep-merge only proposed keys; never clobber archetypes/narrative.
  setProfile: {
    run: (raw, ctx) => {
      if (!ctx.writeProfile) return { status: "ignored", note: "profile write unavailable here" };
      const p = coerceProfile(raw);
      const has = Object.values(p).some((v) => (Array.isArray(v) ? v.length : v !== undefined));
      if (!has) return { status: "ignored", note: "nothing to save" };
      const resources: ResourceRef[] = [{ type: "local", id: "config/profile.yml" }];
      if (p.roles?.length) resources.push({ type: "local", id: "portals.yml" });
      const bits = [p.roles?.length ? `roles: ${p.roles.join(", ")}` : "", p.location ? `in ${p.location}` : "", p.compMin && p.compMax ? `comp ${p.compMin}–${p.compMax}` : ""].filter(Boolean).join(" · ");
      const profileSnapshot = Object.fromEntries(
        Object.entries(p).filter(([, v]) => v !== undefined),
      ) as ProfilePatch;
      return confirm("local.write", resources,
        `Save your profile?${bits ? ` (${bits})` : ""}`,
        () => {
          ctx.writeProfile!(profileSnapshot as Record<string, unknown>);
          if (profileSnapshot.roles?.length) ctx.writePortals?.([...profileSnapshot.roles], profileSnapshot.location ? [profileSnapshot.location] : undefined);
          return { note: "Profile saved — your matches will sharpen." };
        });
    },
  },

  setPortals: {
    run: (raw, ctx) => {
      if (!ctx.writePortals) return { status: "ignored", note: "portals write unavailable here" };
      const roles = Array.isArray(raw.roles) ? raw.roles.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim()) : [];
      if (roles.length === 0) return { status: "ignored", note: "no roles" };
      const location = Array.isArray(raw.location) ? raw.location.filter((l): l is string => typeof l === "string").map((l) => l.trim()) : undefined;
      // Deep-copy so post-dispatch mutation of the caller's arrays cannot change the batch.
      const rolesSnapshot = [...roles];
      const locationSnapshot = location ? [...location] : undefined;
      return confirm("local.write", [{ type: "local", id: "portals.yml" }],
        `Set your scan targets to: ${rolesSnapshot.join(", ")}?`,
        () => {
          ctx.writePortals!(rolesSnapshot, locationSnapshot);
          return { note: "Scan targets updated." };
        });
    },
  },
};

export function actionExists(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACTIONS, id);
}

export function dispatch(id: string, rawArgs: Record<string, unknown>, ctx: ActionCtx): DispatchResult {
  const def = ACTIONS[id];
  if (!def) return { status: "ignored", note: `unknown action: ${id}` };
  try {
    return def.run(rawArgs ?? {}, ctx);
  } catch {
    return { status: "ignored", note: `could not run ${id}` };
  }
}
