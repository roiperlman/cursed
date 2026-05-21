import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { listAdapters } from './adapters/registry.mjs';
import { dataDir } from './state.mjs';

/** @typedef {import("./types.d.ts").ConfigShape} ConfigShape */
/** @typedef {import("./types.d.ts").CommandTimeoutConfig} CommandTimeoutConfig */
/** @typedef {import("./types.d.ts").PanelCommandConfig} PanelCommandConfig */
/** @typedef {import("./types.d.ts").DelegateConfig} DelegateConfig */
/** @typedef {import("./types.d.ts").DelegateBackgroundConfig} DelegateBackgroundConfig */

/** @type {CommandTimeoutConfig} */
const GLOBAL_DEFAULTS = {
  silence_timeout_seconds: 120,
  total_timeout_seconds: 1200,
};

/** @type {Record<string, CommandTimeoutConfig>} */
const COMMAND_OVERLAYS = {
  review: { silence_timeout_seconds: 120, total_timeout_seconds: 1200 },
  'plan-review': { silence_timeout_seconds: 180, total_timeout_seconds: 1800 },
  delegate: { silence_timeout_seconds: 120, total_timeout_seconds: 1800 },
  advise: { silence_timeout_seconds: 180, total_timeout_seconds: 1800 },
};

const PANEL_DEFAULTS = {
  max_size: 3,
  diversity: true,
};

/** @type {Record<string, import("./types.d.ts").PanelCommandConfig>} */
const PANEL_COMMAND_DEFAULTS = {
  review: { panel_size: 3, tier: 'balanced' },
  plan_review: { panel_size: 1, tier: 'reasoning' },
  advise: { panel_size: 1, tier: 'reasoning' },
  delegate: { panel_size: 1, tier: 'balanced' },
};

/** @type {import("./types.d.ts").DelegateBackgroundConfig} */
const DELEGATE_BACKGROUND_DEFAULTS = {
  retention_days: 7, // mirrors JobMeta.retention_days
};

/** @type {import("./types.d.ts").DelegateConfig} */
const DELEGATE_DEFAULTS = {
  dirty_tree: 'refuse',
  background: { ...DELEGATE_BACKGROUND_DEFAULTS },
};

/**
 * @returns {ConfigShape}
 */
function buildDefaults() {
  /** @type {Record<string, CommandTimeoutConfig>} */
  const commands = {};
  for (const [name, overlay] of Object.entries(COMMAND_OVERLAYS)) {
    commands[name] = { ...GLOBAL_DEFAULTS, ...overlay };
  }
  return {
    defaults: { ...GLOBAL_DEFAULTS },
    commands,
    panel: {
      max_size: PANEL_DEFAULTS.max_size,
      diversity: PANEL_DEFAULTS.diversity,
      tier: 'reasoning',
      vendors: [],
      adapters: [],
      commands: Object.fromEntries(Object.entries(PANEL_COMMAND_DEFAULTS).map(([k, v]) => [k, { ...v }])),
    },
    adapters: {
      default: 'cursor',
      enabled: listAdapters(),
    },
    delegate: {
      dirty_tree: DELEGATE_DEFAULTS.dirty_tree,
      background: { ...DELEGATE_BACKGROUND_DEFAULTS },
    },
  };
}

/** @type {ConfigShape} */
export const DEFAULT_CONFIG = buildDefaults();

/**
 * Load and merge a TOML config file. Missing file returns DEFAULT_CONFIG.
 *
 * @param {string} path
 * @returns {Promise<ConfigShape>}
 */
export async function loadConfig(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return buildDefaults();
    throw e;
  }
  const parsed = /** @type {Record<string, any>} */ (TOML.parse(raw));
  return mergeConfig(parsed);
}

/**
 * Merge a parsed TOML object into the default config shape.
 *
 * @param {Record<string, any>} parsed
 * @returns {ConfigShape}
 */
