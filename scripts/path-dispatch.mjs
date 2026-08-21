#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyAuditLedger } from '../path-safety/audit-ledger.mjs';
import { loadContacts, isContactedOnChannel, isContactedByNameOnChannel, canonicalChannel, upsertContact } from '../path-safety/contacts.mjs';
import { verifyPacketIntegrity } from '../path-safety/packet-integrity.mjs';

export function evaluateDryRun({ packet, approvals, dispatches, auditPath, contacts, now = new Date() }) {
  if (!packet || typeof packet !== 'object' ||
      !packet.id || !packet.createdAt || !packet.action || !packet.recipient ||
      typeof packet.finalText !== 'string') {
    return { status: 'BLOCKED_INVALID_PACKET' };
  }

  const integrity = verifyPacketIntegrity(packet, { now });
  if (!integrity.ok) return { status: integrity.code };

  if (packet.status !== 'AWAITING_VAN_APPROVAL' || packet.tier !== 'YELLOW') {
    return { status: 'BLOCKED_NOT_DISPATCHABLE' };
  }

  if (dispatches.some((entry) =>
    entry.packetId === packet.id && entry.event === 'dispatch_completed')) {
    return { status: 'BLOCKED_ALREADY_DISPATCHED' };
  }

  // Channel-scoped dedup: block only when this person already has contact
  // history on the packet's intended channel (e.g. already emailed → email is
  // blocked, but a fresh LinkedIn touch is still a new channel and allowed).
  // An untold channel fails closed to the old any-history behavior.
  // A recipient with no email record resolves by exact canonical name against
  // name-only contacts (no email yet); the email path always decides first.
  if (contacts instanceof Map && contacts.size > 0 &&
      (isContactedOnChannel(contacts, packet.recipient.address, packet.action?.channel) ||
       isContactedByNameOnChannel(contacts, packet.recipient.name, packet.action?.channel))) {
    return { status: 'BLOCKED_ALREADY_CONTACTED' };
  }

  const exactApprovals = approvals.filter((entry) =>
    entry.packetId === packet.id &&
    entry.integritySha256 === packet.integritySha256 &&
    entry.idempotencyKey === packet.idempotencyKey &&
    entry.decidedBy === 'Van');
  const latestApproval = exactApprovals.at(-1);
  if (latestApproval?.decision === 'APPROVED') return gateOnAuditLedger(packet, auditPath);
  if (latestApproval?.decision === 'REJECTED') return { status: 'BLOCKED_REJECTED' };
  return { status: 'BLOCKED_NOT_APPROVED' };
}

// The audit ledger is the authority: entries are read only after the existing
// verifyAuditLedger passes over the whole file, so no weaker parallel check exists.
function gateOnAuditLedger(packet, auditPath) {
  if (typeof auditPath !== 'string' || !fs.existsSync(auditPath)) {
    return { status: 'BLOCKED_AUDIT_UNVERIFIED' };
  }
  // verifyAuditLedger reads the file without guarding, so an unreadable path
  // (directory, permission error, race with removal) must not escape as a throw.
  let entries;
  try {
    if (!verifyAuditLedger(auditPath).ok) return { status: 'BLOCKED_AUDIT_UNVERIFIED' };
    entries = parseJsonl(auditPath);
  } catch {
    return { status: 'BLOCKED_AUDIT_UNVERIFIED' };
  }

  // Match on identity alone, never on decision, so an APPROVED event paired with
  // a contradictory REJECTED event is caught as ambiguous rather than accepted.
  const matches = entries.filter((entry) =>
    entry.event === 'approval_decision_recorded' &&
    entry.packetId === packet.id &&
    entry.integritySha256 === packet.integritySha256 &&
    entry.idempotencyKey === packet.idempotencyKey);

  if (matches.length === 0) return { status: 'BLOCKED_APPROVAL_NOT_IN_AUDIT' };
  if (matches.length > 1) return { status: 'BLOCKED_AMBIGUOUS_AUDIT_APPROVAL' };
  if (matches[0].decision !== 'APPROVED') return { status: 'BLOCKED_AUDIT_NOT_APPROVED' };
  return { status: 'READY_TO_DISPATCH' };
}

function parseJsonl(filePath) {
  const entries = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!entries.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
    throw new Error('non-object JSONL entry');
  }
  return entries;
}

