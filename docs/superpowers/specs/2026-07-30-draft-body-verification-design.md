# Draft-body verification design

Date: 2026-07-30
Status: approved, not implemented
Applies to: Path recruiter MVP-1

## Problem

Claim validation checks the provider's self-declared `claims` array against
approved evidence. It never inspects `brainOutput.text` — the draft that
becomes `packet.finalText` and that a human would send.

`claim-report.mjs:22` and `approval-packet.mjs:80` both resolve
`brainOutput.claims`. The draft is hashed into `draftSha256` and otherwise
ignored.

With the deterministic template the declared claims are copied verbatim from
the evidence quotes (`recruiter-template.mjs:44`), so resolution compares the
evidence to itself and cannot fail. A run reporting `unsupportedClaims: []`
has verified one sentence out of six. The other five — greeting, the
interpolated role and company, the closing question, the signature, and the
AI-assistance disclosure — are never examined.

The harm is not a wrong answer. It is false confidence: `unsupportedClaims: []`
reads as "the draft is clean" and means "the declared claims matched".

A containment check added on 2026-07-30 requires every declared claim to appear
in the draft. That closes the inverse gap — a provider declaring a claim it
never wrote — but still says nothing about undeclared draft content.

## Decisions

Four decisions fix the shape of this design.

1. **A real model is the goal.** The template is scaffolding. Any check that
   only works against deterministic output is a dead end, which rules out
   reconstructing the expected draft and comparing for equality.

2. **Report, do not block.** The workflow already stops at `HUMAN_REVIEW` and
   nothing sends without human approval. The checker's job is to give the
   reviewer an accurate picture, not to be the last line of defence. Blocking
   on unbacked sentences would reject nearly every real-model draft and would
   be switched off.

3. **The existing hard block stays.** A declared claim that does not resolve
   still returns `BLOCKED_UNSUPPORTED_CLAIMS`. The new classification is
   additive and report-only. No current behaviour changes.

4. **Classify by source, not by score.** Reporting only "backed / not backed"
   flags the signature and the closing question on every clean run, and a
   report that is always noisy stops being read. Scoring by word overlap
   reintroduces false confidence with a number attached and needs an arbitrary
   threshold.

## Architecture

One new module, `path-workflows/recruiter/draft-classifier.mjs`, exporting a
pure function:

```js
classifyDraft({ text, evidenceItems, request }) -> {
  sentences: [{ text, label, evidenceId? }],
  counts: { EVIDENCE, REQUEST, TEMPLATE, UNVERIFIED },
  unverified: [...]
}
```

No filesystem access, no clock, no throwing on unverified content. Same inputs
produce the same output, so it is testable without sandboxes or fixtures.

Separate from `claim-report.mjs`, which already validates provider output and
resolves declared claims. A third responsibility in that file would make it the
largest module in `path-workflows/`. The subsystem's pattern is small
single-purpose modules; `summary-writer.mjs` is 646 bytes.

### Unit of classification

"Sentence" throughout this document means a chunk produced by `splitClaims`,
not a linguistic sentence. The distinction matters. Applied to current template
output, `splitClaims` yields four chunks, not six:

1. `"Hello {name},\n\nI'm reaching out on Van's behalf about the {role} opportunity at {company}."`
   — the greeting has no terminal punctuation, so it stays joined to the next line
2. the evidence quote
3. `"If this background may be relevant, would you be open to a conversation?"`
4. `"Best,\nVan\nPrepared with Path, Van's AI recruiting assistant."`
   — three lines, no interior terminal punctuation, one chunk

The classifier therefore compares chunks to chunks. It builds its expected sets
by rendering the template frames with the actual request values and splitting
the result with the same `splitClaims`, so any quirk in the splitter affects
both sides identically and cancels out.

### Labels

| Label | Meaning |
| --- | --- |
| `EVIDENCE` | Matches an approved fact quote. Carries the matching `evidenceId`. |
| `REQUEST` | Matches a template frame that interpolates request values — `recipient.name`, `opportunity.company`, `opportunity.role`. Chunk 1 above. |
| `TEMPLATE` | Matches a template frame with no interpolation, identical on every run. Chunks 3 and 4 above. |
| `UNVERIFIED` | None of the above. |

`REQUEST` and `TEMPLATE` are both template-derived; they are separated by
whether operator-supplied values appear in the chunk. That separation is the
point: `TEMPLATE` content is constant and carries no assertion about the
candidate, while `REQUEST` content asserts a company, role, or recipient that
nobody verified — the operator typed it.

Matching uses the existing normalisation — trim, collapse whitespace runs,
lowercase — for consistency with `fact-resolver.mjs:68`. Labels are evaluated
in the order above and the first match wins, so a chunk that is both an
evidence quote and template wording is reported as `EVIDENCE`.

### Single source of truth for template wording

The boilerplate sentences live inside a template literal in
`recruiter-template.mjs:47-57`. The classifier must recognise them.

