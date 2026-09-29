import { describe, expect, it } from 'vitest';
import type { ContextItem } from '@svall/protocol';
import { takesPrompt, withAddDirs, withPromptFile } from '../src/context/launch.js';

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
    expect(takesPrompt('claude')).toBe(true);
    expect(takesPrompt('claude --model sonnet')).toBe(true);
    expect(takesPrompt('codex')).toBe(true);
    expect(takesPrompt('codex -m gpt-6-luna')).toBe(true);
    expect(takesPrompt('codex resume -c tui.resume_cwd=session s1')).toBe(true);
    // as the app reads a home.command with a stray space
    expect(takesPrompt(' codex')).toBe(true);
    expect(takesPrompt('claudette')).toBe(false);
    expect(takesPrompt('codexx')).toBe(false);
    expect(takesPrompt('node fake.mjs')).toBe(false);
  });
  it('passes the file as the last argument, after the options, and removes it once read', () => {
    expect(withPromptFile("claude --add-dir '/a'", "/h/it's.prompt"))
      .toBe(`claude --add-dir '/a' -- "$(cat '/h/it'\\''s.prompt'; rm -f '/h/it'\\''s.prompt')"`);
  });
});
