#!/usr/bin/env node
/**
 * One-shot testbed script: start a Claude Code session, invoke /cursed:advise,
 * and print the structured result.
 *
 * Usage: node scripts/run-advise-testbed.mjs
 */
import * as lib from 'claude-code-testbed';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let session;
try {
  console.log('Starting testbed session…');
  // pluginDir omitted: cursed is installed as a user-level plugin via cursed@cursed-local.
  // Passing pluginDir would load a second copy from the repo root, causing an MCP name
  // conflict with the already-installed user plugin.
  session = await lib.start({
    projectDir: REPO_ROOT,
    model: 'haiku',
    bare: false,
    name: 'advise-manual',
  });
  console.log(`Session started: ${session.id} (tmux: ${session.tmuxName})`);

  console.log('Sending /cursed:advise…');
  await lib.slash(session.id, '/cursed:advise "Should this project use tabs or spaces?"');

  console.log('Waiting for model to finish…');
  await lib.waitIdle(session.id, { timeoutMs: 120_000, idleMs: 3_000 });

  const events = await lib.events(session.id);
  console.log(`\nTotal events: ${events.length}`);

  // Show all tool_use calls to find the right tool name
  console.log('\n=== All tool_use blocks in assistant events ===');
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'tool_use') {
        console.log(`  tool_use: name=${c.name} id=${c.id}`);
        console.log(`    input: ${JSON.stringify(c.input).slice(0, 200)}`);
      }
    }
  }

  // Find the advise tool_use — try common name variants
  const adviseCandidates = ['mcp__plugin_cursed_cursed__advise', 'mcp__cursed_cursed__advise', 'advise'];
  let toolUseId = null;
  let foundToolName = null;
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const candidate of adviseCandidates) {
      const tu = content.find((c) => c?.type === 'tool_use' && c?.name === candidate);
      if (tu) {
        toolUseId = tu.id;
        foundToolName = candidate;
        break;
      }
    }
    if (toolUseId) break;
  }

  if (!toolUseId) {
    console.error('\nadvise tool was never called.');
    process.exit(1);
  }
  console.log(`\nFound tool_use: ${foundToolName} (id=${toolUseId})`);

  // Find the matching tool_result
  let resultText = null;
  for (const e of events) {
    if (e.type !== 'user') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const tr = content.find((c) => c?.type === 'tool_result' && c?.tool_use_id === toolUseId);
    if (!tr) continue;
    const tc = tr.content;
    resultText = Array.isArray(tc) ? tc.find((c) => c?.type === 'text')?.text : typeof tc === 'string' ? tc : null;
    break;
  }

  if (!resultText) {
    console.error('No tool_result found for advise.');
    console.log('\nAll events:');
    console.log(JSON.stringify(events, null, 2));
    process.exit(1);
  }

  console.log('\n=== Raw result text ===');
  console.log(resultText);

  let result;
  try {
    result = JSON.parse(resultText);
  } catch {
    console.error('Could not parse result as JSON.');
    process.exit(1);
  }
  console.log('\n=== SoloRunResult ===');
  console.log(JSON.stringify(result, null, 2));

  // Print captured pane too
  const pane = await lib.pane(session.id, { lines: 50 });
  console.log('\n=== Pane output ===');
  console.log(pane);
} finally {
  if (session) {
    await lib.kill(session.id);
    console.log('Session killed.');
  }
}
