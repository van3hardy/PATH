import fs from 'node:fs';
import path from 'node:path';

import { runBrain } from '../../path-brain/contract.mjs';
import { selectEvidence } from '../../path-memory/evidence-selector.mjs';
import {
  createRun,
  finishRun,
  transitionRun,
  writeRunArtifact
} from '../../path-runner/lifecycle.mjs';
import { gateOutbound, reconcileOutboxAudit } from '../../path-safety/outbound-gate.mjs';
import { loadContacts, findPersonByEmail } from '../../path-safety/contacts.mjs';
import { buildClaimReport } from './claim-report.mjs';
import { validateRecruiterRequest } from './request-boundary.mjs';
import { renderRunSummary } from './summary-writer.mjs';

const FORBIDDEN_DEPENDENCIES = ['transport', 'send', 'browser', 'connector'];

export async function runRecruiterWorkflow(options = {}) {
  let runId = typeof options?.rawRequest?.runId === 'string'
    ? options.rawRequest.runId
    : null;
  let runCreated = false;
  let decision = null;
  let packetId = null;

  try {
    if (!isRecord(options) || FORBIDDEN_DEPENDENCIES.some((name) =>
      Object.hasOwn(options, name))) {
      throw codedError('BLOCKED_INVALID_DEPENDENCY');
    }
    const {
      rootDir,
      rawRequest,
      provider,
      now,
      idFactory,
      fsImpl = fs,
      gateOutboundFn = gateOutbound,
      gateOptions = {}
    } = options;
    if (typeof gateOutboundFn !== 'function' || !isRecord(gateOptions) ||
        FORBIDDEN_DEPENDENCIES.some((name) => Object.hasOwn(gateOptions, name))) {
      throw codedError('BLOCKED_INVALID_DEPENDENCY');
    }
    const lifecycleOptions = { now, idFactory, fsImpl };
    const request = validateRecruiterRequest(rawRequest, { now, idFactory });
    runId = request.runId;

    createRun({ rootDir, runId }, lifecycleOptions);
    runCreated = true;
    writeJsonArtifact(rootDir, runId, 'request.json', request, lifecycleOptions);
    transitionRun({ rootDir, runId, to: 'VALIDATED' }, lifecycleOptions);
    const contactNote = priorContactNote(rootDir, request.recipient.address);

    let selection;
    try {
      selection = selectEvidence({ rootDir, evidenceRefs: request.evidenceRefs, now });
    } catch (error) {
      if (error?.code === 'BLOCKED_QUOTE_NOT_FOUND') {
        throw codedError('BLOCKED_EVIDENCE_NOT_FOUND');
      }
      throw error;
    }
    writeJsonArtifact(rootDir, runId, 'evidence-selection.json', selection, lifecycleOptions);
    transitionRun({ rootDir, runId, to: 'EVIDENCE_SELECTED' }, lifecycleOptions);

    const brainOutput = await runBrain(provider, {
      schemaVersion: 'path.brain.request.v1',
      promptVersion: request.promptVersion,
      objective: request.objective,
      recipient: request.recipient,
      opportunity: request.opportunity,
      voiceProfile: request.voiceProfile,
      disclosurePolicy: request.disclosurePolicy,
      evidence: selection.items.map((item) => ({
        id: item.id,
        factKey: item.factKey,
        source: item.source,
        quote: item.quote
      }))
    }, { claimValidationMode: 'claim-report' });
    writeRunArtifact({
      rootDir, runId, name: 'draft.md', content: brainOutput.text
    }, lifecycleOptions);
    transitionRun({ rootDir, runId, to: 'DRAFTED' }, lifecycleOptions);

    const claimReport = buildClaimReport({ brainOutput, selection, request });
    const claimArtifact = writeJsonArtifact(
      rootDir,
      runId,
      'claim-report.json',
      claimReport,
      lifecycleOptions
    );
    if (claimReport.status === 'BLOCKED_UNSUPPORTED_CLAIMS') {
      finishRun({ rootDir, runId, status: 'BLOCKED' }, lifecycleOptions);
      return boundedResult({
        status: 'BLOCKED',
        resultCode: 'BLOCKED_UNSUPPORTED_CLAIMS',
        runId
      });
    }
    transitionRun({ rootDir, runId, to: 'CLAIMS_VERIFIED' }, lifecycleOptions);

    const gateResult = gateOutboundFn({
      runId,
      action: request.action,
      opportunity: request.opportunity,
      recipient: request.recipient,
      text: brainOutput.text,
      claims: brainOutput.claims,
      facts: {
        facts: selection.items.map((item) => ({
          id: item.id,
          text: item.quote,
          source: item.source,
          source_date: item.factRecordedAt,
          approved: true
        }))
      },
      evidenceIds: selection.items.map((item) => item.id),
      evidenceHashes: selection.items.map((item) => item.sourceSha256),
      claimReportHash: claimArtifact.sha256,
      voiceProfile: brainOutput.voiceProfile,
      disclosurePolicy: brainOutput.disclosurePolicy,
      disclosureIncluded: brainOutput.disclosureIncluded,
      promptVersion: brainOutput.promptVersion,
      provider: brainOutput.provider,
      model: brainOutput.model
    }, dataPaths(rootDir), { ...gateOptions, now: gateOptions.now ?? now });
    decision = gateResult?.decision ?? null;
    packetId = gateResult?.packet?.id ?? null;

    if (decision !== 'QUEUE_FOR_APPROVAL') {
      const resultCode = decision === 'BLOCK_RED' ? 'BLOCK_RED' :
        typeof decision === 'string' && decision.startsWith('BLOCK_')
          ? decision
          : 'FAILED_GATE_DECISION';
      const status = resultCode.startsWith('BLOCK_') ? 'BLOCKED' : 'FAILED';
      finishRun({ rootDir, runId, status }, lifecycleOptions);
      return boundedResult({ status, resultCode, decision, packetId, runId });
    }

    const paths = dataPaths(rootDir);
    const reconciliation = reconcileOutboxAudit(paths.outboxPath, paths.auditPath);
    if (!reconciliation.ok) {
      finishRun({ rootDir, runId, status: 'UNRESOLVED' }, lifecycleOptions);
      return boundedResult({
        status: 'UNRESOLVED',
        resultCode: 'UNRESOLVED_QUEUE_AUDIT',
        decision,
        packetId,
        runId
      });
    }

    writeRunArtifact({
      rootDir,
      runId,
      name: 'run-summary.md',
      content: renderRunSummary({
        runId,
        packetId,
        classification: claimReport.draftClassification,
        contactNote
      })
    }, lifecycleOptions);
    transitionRun({ rootDir, runId, to: 'PACKET_QUEUED' }, lifecycleOptions);
    finishRun({ rootDir, runId, status: 'HUMAN_REVIEW' }, lifecycleOptions);
    return boundedResult({
      status: 'HUMAN_REVIEW',
      resultCode: 'LOCAL_REVIEW_READY',
      decision,
      packetId,
      runId
    });
  } catch (error) {
    const resultCode = stableCode(error);
    let status = resultCode.startsWith('BLOCKED_') ? 'BLOCKED' :
      resultCode.startsWith('UNRESOLVED_') ? 'UNRESOLVED' : 'FAILED';
    if (runCreated) {
      try {
        const { rootDir, now, idFactory, fsImpl = fs } = options;
        finishRun({ rootDir, runId, status }, { now, idFactory, fsImpl });
      } catch (finishError) {
        status = 'UNRESOLVED';
        return boundedResult({
          status,
          resultCode: stableCode(finishError),
          decision,
          packetId,
          runId
        });
      }
    }
    return boundedResult({ status, resultCode, decision, packetId, runId });
  }
}

function writeJsonArtifact(rootDir, runId, name, value, options) {
  return writeRunArtifact({
    rootDir,
    runId,
    name,
    content: `${JSON.stringify(value, null, 2)}\n`
  }, options);
}

function priorContactNote(rootDir, recipientEmail) {
  const contacts = loadContacts(dataPaths(rootDir).contactsPath);
  const person = findPersonByEmail(contacts, recipientEmail);
  if (!person || !Array.isArray(person.history) || person.history.length === 0) return null;
  const lastEvent = person.history.at(-1);
  return `Already contacted ${person.lastContactedAt ?? lastEvent.at} via ${lastEvent.channel ?? 'email'}.`;
}

function dataPaths(rootDir) {
  return {
    outboxPath: path.join(rootDir, 'data', 'path-outbox.jsonl'),
    auditPath: path.join(rootDir, 'data', 'path-audit.jsonl'),
    contactsPath: path.join(rootDir, 'data', 'contacts.jsonl')
  };
}

function boundedResult({ status, resultCode, decision = null, packetId = null, runId }) {
  return { status, resultCode, decision, packetId, runId };
}

function stableCode(error) {
  return typeof error?.code === 'string' && error.code.length > 0
    ? error.code
    : 'FAILED_WORKFLOW';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