const USAGE = 'Usage: node scripts/path-dispatch.mjs <packet.json> <approvals.jsonl> <dispatch.jsonl> <audit.jsonl> --dry-run|--send [--contacts <contacts.jsonl>]';

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

// Idempotent lazy dotenv load; mirrors plugins/_engine.mjs. Credentials only
// matter on the real (non-fake) send path, so this may stay a no-op in absensce.
let dotenvLoaded = false;
async function loadDotenvOnce() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    const { config } = await import('dotenv');
    config();
  } catch {
    // dotenv optional — fall back to ambient process.env.
  }
}

// Subprocess seam: PATH_SEND_TRANSPORT=fake routes to an in-script fake so
// integration tests exercise the full gate/send/ledger host without OAuth.
// PATH_SEND_FAKE_FAIL=1 forces a failure for the failure test.
async function resolveSendTransport(channel = 'email') {
  if (process.env.PATH_SEND_TRANSPORT === 'fake') {
    return {
      async sendGmailMessage(args = {}) {
        if (process.env.PATH_SEND_FAKE_FAIL === '1') throw codedError('SEND_FAILED_API');
        if (process.env.PATH_SEND_FAKE_ECHO_THREAD === '1') {
          return {
            ok: true,
            messageId: `fake-${args.threadId ?? 'missing'}-${args.inReplyTo ? 'reply' : 'missing'}-${args.references ? 'refs' : 'missing'}`
          };
        }
        return { ok: true, messageId: `fake-${crypto.randomUUID()}` };
      },
      async sendLinkedInMessage(args = {}) {
        if (process.env.PATH_SEND_FAKE_FAIL === '1') throw codedError('SEND_FAILED_API');
        return { ok: true, messageId: `fake-linkedin-${crypto.randomUUID()}` };
      },
      async placeCall(args = {}) {
        if (process.env.PATH_SEND_FAKE_FAIL === '1') throw codedError('SEND_FAILED_API');
        return { ok: true, messageId: `fake-telephony-${crypto.randomUUID()}` };
      }
    };
  }
  await loadDotenvOnce();
  if (channel === 'linkedin') {
    const relayUrl = process.env.PATH_LINKEDIN_RELAY_URL;
    if (!relayUrl) throw codedError('SEND_FAILED_CONFIG');
    const apiKey = process.env.PATH_LINKEDIN_API_KEY;
    const { sendLinkedInMessage } = await import('../transports/linkedin-send.mjs');
    return {
      sendLinkedInMessage: (args) => sendLinkedInMessage({ ...args, relayUrl, ...(apiKey ? { apiKey } : {}) })
    };
  }
  if (channel === 'phone') {
    const relayUrl = process.env.PATH_TELEPHONY_RELAY_URL;
    if (!relayUrl) throw codedError('SEND_FAILED_CONFIG');
    const apiKey = process.env.PATH_TELEPHONY_API_KEY;
    const { placeCall } = await import('../transports/telephony-call.mjs');
    return {
      placeCall: (args) => placeCall({ ...args, relayUrl, ...(apiKey ? { apiKey } : {}) })
    };
  }
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw codedError('SEND_FAILED_CONFIG');
  const { sendGmailMessage } = await import('../transports/gmail-send.mjs');
  return {
    sendGmailMessage: (args) => sendGmailMessage({ ...args, clientId, clientSecret, refreshToken })
  };
}

// Missing dispatch file is an empty ledger on the send path (lazy append-only);
// a malformed existing file still fails loudly via parseJsonl.
function readDispatches(dispatchPath) {
  if (!fs.existsSync(dispatchPath)) return [];
  return parseJsonl(dispatchPath);
}

