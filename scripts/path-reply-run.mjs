#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fakeProvider } from '../path-brain/fake-provider.mjs';
import { buildReplyRequestFromCandidate } from '../path-workflows/recruiter/reply-request-builder.mjs';
import { runRecruiterWorkflow } from '../path-workflows/recruiter/recruiter-workflow.mjs';

const USAGE = 'Usage: node scripts/path-reply-run.mjs <candidate.json> <reply-context.json> <rootDir>';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runIdFromCandidate(candidate) {
  const suffix = String(candidate?.message_id || 'candidate')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'candidate';
  return `run-reply-${suffix}`;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main(args) {
  const [candidatePath, contextPath, rootDir, ...extra] = args;
  if (!candidatePath || !contextPath || !rootDir || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }

  let candidate;
  let context;
  try {
    candidate = readJson(candidatePath);
    context = { provider: 'fake', ...readJson(contextPath) };
  } catch (error) {
    print({ status: 'BLOCKED_INVALID_REPLY_INPUT', sent: false });
    return 1;
  }

  try {
    const rawRequest = buildReplyRequestFromCandidate(candidate, context, {
      idFactory: () => runIdFromCandidate(candidate)
    });
    const result = await runRecruiterWorkflow({
      rootDir: path.resolve(rootDir),
      rawRequest,
      provider: fakeProvider
    });
    print({ ...result, sent: false });
    return result.status === 'HUMAN_REVIEW' ? 0 : 1;
  } catch (error) {
    print({ status: error?.code || 'FAILED_REPLY_RUN', sent: false });
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
