import { openSession } from "@/lib/apply/session";
import { authorizeDirectUiGesture, executeWebCapability } from "@/lib/server/capability-gateway";
import { sha256Hex } from "@/lib/server/sha256";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // the agentic drive + interpretation fallbacks spawn a planner

// Open a persistent apply session: headed-but-off-screen Chrome opens the real
// form, we extract + tag its fields. The session stays open for fill + handoff.
// cliId enables the agentic fallback (the AI interprets the live form) when
// deterministic extraction is low-confidence.
export async function POST(req: Request) {
  let body: { url?: string; cliId?: string; agent?: boolean; _noApplyBtn?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return Response.json({ error: "A valid application URL (https://…) is required" }, { status: 400 });

  const hostname = new URL(url).hostname;
  const metadata = { hostname, sessionIdHash: sha256Hex(url), fieldCount: 0 };
  const resources = [{ type: "external" as const, id: "application-form", destination: hostname }];
  const auth = await authorizeDirectUiGesture("browser.navigate", metadata, resources);
  if (auth.decision === "DENY") return Response.json({ error: "capability denied", code: auth.code }, { status: 403 });
  if (auth.decision !== "ALLOW") return Response.json({ error: "approval required", code: auth.code, scopeHash: auth.scopeHash }, { status: 409 });

  try {
    const session = await executeWebCapability(
      "browser.navigate", "direct_user", metadata, resources,
      () => openSession(url, body.cliId, body.agent, body._noApplyBtn),
      auth.approval,
    );
    return Response.json(session);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "could not open the form" }, { status: 500 });
  }
}
