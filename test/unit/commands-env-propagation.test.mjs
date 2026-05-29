import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = join(__dirname, '..', '..', 'commands');

/**
 * Slash command bodies are read by Claude Code with ${CLAUDE_PLUGIN_ROOT} /
 * ${CLAUDE_PLUGIN_DATA} substitution applied to the file text. The Bash tool
 * that ultimately executes the substituted line does NOT inherit those vars
 * from the Claude Code process — only what the command line itself exports
 * survives. Any slash command shelling out to scripts/cursed.mjs must
 * therefore forward CLAUDE_PLUGIN_DATA explicitly, otherwise the CLI falls
 * back to <TMPDIR>/cursed-plugin and looks at a different state directory
 * than the one the MCP server writes to. (ROI-59)
 */
describe('slash commands forward CLAUDE_PLUGIN_DATA', () => {
  it('every commands/*.md that invokes scripts/cursed.mjs prefixes the call with CLAUDE_PLUGIN_DATA="$" + "{CLAUDE_PLUGIN_DATA}"', async () => {
    const files = (await readdir(COMMANDS_DIR)).filter((f) => f.endsWith('.md'));
    const missing = [];
    for (const file of files) {
      const body = await readFile(join(COMMANDS_DIR, file), 'utf8');
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (!line.includes('scripts/cursed.mjs')) continue;
        if (!/CLAUDE_PLUGIN_DATA="\$\{CLAUDE_PLUGIN_DATA\}"/.test(line)) {
          missing.push({ file, line });
        }
      }
    }
    expect(missing, JSON.stringify(missing, null, 2)).toEqual([]);
  });
});
