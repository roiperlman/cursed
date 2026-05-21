import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrompt, substitute } from '../../scripts/lib/prompt.mjs';

describe('prompt', () => {
  it('substitutes {{KEY}} placeholders', () => {
    const out = substitute('Hello {{NAME}}, say {{GREETING}}.', { NAME: 'alice', GREETING: 'hi' });
    expect(out).toBe('Hello alice, say hi.');
  });

  it('leaves unknown placeholders in place for caller to detect', () => {
    const out = substitute('Hello {{NAME}}', {});
    expect(out).toBe('Hello {{NAME}}');
  });

  it('substitutes multiline values', () => {
    const out = substitute('A\n{{BODY}}\nZ', { BODY: 'one\ntwo' });
    expect(out).toBe('A\none\ntwo\nZ');
  });

  it('loadPrompt reads a file and applies substitutions', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-prompt-'));
    try {
      const path = join(tmp, 'x.md');
      await writeFile(path, 'Task: {{TASK}}\nScope: {{SCOPE}}');
      const out = await loadPrompt(path, { TASK: 'do it', SCOPE: 'diff' });
      expect(out).toBe('Task: do it\nScope: diff');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
