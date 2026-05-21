import { readFile } from 'node:fs/promises';
import TOML from '@iarna/toml';
import { listAdapters } from './adapters/registry.mjs';

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
      commands: Object.fromEntries(
        Object.entries(PANEL_COMMAND_DEFAULTS).map(([k, v]) => [k, { ...v }]),
      ),
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
