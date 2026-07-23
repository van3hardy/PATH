import fs from 'node:fs';

const GREEN_TYPES = new Map([
  ['discover_roles', 'discovery is allowed automatically'],
  ['enrich_contacts', 'enrichment is allowed automatically'],
  ['score_fit', 'fit scoring is allowed automatically'],
  ['tailor_resume', 'tailoring is allowed automatically'],
  ['draft_message', 'drafting is allowed automatically'],
  ['track_status', 'tracking is allowed automatically'],
  ['queue_approval_packet', 'approval packet queueing is allowed automatically']
]);

const YELLOW_TYPES = new Set([
  'send_email',
  'send_linkedin',
  'send_reply',
  'submit_application',
  'send_followup'
]);

const RED_RULES = [
  {
    reason: 'salary or compensation commitment is manual-only',
    patterns: ['salary', 'compensation', 'base salary', 'hourly rate', 'total comp', '$']
  },
  {
    reason: 'offer decision is manual-only',
    patterns: ['accept the offer', 'decline the offer', 'counteroffer', 'counter offer']
  },
  {
    reason: 'legal statement is manual-only',
    patterns: ['legally binding', 'legal claim', 'certify under penalty']
  },
  {
    reason: 'availability promise is manual-only',
    patterns: ['i can start', 'i am available', 'guaranteed availability']
  },
  {
    reason: 'binding commitment is manual-only',
    patterns: ['i accept', 'i agree to', 'i commit']
  }
];

export function loadPolicy(policyPath = 'config/path.autonomy.yml') {
  const text = fs.readFileSync(policyPath, 'utf8');
  const policy = {};
  let currentSection = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.endsWith(':') && !line.startsWith('- ')) {
      currentSection = line.slice(0, -1);
      policy[currentSection] = [];
      continue;
    }
    if (line.startsWith('- ') && currentSection) {
      policy[currentSection].push(line.slice(2).replace(/^"|"$/g, ''));
    }
  }

  return policy;
}

export function classifyAction(action) {
  const text = String(action.text || '').toLowerCase();
  const redReasons = [];

  for (const rule of RED_RULES) {
    if (rule.patterns.some((pattern) => text.includes(pattern))) {
      redReasons.push(rule.reason);
    }
  }

  if (redReasons.length > 0) {
    return { tier: 'RED', reasons: [...new Set(redReasons)] };
  }

  if (GREEN_TYPES.has(action.type)) {
    return { tier: 'GREEN', reasons: [GREEN_TYPES.get(action.type)] };
  }

  if (YELLOW_TYPES.has(action.type)) {
    if (action.type === 'send_email' && action.touch === 'first') {
      return { tier: 'YELLOW', reasons: ['first-touch sends require Van approval'] };
    }
    return { tier: 'YELLOW', reasons: [`${action.type.replaceAll('_', ' ')} requires Van approval`] };
  }

  return { tier: 'RED', reasons: ['unknown action type is blocked by default'] };
}