function mergeConfig(parsed) {
  const base = buildDefaults();

  if (parsed.defaults) {
    Object.assign(base.defaults, parsed.defaults);
    for (const name of Object.keys(base.commands)) {
      base.commands[name] = { ...base.commands[name], ...parsed.defaults };
    }
  }

  if (parsed.commands) {
    for (const [name, overlay] of Object.entries(parsed.commands)) {
      base.commands[name] = {
        ...(base.commands[name] || { ...base.defaults }),
        .../** @type {Partial<CommandTimeoutConfig>} */ (overlay),
      };
    }
  }

  if (parsed.panel) {
    if (typeof parsed.panel.max_size === 'number') base.panel.max_size = parsed.panel.max_size;
    if (typeof parsed.panel.diversity === 'boolean') base.panel.diversity = parsed.panel.diversity;
    if (typeof parsed.panel.tier === 'string') base.panel.tier = parsed.panel.tier;
    if (Array.isArray(parsed.panel.vendors)) base.panel.vendors = [...parsed.panel.vendors];
    if (Array.isArray(parsed.panel.adapters)) base.panel.adapters = [...parsed.panel.adapters];
    if (parsed.panel.commands) {
      for (const [name, overlay] of Object.entries(parsed.panel.commands)) {
        base.panel.commands[name] = {
          ...(base.panel.commands[name] || {}),
          .../** @type {Partial<PanelCommandConfig>} */ (overlay),
        };
      }
    }
  }

  if (parsed.delegate) {
    const mode = /** @type {string | undefined} */ (parsed.delegate.dirty_tree);
    if (mode === 'refuse' || mode === 'warn' || mode === 'allow') {
      base.delegate.dirty_tree = mode;
    }
    // unknown values silently fall back to default — schema-validation lite

    if (parsed.delegate.background) {
      const bg = parsed.delegate.background;
      if (bg.retention_days !== undefined) {
        if (typeof bg.retention_days !== 'number' || !Number.isInteger(bg.retention_days) || bg.retention_days <= 0) {
          throw new Error(
            `config error: [delegate.background].retention_days must be a positive integer (got ${bg.retention_days})`,
          );
        }
        base.delegate.background.retention_days = bg.retention_days;
      }
    }
  }

  const known = new Set(listAdapters());

  if (parsed.adapters) {
    if (typeof parsed.adapters.default === 'string') {
      if (!known.has(parsed.adapters.default)) {
        throw new Error(`config error: [adapters].default unknown adapter "${parsed.adapters.default}"`);
      }
      base.adapters.default = parsed.adapters.default;
    }
    if (Array.isArray(parsed.adapters.enabled)) {
      for (const name of parsed.adapters.enabled) {
        if (!known.has(name)) {
          throw new Error(`config error: [adapters].enabled unknown adapter "${name}"`);
        }
      }
      base.adapters.enabled = [...parsed.adapters.enabled];
    }
  }

  for (const [cmd, pc] of Object.entries(base.panel.commands)) {
    for (const name of pc.adapters ?? []) {
      if (!known.has(name)) {
        throw new Error(`config error: [panel.commands.${cmd}].adapters unknown adapter "${name}"`);
      }
    }
  }
  for (const name of base.panel.adapters) {
    if (!known.has(name)) {
      throw new Error(`config error: [panel].adapters unknown adapter "${name}"`);
    }
  }

  return base;
}

/**
 * Resolve the path to config.toml. Mirrors `dataDir` resolution.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveConfigPath(env = process.env) {
  return join(dataDir(env), 'config.toml');
}

/**
 * Serialize a ConfigShape to commented TOML. Deterministic: the output
 * re-parses (via loadConfig) to a value deep-equal to the input.
 *
 * @param {ConfigShape} c
 * @returns {string}
 */
export function serializeConfig(c) {
  /** @param {unknown} v */
  const arr = (v) => JSON.stringify(v);
  const L = [];
  L.push('# cursed configuration — written by /cursed:setup. Safe to hand-edit.');
  L.push('');
  L.push('# Adapter enablement and default solo-dispatch target.');
  L.push('[adapters]');
  L.push(`default = ${JSON.stringify(c.adapters.default)}`);
  L.push(`enabled = ${arr(c.adapters.enabled)}`);
  L.push('');
  L.push('# Global watchdog defaults (apply to all commands unless overridden).');
  L.push('[defaults]');
  L.push(`silence_timeout_seconds = ${c.defaults.silence_timeout_seconds}`);
  L.push(`total_timeout_seconds   = ${c.defaults.total_timeout_seconds}`);
  L.push('');
  for (const [name, t] of Object.entries(c.commands)) {
    L.push(`[commands.${name}]`);
    L.push(`silence_timeout_seconds = ${t.silence_timeout_seconds}`);
    L.push(`total_timeout_seconds   = ${t.total_timeout_seconds}`);
    L.push('');
  }
  L.push('# Panel sizing and model selection. tier/vendors/adapters drive which');
  L.push('# models populate a panel; per-command blocks override the panel default.');
  L.push('[panel]');
  L.push(`max_size  = ${c.panel.max_size}`);
  L.push(`diversity = ${c.panel.diversity}`);
  L.push(`tier      = ${JSON.stringify(c.panel.tier)}`);
  L.push(`vendors   = ${arr(c.panel.vendors)}`);
  L.push(`adapters  = ${arr(c.panel.adapters)}`);
  L.push('');
  for (const [name, pc] of Object.entries(c.panel.commands)) {
    L.push(`[panel.commands.${name}]`);
    L.push(`panel_size = ${pc.panel_size ?? 1}`);
    if (pc.tier !== undefined) L.push(`tier       = ${JSON.stringify(pc.tier)}`);
    if (pc.vendors !== undefined) L.push(`vendors    = ${arr(pc.vendors)}`);
    if (pc.adapters !== undefined) L.push(`adapters   = ${arr(pc.adapters)}`);
    L.push('');
  }
  L.push('# Delegate sandboxing.');
  L.push('[delegate]');
  L.push(`dirty_tree = ${JSON.stringify(c.delegate.dirty_tree)}`);
  L.push('');
  L.push('[delegate.background]');
  L.push(`retention_days = ${c.delegate.background.retention_days}`);
  L.push('');
  return L.join('\n');
}
