import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { describe, expect, it } from 'vitest';
import { agentInFront, readComposer } from '../src/agent/composer.js';
import { parseScreen } from '../src/tmux/tmux.js';

// panes of Claude Code 2.1.296, Codex 0.161–0.162 and OpenCode 2.0.26 as `Tmux.screen` read them, cut to their last rows
const screen = (name: string) => parseScreen(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/composer', `${name}.txt`), 'utf8'));

describe('readComposer', () => {
  const cases: [AgentKind, string, ReturnType<typeof readComposer>][] = [
    ['claude', 'claude-empty', 'empty'],
    ['claude', 'claude-empty-placeholder', 'empty'],
    ['claude', 'claude-working', 'empty'],
    ['claude', 'claude-working-queued', 'empty'],
    ['claude', 'claude-draft', 'draft'],
    ['claude', 'claude-draft-home', 'draft'],
    ['claude', 'claude-multiline', 'draft'],
    ['claude', 'claude-working-draft', 'draft'],
    ['claude', 'claude-permission', 'hidden'],
    ['claude', 'claude-question', 'hidden'],
    ['claude', 'claude-trust', 'hidden'],
    // the free-text option's own field shows the cursor
    ['claude', 'claude-question-field', 'draft'],
    ['codex', 'codex-empty', 'empty'],
    ['codex', 'codex-working', 'empty'],
    ['codex', 'codex-draft', 'draft'],
    ['codex', 'codex-draft-home', 'draft'],
    ['codex', 'codex-multiline', 'draft'],
    ['codex', 'codex-approval', 'hidden'],
    ['codex', 'codex-question', 'hidden'],
    ['codex', 'codex-hooks-review', 'hidden'],
    ['opencode', 'oc-empty-home', 'empty'],
    ['opencode', 'oc-empty-session', 'empty'],
    ['opencode', 'oc-working', 'empty'],
    ['opencode', 'oc-draft', 'draft'],
    ['opencode', 'oc-draft-home', 'draft'],
    ['opencode', 'oc-multiline', 'draft'],
    ['opencode', 'oc-permission', 'hidden'],
  ];
  it.each(cases)('reads %s %s as %s', (kind, name, want) => {
    expect(readComposer(kind, screen(name))).toBe(want);
  });

  // the cursor moved up to a multi-line draft's first line, emptied, with the rest of the draft below it
  it.each([['claude', 'claude-multiline'], ['codex', 'codex-multiline'], ['opencode', 'oc-multiline']] as const)(
    'reads %s with an empty first line over the rest of a draft as the draft', (kind, name) => {
      const s = screen(name);
      const first = s.rows.findIndex((r) => r.includes('half typed draft'));
      s.rows[first] = s.rows[first].replace('half typed draft', '');
      expect(readComposer(kind, { ...s, cursor: first })).toBe('draft');
    });

  it('reads the cursor on a blank line under another in an OpenCode draft as the draft', () => {
    // a paragraph break: the draft's line, then two newlines
    const s = screen('oc-multiline');
    const two = s.rows.findIndex((r) => r.includes('line two'));
    const blank = s.rows[two].replace('line two', '');
    s.rows.splice(two, 1, blank, blank);
    expect(readComposer('opencode', { ...s, cursor: two + 1 })).toBe('draft');
  });

  it('takes a colour argument of 2 for no faint', () => {
    expect(readComposer('claude', { rows: ['\x1b[38;5;2m❯ \x1b[39m'], cursor: 0, command: 'claude' })).toBe('empty');
    expect(readComposer('claude', { rows: ['\x1b[38;2;2;2;2m❯ \x1b[2mplaceholder\x1b[0m'], cursor: 0, command: 'claude' })).toBe('empty');
  });
});

describe('agentInFront', () => {
  it.each([['2.1.296', 'claude'], ['claude', 'claude'], ['codex', 'codex'], ['opencode', 'opencode'], ['zsh', undefined], ['vim', undefined], ['node', undefined]])(
    'takes a pane running %s for %s', (command, kind) => {
      expect(agentInFront(command)).toBe(kind);
    });
});
