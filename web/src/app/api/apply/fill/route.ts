import { fillSession, handoffSession, getSession } from "@/lib/apply/session";
import { resolveTailoredCv, companyFromTitle } from "@/lib/apply/cv";
import { authorizeDirectUiGesture, executeWebCapability } from "@/lib/server/capability-gateway";
import { sha256Hex } from "@/lib/server/sha256";
import type { ApplyField } from "@/lib/apply/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Fill the real form behind the scenes (headed-but-off-screen), screenshotting
// each step for the "behind the scenes" strip, then bring the window to the front
// so the HUMAN reviews and submits. NEVER submits — there is no submit path here.
export async function POST(req: Request) {
  let body: { sessionId?: string; answers?: Record<string, string>; fields?: ApplyField[]; handoff?: boolean; company?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const { sessionId, answers = {}, fields = [], handoff, company } = body;
  if (!sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });

  const session = getSession(sessionId);
  if (!session) return Response.json({ error: "apply session not found" }, { status: 404 });
  const hostname = session.url ? new URL(session.url).hostname : "unknown";
  const metadata = { hostname, sessionIdHash: sha256Hex(sessionId), fieldCount: fields.length };
  const resources = [{ type: "external" as const, id: "application-form", destination: hostname }];
  const auth = await authorizeDirectUiGesture("browser.fill", metadata, resources);
  if (auth.decision === "DENY") return Response.json({ error: "capability denied", code: auth.code }, { status: 403 });
  if (auth.decision !== "ALLOW") return Response.json({ error: "approval required", code: auth.code, scopeHash: auth.scopeHash }, { status: 409 });

  const cvPath = resolveTailoredCv(company) ?? resolveTailoredCv(companyFromTitle(session.title)) ?? undefined;

  try {
    const result = await executeWebCapability(
      "browser.fill", "direct_user", metadata, resources,
      () => fillSession(sessionId, answers, fields, cvPath),
      auth.approval,
    );
    if (handoff) await handoffSession(sessionId).catch(() => {});
    return Response.json({ ...result, handedOff: !!handoff, cvAttached: !!cvPath });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "fill failed" }, { status: 500 });
  }
}
