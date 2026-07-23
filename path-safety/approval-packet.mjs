import crypto from 'node:crypto';
import { classifyAction } from './policy.mjs';
import { resolveClaims } from './fact-resolver.mjs';

export function buildApprovalPacket(input) {
  const classification = classifyAction({ ...input.action, text: input.text });
  const claimResult = resolveClaims(input.text, input.facts);
  const createdAt = new Date().toISOString();
  const id = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      action: input.action,
      recipient: input.recipient,
      text: input.text,
      createdAt
    }))
    .digest('hex')
    .slice(0, 16);

  return {
    id,
    createdAt,
    status: classification.tier === 'YELLOW' ? 'AWAITING_VAN_APPROVAL' : classification.tier,
    tier: classification.tier,
    reasons: classification.reasons,
    action: input.action,
    recipient: input.recipient,
    promptVersion: input.promptVersion,
    model: input.model,
    supportedClaims: claimResult.supported,
    unsupportedClaims: claimResult.unsupported,
    finalText: input.text
  };
}
