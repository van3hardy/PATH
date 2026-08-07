import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pass, fail, ROOT } from '../helpers.mjs';
import {
  loadPlugin,
  mergeProviderPlugins,
  runHook
} from '../../plugins/_engine.mjs';
import { createJsonlReceiptSink } from '../../path-safety/capability-receipts.mjs';
import { hashPluginTree, writeLockEntry } from '../../plugins/_lock.mjs';

const approval = Object.freeze({ source: 'direct_cli', approvedBy: 'plugin CLI fixture' });
const configurationApproval = Object.freeze({
  source: 'configuration', approvedBy: 'portals.yml fixture'
});

async function check(name, operation) {
  try {
    await operation();
    pass(name);
  } catch (error) {
    fail(`${name}: ${error?.stack || error}`);
  }
}

function fixtureRoot(prefix = 'path-plugin-gateway-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  return root;
}

function countLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length;
}

function writePlugin(root, {
  id,
  kind,
  enabled = true,
  requiredEnv = [],
  allowedHosts = [`${id}.example.test`],
  body,
  local = false
}) {
  const base = path.join(root, local ? 'plugins.local' : 'plugins');
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id,
    apiVersion: 1,
    description: `${id} fixture`,
    hooks: [kind],
    requiredEnv,
    allowedHosts,
    humanInTheLoop: true
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.mjs'), body ?? `
    import fs from 'node:fs';
    fs.appendFileSync(new URL('./imports.log', import.meta.url), 'imported\\n');
    const invoked = () => fs.appendFileSync(new URL('./invocations.log', import.meta.url), 'invoked\\n');
    const hooks = {
      ingest: async (ctx) => { invoked(); return [{ title: 'Ingested', url: 'https://${id}.example.test/ingest', dryRun: ctx.dryRun }]; },
      search: async (query, ctx) => { invoked(); return [{ title: query, url: 'https://${id}.example.test/search', dryRun: ctx.dryRun }]; },
      export: async (snapshot, ctx) => { invoked(); return { pushed: snapshot.count, dryRun: ctx.dryRun }; },
      notify: async (payload, ctx) => { invoked(); return { messageLength: payload.message.length, dryRun: ctx.dryRun }; },
      provider: { id: '${id}', async fetch(entry, ctx) { invoked(); return [{ title: entry.name, url: 'https://${id}.example.test/provider', dryRun: ctx.dryRun }]; } }
    };
    export default { [${JSON.stringify(kind)}]: hooks[${JSON.stringify(kind)}] };
  `, 'utf8');
  const configPath = path.join(root, 'config', 'plugins.yml');
  fs.appendFileSync(configPath, `${fs.existsSync(configPath) ? '' : 'plugins:\n'}  ${id}: { enabled: ${enabled} }\n`, 'utf8');
  return {
    dir,
    imports: path.join(dir, 'imports.log'),
    invocations: path.join(dir, 'invocations.log')
  };
}

function sinkAt(root) {
  const receiptPath = path.join(root, 'tmp', 'receipts.jsonl');
  return { receiptPath, receiptSink: createJsonlReceiptSink(receiptPath) };
}

function assertStableResult(result, expected) {
  assert.deepEqual(Object.keys(result).sort(), ['code', 'error', 'id', 'kind', 'ok', 'result']);
  assert.equal(result.id, expected.id);
  assert.equal(result.kind, expected.kind);
  assert.equal(result.ok, expected.ok);
  assert.equal(result.code, expected.code);
  if (expected.error) assert.match(result.error, expected.error);
}

await check('selected notify plugin is the only module imported, invoked, and receipted', async () => {
  const root = fixtureRoot();
  const selected = writePlugin(root, { id: 'notify-selected', kind: 'notify' });
  const unselected = writePlugin(root, { id: 'notify-unselected', kind: 'notify' });
  const { receiptPath, receiptSink } = sinkAt(root);
  const payload = { message: 'selected-only-payload-sentinel' };

  const result = await runHook('notify-selected', 'notify', payload, {
    root, approval, receiptSink
  });

  assertStableResult(result, {
    id: 'notify-selected', kind: 'notify', ok: true, code: 'PLUGIN_HOOK_OK'
  });
  assert.equal(countLines(selected.imports), 1);
  assert.equal(countLines(selected.invocations), 1);
  assert.equal(countLines(unselected.imports), 0);
  assert.equal(countLines(unselected.invocations), 0);
  const receipts = fs.readFileSync(receiptPath, 'utf8');
  assert.match(receipts, /plugin\.notify-selected\.notify/);
  assert.doesNotMatch(receipts, /notify-unselected|selected-only-payload-sentinel/);
});

await check('ingest, search, export, and notify keep their signatures and one-result contract', async () => {
  const cases = [
    ['ingest', undefined, (value) => assert.equal(value[0].title, 'Ingested')],
    ['search', 'literal search query', (value) => assert.equal(value[0].title, 'literal search query')],
    ['export', { count: 7 }, (value) => assert.equal(value.pushed, 7)],
    ['notify', { message: 'hello' }, (value) => assert.equal(value.messageLength, 5)]
  ];
  for (const [kind, payload, inspect] of cases) {
    const root = fixtureRoot();
    const id = `${kind}-fixture`;
    writePlugin(root, { id, kind });
    const result = await runHook(id, kind, payload, {
      root, approval, receiptSink: sinkAt(root).receiptSink
    });
    assertStableResult(result, { id, kind, ok: true, code: 'PLUGIN_HOOK_OK' });
    inspect(result.result);
  }
});

await check('dry-run is plan-only with no import, invocation, integrity write, gateway, or receipt', async () => {
  const root = fixtureRoot();
  const fixture = writePlugin(root, { id: 'dry-notify', kind: 'notify' });
  const { receiptPath, receiptSink } = sinkAt(root);
  const loaded = await loadPlugin('dry-notify', 'notify', { root, dryRun: true });
  assert.equal(loaded.planned, true);
  const result = await runHook('dry-notify', 'notify', { message: 'dry sentinel' }, {
    root, dryRun: true, approval, receiptSink
  });
  assertStableResult(result, {
    id: 'dry-notify', kind: 'notify', ok: true, code: 'PLUGIN_DRY_RUN'
  });
  assert.equal(countLines(fixture.imports), 0);
  assert.equal(countLines(fixture.invocations), 0);
  assert.equal(fs.existsSync(path.join(root, 'plugins.lock')), false);
  assert.equal(fs.existsSync(receiptPath), false);
});

await check('selected hook failures are stable objects and never empty arrays', async () => {
  const root = fixtureRoot();
  writePlugin(root, { id: 'disabled-hook', kind: 'notify', enabled: false });
  writePlugin(root, {
    id: 'missing-env-hook', kind: 'notify', requiredEnv: ['PATH_PLUGIN_GATEWAY_MISSING_ENV']
  });
  writePlugin(root, { id: 'undeclared-hook', kind: 'search' });
  writePlugin(root, {
    id: 'import-failure', kind: 'notify', body: 'this is not valid javascript {'
  });
  writePlugin(root, {
    id: 'timeout-hook', kind: 'notify', body: `export default { notify: async () => new Promise(() => {}) };`
  });
  const local = writePlugin(root, { id: 'integrity-failure', kind: 'notify', local: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(local.dir, 'manifest.json'), 'utf8'));
  const tree = hashPluginTree(local.dir);
  writeLockEntry(root, 'integrity-failure', {
    source: 'local', version: '1.0.0', integrity: tree.integrity, files: tree.files,
    consent: { hooks: manifest.hooks, requiredEnv: [], allowedHosts: manifest.allowedHosts }
  });
  fs.appendFileSync(path.join(local.dir, 'index.mjs'), '\n// drift without version bump\n', 'utf8');

  const cases = [
    ['missing-hook', 'notify', 'PLUGIN_NOT_FOUND', /not found/i, 15_000],
    ['disabled-hook', 'notify', 'PLUGIN_DISABLED', /disabled/i, 15_000],
    ['missing-env-hook', 'notify', 'PLUGIN_MISSING_ENV', /PATH_PLUGIN_GATEWAY_MISSING_ENV/, 15_000],
    ['undeclared-hook', 'notify', 'PLUGIN_HOOK_UNDECLARED', /does not declare/i, 15_000],
    ['integrity-failure', 'notify', 'PLUGIN_INTEGRITY_FAILED', /integrity/i, 15_000],
    ['import-failure', 'notify', 'PLUGIN_IMPORT_FAILED', /import/i, 15_000],
    ['timeout-hook', 'notify', 'PLUGIN_HOOK_TIMEOUT', /timed out/i, 10]
  ];
  for (const [id, kind, code, error, timeoutMs] of cases) {
    const result = await runHook(id, kind, { message: 'failure sentinel' }, {
      root, timeoutMs, approval, receiptSink: sinkAt(root).receiptSink
    });
    assert.equal(Array.isArray(result), false);
    assertStableResult(result, { id, kind, ok: false, code, error });
  }
});

await check('receipts contain hashes and destinations but omit query, payload, snapshot, and env sentinels', async () => {
  const root = fixtureRoot();
  const envName = 'PATH_PLUGIN_GATEWAY_ENV_SENTINEL';
  process.env[envName] = 'env-value-must-not-appear';
  try {
    writePlugin(root, {
      id: 'receipt-search', kind: 'search', requiredEnv: [envName],
      allowedHosts: ['receipt.example.test']
    });
    const { receiptPath, receiptSink } = sinkAt(root);
    const result = await runHook('receipt-search', 'search',
      'query-payload-snapshot-must-not-appear', { root, approval, receiptSink });
    assert.equal(result.ok, true);
    const raw = fs.readFileSync(receiptPath, 'utf8');
    for (const secret of [
      'query-payload-snapshot-must-not-appear',
      'env-value-must-not-appear'
    ]) assert.equal(raw.includes(secret), false);
  } finally {
    delete process.env[envName];
  }
});

await check('provider merge imports only explicit selected IDs and gateway-wraps fetch receipts', async () => {
  const root = fixtureRoot();
  const selected = writePlugin(root, { id: 'provider-selected', kind: 'provider' });
  const unselected = writePlugin(root, { id: 'provider-unselected', kind: 'provider' });
  const providers = new Map();
  const { receiptPath, receiptSink } = sinkAt(root);
  await mergeProviderPlugins(providers, {
    root,
    selectedIds: new Set(['provider-selected']),
    approval: configurationApproval,
    receiptSink
  });
  assert.deepEqual([...providers.keys()], ['provider-selected']);
  assert.equal(countLines(selected.imports), 1);
  assert.equal(countLines(unselected.imports), 0);
  const jobs = await providers.get('provider-selected').fetch({ name: 'Selected provider' });
  assert.equal(jobs[0].title, 'Selected provider');
  assert.equal(countLines(selected.invocations), 1);
  const receipts = fs.readFileSync(receiptPath, 'utf8');
  assert.match(receipts, /plugin\.provider-selected\.provider/);
  assert.doesNotMatch(receipts, /provider-unselected|Selected provider/);
});

await check('provider empty selection is inert and selected inactive provider is a no-import stub', async () => {
  const root = fixtureRoot();
  const configured = writePlugin(root, { id: 'provider-configured', kind: 'provider' });
  const providers = new Map();
  await mergeProviderPlugins(providers, {
    root, selectedIds: new Set(), approval: configurationApproval,
    receiptSink: sinkAt(root).receiptSink
  });
  assert.equal(providers.size, 0);
  assert.equal(countLines(configured.imports), 0);

  const missing = writePlugin(root, {
    id: 'provider-missing-env', kind: 'provider',
    requiredEnv: ['PATH_PLUGIN_PROVIDER_MISSING_ENV']
  });
  await mergeProviderPlugins(providers, {
    root, selectedIds: new Set(['provider-missing-env']), approval: configurationApproval,
    receiptSink: sinkAt(root).receiptSink
  });
  assert.equal(countLines(missing.imports), 0);
  assert.equal(providers.get('provider-missing-env').detect({}) , null);
  await assert.rejects(() => providers.get('provider-missing-env').fetch({}), /inactive/i);
});

await check('scan parses portals before merge and passes explicit selected provider IDs', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scan.mjs'), 'utf8');
  const parseAt = source.indexOf('rawConfig = parseYaml');
  const mergeAt = source.indexOf('await mergeProviderPlugins');
  assert.ok(parseAt >= 0 && mergeAt > parseAt, 'provider merge must occur after portals parse');
  const mergeCall = source.slice(mergeAt, source.indexOf(');', mergeAt) + 2);
  assert.match(mergeCall, /selectedIds/);
});