Duplicating them into the classifier guarantees drift: an edit to the greeting
would silently reclassify it as `UNVERIFIED`, and the first symptom would be a
noisy report.

`recruiter-template.mjs` therefore exports its fixed parts as named values, and
both the renderer and the classifier read them. This restructures the literal
without changing the text it produces. Test 1 below enforces the invariant.

## Data flow

```
recruiter-workflow.mjs:87
  buildClaimReport({ brainOutput, selection, request })   // request is new
    +- classifyDraft({ text, evidenceItems, request })
         +- report.draftClassification = { sentences, counts, unverified }
  -> claim-report.json                            (already written, line 88)
  -> claimArtifact.sha256 -> claimReportHash -> packet   (already bound)
```

`request` is already in scope at the call site (`recruiter-workflow.mjs:47`).
That signature change is the only edit to the workflow.

Because `claimReportHash` is already folded into `integritySha256`
(`packet-integrity.mjs:36`), placing the classification in `claim-report.json`
makes it tamper-evident with no additional code: the verification record cannot
be altered without invalidating the packet.

### Reviewer-facing output

`run-summary.md` is what a human reads before approving. It gains one line, and
a section only when there is something to report.

Clean run, current template, one evidence item:

```
- Draft segments: 4 - all accounted for
  (1 evidence, 1 from request, 2 template wording)
```

Run with unverified content:

```
- Draft segments: 6 - 2 UNVERIFIED

## Unverified segments
1. "Van led a 12-person ML platform team at Google."
2. "He can start immediately."
```

"Segments" rather than "sentences", because `splitClaims` chunks are not
sentences and calling them sentences would misrepresent what was checked.

The wording is "accounted for", never "verified". `REQUEST` means the operator
supplied the value; `TEMPLATE` means fixed wording; only `EVIDENCE` means an
approved fact backs the sentence. Collapsing the three into "verified" would
rebuild the false confidence this design exists to remove.

`claim-report.json` carries the full per-sentence breakdown. The summary shows
only what needs attention.

## Error handling

The governing principle: **a missing classification must never look like a
clean one.** Absence reading as safety is the original defect.

- `classifyDraft` never throws for `UNVERIFIED` content. That is report-only.
- It throws on malformed input: non-string `text`, missing or non-array
  `evidenceItems`, missing required `request` fields.
- `buildClaimReport` does not catch it. The error propagates to the
  `recruiter-workflow.mjs:172` catch block, ending the run `FAILED` with
  `FAILED_DRAFT_CLASSIFICATION`.

No packet is queued with a partial or absent classification. Fail closed on the
machinery, report-only on the content.

## Known limitation

Sentence splitting reuses `splitClaims` (`fact-resolver.mjs:61`), which splits
on `.`, `!`, and `?`. It is crude: "Dr. Smith" splits incorrectly, and
`"Best,\nVan"` has no terminal punctuation so it stays joined to the following
line.

This is not addressed here. What matters is the failure direction: a bad split
produces more `UNVERIFIED` entries, never fewer. Noisy in the safe direction,
never silent in the unsafe one.

Recorded so it is not later mistaken for solved.

## Testing

New file `tests/path-workflows/recruiter/draft-classifier.test.mjs` for pure
unit tests, plus additions to `claim-report.test.mjs` and
`recruiter-workflow.test.mjs` for integration.

Three tests carry the weight:

- **T1 — template output classifies with zero `UNVERIFIED`.** The anti-drift
  test: an edit to template wording without a matching classifier update fails
  here immediately.
- **T2 — a draft consisting entirely of `UNVERIFIED` segments still reaches
  `HUMAN_REVIEW`.** Proves report-only, and stops a later edit quietly turning
  this into a blocker.
- **T3 — a declared-but-unbacked claim still returns
  `BLOCKED_UNSUPPORTED_CLAIMS`.** Proves decision 3 held.

The rest:

- **T4** — a fabricated segment is labelled `UNVERIFIED`.
- **T5** — the greeting/role/company segment is labelled `REQUEST`, not
  `TEMPLATE` or `EVIDENCE`.
- **T6** — an evidence segment is labelled `EVIDENCE` and carries its
  `evidenceId`.
- **T7** — `draftClassification` is present in `claim-report.json` and covered
  by `claimReportHash`.
- **T8** — malformed input to `classifyDraft` ends the run `FAILED` with
  `FAILED_DRAFT_CLASSIFICATION` and queues no packet.

All suites run on Linux via Docker before commit. Six symlink tests in
`test:path-agent` skip on Windows with `EPERM`, so a Windows-only run is not
sufficient evidence.

## Out of scope

- Semantic entailment. Deciding whether a paraphrase follows from evidence is
  not solvable by string matching and is not attempted.
- Fuzzy or scored evidence matching.
- Changing `BLOCKED_UNSUPPORTED_CLAIMS` behaviour.
- Fixing sentence splitting.