// Sends and appends the receipt only after the transport confirms a messageId.
// Runs after evaluateDryRun() returned READY_TO_DISPATCH, so the send is
// twice-gated: same gate in the same run that performs the send.
async function performSend({ packet, dispatchPath, contactsPath }) {
  const channel = canonicalChannel(packet.action?.channel) ?? 'email';
  let transport;
  try {
    transport = await resolveSendTransport(channel);
  } catch (error) {
    return { status: error?.code || 'SEND_FAILED_HTTP' };
  }
  const subject = `${packet.action.opportunity.role} @ ${packet.action.opportunity.company}`;
  const to = { name: packet.recipient.name, address: packet.recipient.address };
  const send = channel === 'linkedin' ? transport.sendLinkedInMessage
    : channel === 'phone' ? transport.placeCall
    : transport.sendGmailMessage;
  let timestamp;
  try {
    const result = await send({
      to,
      subject,
      body: packet.finalText,
      ...(typeof packet.action?.threadId === 'string' ? { threadId: packet.action.threadId } : {}),
      ...(typeof packet.action?.inReplyTo === 'string' ? { inReplyTo: packet.action.inReplyTo } : {}),
      ...(typeof packet.action?.references === 'string' ? { references: packet.action.references } : {})
    });
    if (!result?.ok) throw codedError('SEND_FAILED_API');
    timestamp = new Date().toISOString();
    const record = {
      packetId: packet.id,
      event: 'dispatch_completed',
      timestamp,
      messageId: result.messageId,
      providerId: channel === 'linkedin' ? 'linkedin' : channel === 'phone' ? 'telephony' : 'gmail'
    };
    fs.mkdirSync(path.dirname(dispatchPath), { recursive: true });
    fs.appendFileSync(dispatchPath, `${JSON.stringify(record)}\n`, 'utf8');
    let contactWriteError;
    if (contactsPath) {
      try {
        upsertContact(contactsPath, {
          name: packet.recipient.name,
          email: packet.recipient.address,
          channel: canonicalChannel(packet.action?.channel) ?? 'email',
          at: timestamp,
          applicationId: null,
          source: 'dispatch'
        });
      } catch (error) {
        contactWriteError = error?.code || 'FAILED_CONTACTS_WRITE';
      }
    }
    return {
      status: 'DISPATCHED',
      messageId: result.messageId,
      ...(contactWriteError ? { contactWriteError } : {})
    };
  } catch (error) {
    return { status: error?.code || 'SEND_FAILED_HTTP' };
  }
}

function printResult(status, packet = {}, { mode = 'dry-run', extras = {} } = {}) {
  console.log(JSON.stringify({
    mode,
    status,
    packetId: packet?.id ?? null,
    tier: packet?.tier ?? null,
    ...extras
  }, null, 2));
  return status === 'READY_TO_DISPATCH' || status === 'DISPATCHED' ? 0 : 1;
}

async function main(args) {
  const [packetPath, approvalsPath, dispatchPath, auditPath, mode, ...flags] = args;
  if (!packetPath || !approvalsPath || !dispatchPath || !auditPath ||
      !['--dry-run', '--send'].includes(mode)) {
    console.error(USAGE);
    return 2;
  }
  let contactsPath = null;
  if (flags.length > 0) {
    if (flags.length === 2 && flags[0] === '--contacts' && !flags[1].startsWith('--')) {
      contactsPath = flags[1];
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  const isSend = mode === '--send';

  let packet;
  try {
    packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  } catch {
    return printResult('BLOCKED_INVALID_PACKET');
  }

  let approvals;
  try {
    approvals = parseJsonl(approvalsPath);
  } catch {
    return printResult('BLOCKED_INVALID_APPROVALS', packet);
  }

  let dispatches;
  try {
    dispatches = isSend ? readDispatches(dispatchPath) : parseJsonl(dispatchPath);
  } catch {
    return printResult('BLOCKED_INVALID_DISPATCHES', packet);
  }

  let contacts = null;
  if (contactsPath) {
    try {
      // Missing file → empty map (never an error); corrupt line → loadContacts throws.
      contacts = loadContacts(contactsPath);
    } catch {
      return printResult('BLOCKED_INVALID_CONTACTS', packet);
    }
  }

  const gate = evaluateDryRun({ packet, approvals, dispatches, auditPath, contacts });
  if (isSend) {
    if (gate.status !== 'READY_TO_DISPATCH') {
      return printResult(gate.status, packet, { mode: 'send' });
    }
    const outcome = await performSend({ packet, dispatchPath, contactsPath });
    return printResult(outcome.status, packet, {
      mode: 'send',
      extras: {
        ...(outcome.messageId ? { messageId: outcome.messageId } : {}),
        ...(outcome.contactWriteError ? { contactWriteError: outcome.contactWriteError } : {})
      }
    });
  }
  return printResult(gate.status, packet);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
