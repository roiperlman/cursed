import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
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

/**
 * Send a named tmux key to the session (e.g. 'Down', 'Space', 'Enter').
 * Looks up the tmuxName from the testbed registry, then calls `tmux send-keys`.
 *
 * @param {string} sessionId
 * @param {string} key  tmux key name, e.g. 'Down', 'Up', 'Enter', 'Space'
 * @returns {Promise<void>}
 */
async function sendTmuxKey(sessionId, key) {
  const sessions = await lib.list();
  const found = sessions.find((s) => s.id === sessionId);
  if (!found) return; // session gone
  await new Promise((resolve, reject) => {
    execFile('tmux', ['send-keys', '-t', found.tmuxName, '--', key], (err) => {
      if (err) reject(err);
      else resolve(undefined);
    });
  });
}

/**
 * Drive a Claude Code session through `AskUserQuestion` prompts by accepting
 * the highlighted default option. Polls the tmux pane; when it sees a question
 * UI, sends Enter to confirm. For multi-select questions (where "Next" appears
 * as the last navigable option), navigates down to "Next" and presses Enter to
 * advance without selecting any items (accepting the model-pre-selected defaults).
 * Returns when no question UI has appeared for `quietMs`, or `timeoutMs` elapses.
 *
 * @param {string} sessionId
 * @param {{ timeoutMs?: number, quietMs?: number }} [opts]
 */
export async function answerQuestions(sessionId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const quietMs = opts.quietMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  // lastActivityAt tracks the last time we observed any interactive activity
  // (a question appeared or we successfully answered one). quietMs expires from
  // this baseline; if nothing happens for quietMs ms, we assume the flow is done.
  let lastActivityAt = Date.now();
  // lastActionPane: snapshot of the pane at the time we SENT a response.
  // Used to suppress duplicate sends when the UI is slow to update after our input.
  let lastActionPane = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    let pane = '';
    try {
      pane = await lib.pane(sessionId, { lines: 40 });
    } catch {
      break; // session gone
    }
    if (pane.includes('Do you want to proceed?')) {
      if (pane !== lastActionPane) {
        await lib.send(sessionId, '2'); // MCP permission prompt — "Yes, and don't ask again"
        lastActionPane = pane;
        lastActivityAt = Date.now();
      }
      continue;
    }
    // AskUserQuestion UI: Claude Code renders a breadcrumb + option list + footer.
    // Detect by the footer hint text ("Enter to select") which only appears inside
    // the question widget. The raw input-prompt cursor (❯) is present on every idle
    // screen, so we do NOT match ❯ alone.
    //
    // Also detect numbered-choice prompts (rawlist style) where options are presented
    // as "❯ 1. <option>" — e.g. the /cursed:setup "Ready to submit?" confirmation.
    // These are answered by typing the option number + Enter.
    const isArrowUi =
      pane.includes('Enter to select') ||
      pane.includes('Tab/Arrow keys to navigate') ||
      /Use (arrow|↑|↓).*to (select|navigate)/i.test(pane);
    // Numbered rawlist: highlighted first option shows as "❯ 1." at start of a line.
    const isNumberedUi = /^\s*❯\s+1\./m.test(pane);
    const isQuestionUi = isArrowUi || isNumberedUi;

    if (isQuestionUi) {
      // Mark activity: a question is visible.
      lastActivityAt = Date.now();

      // Deduplicate: only send keys if the pane differs from our last action pane.
      // If the UI hasn't changed yet after our input, wait another poll cycle.
      if (pane === lastActionPane) {
        continue;
      }
      lastActionPane = pane;

      if (isNumberedUi && !isArrowUi) {
        // Numbered rawlist: type "1" + Enter to pick the first (default) option.
        await lib.send(sessionId, '1');
        continue;
      }

      if (pane.includes('Next')) {
        // Multi-select question: select the first (highlighted/default) option by
        // pressing Enter, then navigate down to the "Next" option and press Enter.
        // Selecting the first option prevents the "User declined" outcome that occurs
        // when no option is checked before navigating to Next.
        const hasChecked = pane.includes('[✔]') || pane.includes('[x]') || pane.includes('[X]');
        if (!hasChecked) {
          // Press Enter to check the currently-highlighted (first) option
          await sendTmuxKey(sessionId, 'Enter');
          await new Promise((r) => setTimeout(r, 300));
        }
        // Navigate to the "Next" option
        let currentPane = await lib.pane(sessionId, { lines: 40 }).catch(() => pane);
        let atNext = /❯\s+\d+\.\s+\[\s*\]\s*Type something|❯\s+Next|❯.*Next/m.test(currentPane);
        if (!atNext) {
          // Press Down up to 10 times to reach "Next"
          for (let i = 0; i < 10; i++) {
            await sendTmuxKey(sessionId, 'Down');
            await new Promise((r) => setTimeout(r, 150));
            currentPane = await lib.pane(sessionId, { lines: 40 }).catch(() => '');
            atNext = /❯\s+\d+\.\s+\[\s*\]\s*Type something|❯.*Next/m.test(currentPane);
            if (atNext) {
              lastActionPane = currentPane; // update snapshot to the post-navigation state
              break;
            }
          }
        }
        // Press Enter to submit the "Next" option
        await sendTmuxKey(sessionId, 'Enter');
      } else {
        // Single-select or final submit: press Enter on the highlighted option
        await sendTmuxKey(sessionId, 'Enter');
      }
      continue;
    }
    // No question UI visible. If nothing has happened for quietMs, we're done.
    if (Date.now() - lastActivityAt > quietMs) break;
  }
}

export { lib };
