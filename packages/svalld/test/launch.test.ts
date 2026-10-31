import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContextItem } from '@svall/protocol';
import { AGENTS, onPath } from '../src/agents.js';
import { agentKindOf, isAgentCommand, promptText, withAddDirs, withoutV1Flags, withPromptFile, withStandalone } from '../src/context/launch.js';

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

describe('withAddDirs for opencode', () => {
  const rule = (resource: string) => `{"action":"external_directory","resource":"${resource}","effect":"allow"}`;
  it('allows each folder through OPENCODE_CONFIG_CONTENT, which the prompt and kind still read past', () => {
    const cmd = withAddDirs('opencode -s ses_0f3a5b7c9d1eAbCdEfGhIjKlMn', [item('folder', '/a/b'), item('file', "/c'd/y.md")]);
    expect(cmd).toBe(`OPENCODE_CONFIG_CONTENT='{"permissions":[${rule('/a/b/*')},${rule("/c'\\''d/*")}]}' opencode -s ses_0f3a5b7c9d1eAbCdEfGhIjKlMn`);
    expect(agentKindOf(cmd)).toBe('opencode');
    expect(withAddDirs('opencode', [])).toBe('opencode');
    expect(withPromptFile(withAddDirs('opencode', [item('folder', '/a')]), 'go', '/h/p').text).toMatch(/ opencode --prompt 'go'\n$/);
  });
  it('allows a folder by its resolved path, leaves one named with a wildcard to ask, and reads no flag in a folder name', () => {
    expect(withAddDirs('opencode', [item('folder', '/a/b/'), item('folder', '/c/*'), item('folder', '/d/e?')]))
      .toBe(`OPENCODE_CONFIG_CONTENT='{"permissions":[${rule('/a/b/*')}]}' opencode`);
    expect(withAddDirs('opencode', [item('folder', '/c/*')])).toBe('opencode');
    expect(withPromptFile(withAddDirs('opencode', [item('folder', '/notes -s draft')]), 'go', '/h/p').text).toMatch(/ opencode --prompt 'go'\n$/);
    expect(withPromptFile("opencode '/notes -s draft'", 'go', '/h/p').text).toMatch(/ '\/notes -s draft' --prompt 'go'\n$/);
  });
});

describe('withStandalone', () => {
  it('runs opencode on a private server, past the folder access set ahead of it, and leaves other agents be', () => {
    expect(withStandalone('opencode -s ses_0f3a5b7c9d1eAbCdEfGhIjKlMn')).toBe('opencode --standalone -s ses_0f3a5b7c9d1eAbCdEfGhIjKlMn');
    const access = withAddDirs('opencode', [item('folder', '/a')]);
    expect(withStandalone(access)).toBe(`${access} --standalone`);
    expect(withStandalone('opencode --standalone')).toBe('opencode --standalone');
    expect(withStandalone('opencode --server http://localhost:4096')).toBe('opencode --server http://localhost:4096');
    expect(withStandalone(withAddDirs('opencode', [item('folder', '/x --standalone')]))).toContain(' opencode --standalone');
    expect(withStandalone("opencode '/w/a --server b'")).toBe("opencode --standalone '/w/a --server b'");
    expect(withStandalone("opencode '/w/a -m b'")).toBe("opencode --standalone '/w/a -m b'");
    expect(withStandalone('claude')).toBe('claude');
  });

  it('runs codex off the shared app-server daemon and its update check, after the subcommand that resumes or forks', () => {
    expect(withStandalone('codex')).toBe('codex --no-daemon -c check_for_update_on_startup=false');
    expect(withStandalone(" codex -m gpt-5.5 --add-dir '/a'")).toBe(" codex --no-daemon -c check_for_update_on_startup=false -m gpt-5.5 --add-dir '/a'");
    expect(withStandalone('codex resume -c tui.resume_cwd=session s1')).toBe('codex resume --no-daemon -c check_for_update_on_startup=false -c tui.resume_cwd=session s1');
    expect(withStandalone('codex fork s1')).toBe('codex fork --no-daemon -c check_for_update_on_startup=false s1');
    expect(withStandalone('codex resume --no-daemon s1')).toBe('codex resume --no-daemon s1');
    expect(withStandalone('codex --remote unix://')).toBe('codex --remote unix://');
    expect(withStandalone("codex --add-dir '/w/a --remote b'")).toBe("codex --no-daemon -c check_for_update_on_startup=false --add-dir '/w/a --remote b'");
  });

  it("launches mission control's crew on the model Settings picked", () => {
    expect(withStandalone(AGENTS.claude.crewCommand('sonnet'))).toBe('claude --model sonnet');
    expect(withStandalone(AGENTS.codex.crewCommand('gpt-6-astra'))).toBe('codex --no-daemon -c check_for_update_on_startup=false -m gpt-6-astra');
    expect(withStandalone(AGENTS.opencode.crewCommand('opencode/big-pickle'))).toBe('opencode --standalone');
  });
});

