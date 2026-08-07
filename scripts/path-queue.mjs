#!/usr/bin/env node
import fs from 'node:fs';
import { gateOutbound } from '../path-safety/outbound-gate.mjs';
import { loadFacts } from '../path-safety/fact-resolver.mjs';

const inputPath = process.argv[2];

if (!inputPath) {
  console.error('Usage: node scripts/path-queue.mjs <payload.json>');
  process.exit(2);
}

const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const result = gateOutbound({
  ...payload,
  facts: loadFacts(payload.factsPath || 'config/path.facts.yml')
});

console.log(JSON.stringify({
  decision: result.decision,
  packetId: result.packet.id,
  tier: result.packet.tier,
  status: result.packet.status
}, null, 2));

process.exit(result.decision === 'BLOCK_RED' ? 1 : 0);
