/**
 * Prompt builder for the headless cover-letter web job ("cover-letter" kind on
 * /api/run). The REAL drafting pipeline is modes/cover.md + generate-cover-letter.mjs
 * — this only builds the instruction the CLI agent runs against. Pure ESM (no
 * Next, no fs) so it is regression-tested directly, like clean-chips.mjs.
 *
 * Run:  node --test web/test-run-cover-prompt.mjs
 */

/**
 * Build the instruction for a headless cover-letter draft+render.
 *
 * @param {object} opts
 * @param {string} opts.report   3-digit application/report number (run `input`)
 * @param {string} [opts.company]  company for the output slug (optional: the mode
 *                                 derives it from the report/tracker when absent)
 * @param {string} [opts.role]     role title (optional, for context/verdict)
 * @param {string} [opts.today]    YYYY-MM-DD date string
 * @returns {string}  the headless prompt
 */
export function buildCoverPrompt({ report, company, role, today }) {
  const slug = (String(company ?? "").toLowerCase().match(/[a-z0-9]+/g) || []).join("-") || "company";
  const date = String(today || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const roleClause = role ? ` for ${company} (${role})` : ` (#${report})`;
  return `You are generating the user's TAILORED cover letter${roleClause}, headless, on their own machine. This is a web-triggered batch job — do NOT stop for interactive questions, research confirmations, or approvals; the user already asked for the letter by clicking a button.

Run the REAL career-ops cover mode — follow modes/cover.md EXACTLY (structure, achievement selection rules, language bans, template resolution). Do not improvise a format.

1. Read modes/cover.md, modes/_profile.md, config/profile.yml, cv.md, and the evaluation report at reports/${report}-*.md for the JD keywords + analysis. Find the exact company and role in data/applications.md row #${report} (or the report header). Read article-digest.md if it exists.
2. Step 4 keyword extraction: mirror the JD's ATS-critical terms + language signals in the letter.
3. Step 7 achievement selection: pick 4-5 achievement bullets — evidence from cv.md ONLY (exact wording + metrics, never invent). article-digest.md is context only, never a bullet source.
4. Step 8 draft: write the full letter in the mode's structure (opening, profile intro, achievements bullets, problems section, closing, optional language closing). Respect the word-body target and every language rule in modes/cover.md.
5. Assemble the JSON payload exactly per Step 9, grounded in this person (name/email/location from config/profile.yml, NOT invented): candidate (name/email/phone/location/linkedin/github/credentials) + letter (role_title, company, city, date ${date}, greeting optional, opening, profile_intro, achievements[{lead,impact}], problems_section, closing, language_closing optional).
6. Pick the output path as the mode dictates (output/{company-slug}-cover.pdf for this application), write the payload to /tmp/cover-payload-{company-slug}.json, then render:
   node generate-cover-letter.mjs --payload /tmp/cover-payload-{company-slug}.json
   (The script resolves the template itself; do NOT hardcode cover-letter-template.html.)
7. Do NOT submit anything anywhere. Do NOT send email, no contact, no auto-fill. Draft + render + report path only.

End with EXACTLY one VERDICT line, nothing after it:
VERDICT: 5/5 — {actual output path in output/, ≤35 chars}`;
}