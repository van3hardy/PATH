"use client";

import { useMemo } from "react";
import Link from "next/link";
import { FileDown, Loader2, FileText, RotateCcw } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";

// Fires the real career-ops cover mode (worker kind "cover-letter") → an
// AI-drafted, tailored cover letter rendered to output/ by
// generate-cover-letter.mjs, grounded in the evaluation report + CV. The worker
// NEVER submits or contacts anyone — draft + render + report path only.
export function GenerateCoverButton({ n, company }: { n: string; company: string }) {
  const { jobs, startJob } = useJobs();
  const job = useMemo(
    () => jobs.filter((j) => j.kind === "cover-letter" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  const generate = () =>
    startJob({ title: `Cover letter · ${company}`, subtitle: "tailored to this role", kind: "cover-letter", input: n, page: `/pipeline/${n}` });

  if (job?.status === "running")
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand max-sm:min-h-[44px]">
        <Loader2 className="size-3.5 animate-spin" /> Writing cover letter…
      </Link>
    );

  if (job?.status === "done")
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400 max-sm:min-h-[44px]">
        <FileText className="size-3.5" /> Cover letter written — view
      </Link>
    );

  if (job?.status === "error")
    return (
      <button
        onClick={generate}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-amber-500/40 px-3 py-1 text-xs font-medium text-amber-600 transition-colors hover:border-amber-500/60 dark:text-amber-400 max-sm:min-h-[44px]"
        title="The previous attempt hit an error — retry"
      >
        <RotateCcw className="size-3.5" /> Retry cover letter
      </button>
    );

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={generate}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
        title="Draft a cover letter tailored to this role (uses your AI)"
      >
        <FileDown className="size-3.5" /> Cover letter
      </button>
      <CostBadge kind="spend" size="xs" />
    </span>
  );
}