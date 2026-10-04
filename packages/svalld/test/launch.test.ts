import { describe, expect, it } from 'vitest';
import type { ContextItem } from '@svall/protocol';
import { isAgentCommand, withAddDirs, withPromptFile } from '../src/context/launch.js';

const item = (kind: ContextItem['kind'], ref: string): ContextItem => ({ kind, ref, label: '', source: 'manual' });

describe('withAddDirs', () => {
  it('appends one --add-dir per folder and per file parent, deduplicated, quoted', () => {
    expect(withAddDirs('claude', [item('folder', '/a/b'), item('file', '/a/b/x.md'), item('file', "/c d/y.md"), item('pr', 'https://x')]))
      .toBe("claude --add-dir '/a/b' --add-dir '/c d'");
  });
  it('keeps a resume command and its flags', () => {
    expect(withAddDirs('claude --resume s1', [item('folder', '/a')])).toBe("claude --resume s1 --add-dir '/a'");
    expect(withAddDirs('codex resume s1', [item('folder', '/a')])).toBe("codex resume s1 --add-dir '/a'");
  });
  it('leaves other commands and an empty list alone', () => {
    expect(withAddDirs('claude', [])).toBe('claude');
    expect(withAddDirs('codexx', [item('folder', '/a')])).toBe('codexx');
    expect(withAddDirs('vim', [item('folder', '/a')])).toBe('vim');
    expect(withAddDirs('claudette', [item('folder', '/a')])).toBe('claudette');
  });
});

describe('withPromptFile', () => {
  it('is for claude and codex', () => {
    expect(isAgentCommand('claude')).toBe(true);
    expect(isAgentCommand('claude --model sonnet')).toBe(true);
    expect(isAgentCommand('codex')).toBe(true);
    expect(isAgentCommand('codex -m gpt-6-luna')).toBe(true);
    expect(isAgentCommand('codex resume -c tui.resume_cwd=session s1')).toBe(true);
    // as the app reads a home.command with a stray space
    expect(isAgentCommand(' codex')).toBe(true);
    expect(isAgentCommand('claudette')).toBe(false);
    expect(isAgentCommand('codexx')).toBe(false);
    expect(isAgentCommand('node fake.mjs')).toBe(false);
  });
  it('hands opencode its prompt with --prompt, and leaves the file to the plugin on a resume', () => {
    expect(isAgentCommand('opencode')).toBe(true);
    expect(isAgentCommand('opencodex')).toBe(false);
    expect(withPromptFile('opencode -m opencode/big-pickle', '/h/c_1.prompt'))
      .toBe(`opencode -m opencode/big-pickle --prompt "$(cat '/h/c_1.prompt'; rm -f '/h/c_1.prompt')"`);
    expect(withPromptFile('opencode -s ses_0f3a5b7c9d1eAbCdEfGhIjKlMn', '/h/c_1.prompt')).toBe('opencode -s ses_0f3a5b7c9d1eAbCdEfGhIjKlMn');
  });
  it('passes the file as the last argument, after the options, and removes it once read', () => {
    expect(withPromptFile("claude --add-dir '/a'", "/h/it's.prompt"))
      .toBe(`claude --add-dir '/a' -- "$(cat '/h/it'\\''s.prompt'; rm -f '/h/it'\\''s.prompt')"`);
  });
});
