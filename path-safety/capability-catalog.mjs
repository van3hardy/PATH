const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const PLUGIN_HOOKS = Object.freeze([
  'provider', 'ingest', 'search', 'notify', 'export'
]);

function capability(id, effects, resourceTypes, policy = 'approval') {
  return Object.freeze({
    id,
    effects: Object.freeze([...effects]),
    resourceTypes: Object.freeze([...resourceTypes]),
    policy
  });
}

const CATALOG = Object.freeze({
  'local.read': capability('local.read', ['read'], ['local'], 'local_read'),
  'local.write': capability('local.write', ['local_write'], ['local']),
  'external.read': capability('external.read', ['external_read'], ['external']),
  'external.write': capability('external.write', ['external_write'], ['external']),
  'model.invoke': capability('model.invoke', ['spend'], ['model']),
  'browser.navigate': capability('browser.navigate', ['external_read'], ['external']),
  'browser.fill': capability('browser.fill', ['external_write'], ['external']),
  'browser.submit': capability('browser.submit', ['external_write'], ['external'], 'deny')
});

const PLUGIN_EFFECTS = Object.freeze({
  provider: Object.freeze(['external_read']),
  ingest: Object.freeze(['external_read']),
  search: Object.freeze(['external_read']),
  notify: Object.freeze(['external_write']),
  export: Object.freeze(['external_write'])
});

export function pluginCapabilityId(pluginId, hook) {
  if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId) ||
      !PLUGIN_HOOKS.includes(hook)) return null;
  return `plugin.${pluginId}.${hook}`;
}

export function getCapability(capabilityId) {
  if (typeof capabilityId !== 'string') return null;
  if (Object.hasOwn(CATALOG, capabilityId)) return CATALOG[capabilityId];

  const match = /^plugin\.([a-z0-9][a-z0-9-]*)\.([a-z]+)$/.exec(capabilityId);
  if (!match) return null;
  const [, pluginId, hook] = match;
  if (pluginCapabilityId(pluginId, hook) !== capabilityId) return null;
  return capability(capabilityId, PLUGIN_EFFECTS[hook], ['local', 'external']);
}
