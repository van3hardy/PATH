import fs from 'node:fs';

export function loadFacts(factsPath = 'config/path.facts.yml') {
  const text = fs.readFileSync(factsPath, 'utf8');
  const facts = [];
  let currentFact = null;
  const root = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('- id: ')) {
      currentFact = { id: parseScalar(line.slice('- id: '.length)) };
      facts.push(currentFact);
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = parseScalar(line.slice(separatorIndex + 1).trim());

    if (currentFact && ['text', 'source', 'source_date', 'approved'].includes(key)) {
      currentFact[key] = value;
    } else if (!currentFact && key !== 'facts') {
      root[key] = value;
    }
  }

  return { ...root, facts };
}

export function resolveClaims(text, facts) {
  const claims = splitClaims(text);
  const approvedFacts = new Set(
    (facts.facts || [])
      .filter((fact) => fact.approved === true)
      .map((fact) => normalize(fact.text))
  );

  const supported = [];
  const unsupported = [];

  for (const claim of claims) {
    if (approvedFacts.has(normalize(claim))) {
      supported.push(claim);
    } else {
      unsupported.push(claim);
    }
  }

  return { supported, unsupported };
}

function splitClaims(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((claim) => claim.trim())
    .filter(Boolean);
}

function normalize(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseScalar(value) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value.replace(/^"|"$/g, '');
}
