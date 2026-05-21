import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as lib from 'claude-code-testbed';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');

/**
 * Start a Claude Code session with cursed loaded as the plugin.
 * Always uses OAuth auth (bare: false) so the user's normal credentials apply.
 *
 * @param {string} name  Human label — shows up in tmux session list.
 * @returns {Promise<{id: string, tmuxName: string, jsonlPath: string}>}
 */
export async function startCursedSession(name) {
  return lib.start({
    projectDir: REPO_ROOT,
    pluginDir: REPO_ROOT,
    model: 'haiku',
    bare: false,
    name,
  });
}

/**
 * Send a slash command, wait for the model to finish, return all JSONL events.
 *
 * Uses `lib.tail` and watches for the `last-prompt` event that Claude Code
 * emits once per response cycle when it is ready for the next input. This is
 * more reliable than time-based idle detection because the model may think for
 * 5–20s between tool calls without emitting events, causing time-based waits
 * to fire prematurely.
 *
 * Also automatically answers MCP tool permission prompts with "Yes, and don't
 * ask again" so that subsequent runs in the same project directory skip them.
 *
 * @param {string} sessionId
 * @param {string} slash  e.g. '/cursed:review --solo'
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function runSlash(sessionId, slash, opts = {}) {
  await lib.slash(sessionId, slash);

  const timeoutMs = opts.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;

  // Background loop: answer "Do you want to proceed?" permission prompts that
  // Claude Code shows for MCP tools on first use. The testbed starts with
  // --allow-dangerously-skip-permissions which only enables the option; the
  // prompts still fire until answered with "don't ask again".
  let done = false;
  const permissionPoller = (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 600));
      if (done) break;
      try {
        const pane = await lib.pane(sessionId, { lines: 15 });
        if (pane.includes('Do you want to proceed?')) {
          // Option 2: "Yes, and don't ask again" — persisted per tool per projectDir.
          await lib.send(sessionId, '2');
        }
      } catch {
        // Session may be killed; stop looping.
        break;
      }
    }
  })();

  // Tail JSONL events. Break when:
  //   (a) Claude Code emits a `system` event (subtype: turn_duration) which
  //       fires exactly once per response cycle — after ALL tool calls complete
  //       and the model has emitted its final message. This is more reliable
  //       than idle-time detection (model may think for 5–20s between tool
  //       calls) and more reliable than `last-prompt` (fires during intermediate
  //       tool calls too, causing premature exits).
  //   (b) timeout is reached.
  const ac = new AbortController();
  let sawAssistant = false;

  try {
    for await (const event of lib.tail(sessionId, { signal: ac.signal })) {
      if (Date.now() >= deadline) break;

      if (event.type === 'assistant') sawAssistant = true;

      // system:turn_duration marks the end of the model's response cycle.
      if (event.type === 'system' && event.subtype === 'turn_duration' && sawAssistant) break;
    }
  } finally {
    ac.abort();
    done = true;
    await permissionPoller;
  }

  return lib.events(sessionId);
}

/**
 * Extract and parse the MCP tool_result for a given cursed tool from JSONL events.
 * Returns the parsed result object, or null if the tool was not called.
 *
 * @param {Record<string, unknown>[]} events
 * @param {string} toolName  e.g. 'mcp__plugin_cursed_cursed__review'
 * @returns {unknown | null}
 */
export function extractToolResult(events, toolName) {
  // Find the tool_use id for this tool in an assistant turn
  let toolUseId = null;
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    const content = /** @type {unknown[]} */ (/** @type {Record<string,unknown>} */ (event.message)?.content);
    if (!Array.isArray(content)) continue;
    const tu = content.find(
      (c) =>
        c !== null &&
        typeof c === 'object' &&
        /** @type {Record<string,unknown>} */ (c).type === 'tool_use' &&
        /** @type {Record<string,unknown>} */ (c).name === toolName,
    );
    if (tu) {
      toolUseId = /** @type {Record<string,unknown>} */ (tu).id;
      break;
    }
  }
  if (!toolUseId) return null;

  // Find the matching tool_result in a user turn
  for (const event of events) {
    if (event.type !== 'user') continue;
    const content = /** @type {unknown[]} */ (/** @type {Record<string,unknown>} */ (event.message)?.content);
    if (!Array.isArray(content)) continue;
    const tr = content.find(
      (c) =>
        c !== null &&
        typeof c === 'object' &&
        /** @type {Record<string,unknown>} */ (c).type === 'tool_result' &&
        /** @type {Record<string,unknown>} */ (c).tool_use_id === toolUseId,
    );
    if (!tr) continue;

    const trContent = /** @type {Record<string,unknown>} */ (tr).content;
    const text = Array.isArray(trContent)
      ? /** @type {Record<string,unknown>} */ (
          /** @type {unknown[]} */ (trContent).find((c) => /** @type {Record<string,unknown>} */ (c)?.type === 'text')
        )?.text
      : typeof trContent === 'string'
        ? trContent
        : null;

    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return null;
}

export { lib };
