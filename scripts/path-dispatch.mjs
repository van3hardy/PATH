#!/usr/bin/env node
import fs from 'node:fs';

const [packetPath, ...flags] = process.argv.slice(2);

if (!packetPath || flags.length !== 1 || flags[0] !== '--dry-run') {
  console.error('Usage: node scripts/path-dispatch.mjs <packet.json> --dry-run');
  process.exit(2);
}

const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));

console.log(JSON.stringify({
  mode: 'dry-run',
  status: 'NOT_DISPATCHED',
  packetId: packet.id,
  tier: packet.tier
}, null, 2));
