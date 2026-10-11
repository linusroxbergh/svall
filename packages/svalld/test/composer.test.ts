import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { describe, expect, it } from 'vitest';
import { readComposer } from '../src/agent/composer.js';
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
    ['codex', 'codex-empty', 'empty'],
    ['codex', 'codex-working', 'empty'],
    ['codex', 'codex-draft', 'draft'],
    ['codex', 'codex-draft-home', 'draft'],
    ['codex', 'codex-multiline', 'draft'],
    ['codex', 'codex-approval', 'hidden'],
    ['codex', 'codex-question', 'hidden'],
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

  it('takes a colour argument of 2 for no faint', () => {
    expect(readComposer('claude', { rows: ['\x1b[38;5;2m❯ \x1b[39mtyped'], cursor: 0, command: 'claude' })).toBe('draft');
    expect(readComposer('claude', { rows: ['\x1b[38;2;2;2;2m❯ \x1b[2mplaceholder\x1b[0m'], cursor: 0, command: 'claude' })).toBe('empty');
  });
});