describe('withoutV1Flags', () => {
  it('sheds the -m and --agent a revive saved under OpenCode 1 carries', () => {
    expect(withoutV1Flags(`opencode -m 'opencode/big-pickle' --agent 'build' -s ses_0f3a5b7c9d1eAbCdEfGhIjKlMn`))
      .toBe('opencode -s ses_0f3a5b7c9d1eAbCdEfGhIjKlMn');
    expect(withoutV1Flags("codex resume -c tui.resume_cwd=session -m 'gpt-5.5' s1")).toBe("codex resume -c tui.resume_cwd=session -m 'gpt-5.5' s1");
  });
});

describe('promptText', () => {
  it("ends a bare /command for opencode with a space, which closes the TUI's command menu that holds back a submit", () => {
    expect(promptText('opencode', '/svall-status')).toBe('/svall-status ');
    expect(promptText('opencode', '/svall-status now')).toBe('/svall-status now');
    expect(promptText('opencode', 'fix it')).toBe('fix it');
    expect(promptText('claude', '/svall-status')).toBe('/svall-status');
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
    expect(withPromptFile('opencode -m opencode/big-pickle', 'fix it', '/h/c_1.prompt'))
      .toEqual({ text: "rm -f '/h/c_1.prompt'; opencode -m opencode/big-pickle --prompt 'fix it'\n", line: ". '/h/c_1.prompt'" });
    expect(withPromptFile('opencode -s ses_0f3a5b7c9d1eAbCdEfGhIjKlMn', 'fix it', '/h/c_1.prompt'))
      .toEqual({ text: 'fix it', line: 'opencode -s ses_0f3a5b7c9d1eAbCdEfGhIjKlMn' });
  });
  it('passes the prompt as the last argument, after the options, from a file that removes itself', () => {
    expect(withPromptFile("claude --add-dir '/a'", 'fix it', "/h/it's.prompt"))
      .toEqual({ text: "rm -f '/h/it'\\''s.prompt'; claude --add-dir '/a' -- 'fix it'\n", line: ". '/h/it'\\''s.prompt'" });
    // fish reads \\ and \' inside single quotes, so neither is left inside them
    expect(withPromptFile('claude', "a\\b\\\\c'd\\", '/h/p').text).toBe(String.raw`rm -f '/h/p'; claude -- 'a'\\'b'\\\\'c'\''d'\\` + '\n');
  });
  // ' and \ are what fish reads differently inside single quotes; $ ( { * ~ are its own; the agent's name is a function
  const PROMPT = "it's a \\ and a \\\\ in\n$HOME $(id) (id) `id` {a,b} *.ts ~ \"q\" ; & | # ! ends in \\";
  const shells: Record<string, { args: string[]; fn: string }> = {
    bash: { args: ['--norc', '--noprofile', '-c'], fn: 'claude() { command claude --via-function "$@"; }' },
    zsh: { args: ['-f', '-c'], fn: 'claude() { command claude --via-function "$@"; }' },
    dash: { args: ['-c'], fn: 'claude() { command claude --via-function "$@"; }' },
    fish: { args: ['--no-config', '-c'], fn: 'function claude; command claude --via-function $argv; end' },
  };
  for (const [sh, { args, fn }] of Object.entries(shells)) {
    it.skipIf(!onPath(sh, process.env.PATH ?? ''))(`runs in ${sh} through its own claude function, the prompt one argument, the file gone`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
      const argv = path.join(dir, 'argv');
      fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > '${argv}'\n`, { mode: 0o755 });
      const file = path.join(dir, "c_1 it's.prompt");
      const { text, line } = withPromptFile("claude --add-dir '/a b'", PROMPT, file);
      fs.writeFileSync(file, text);
      const r = spawnSync(sh, [...args, `${fn}; ${line}`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(fs.readFileSync(argv, 'utf8').split('\0').slice(0, -1)).toEqual(['--via-function', '--add-dir', '/a b', '--', PROMPT]);
      expect(fs.existsSync(file)).toBe(false);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});
