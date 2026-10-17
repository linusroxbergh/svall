import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexZshEnv } from '../src/codex/zsh.js';

const runIf = fs.existsSync('/bin/zsh') ? describe : describe.skip;

runIf('codexZshEnv', () => {
  const homes: string[] = [];
  afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });

  // a home holding `files`, with a codex on PATH that prints its arguments
  function home(files: Record<string, string> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-zsh-'));
    homes.push(dir);
    for (const [name, text] of Object.entries({ 'bin/codex': '#!/bin/sh\necho "codex $*"\n', ...files })) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text, { mode: 0o755 });
    }
    const zdotdir = path.join(dir, 'svall', 'zsh');
    const zsh = (flags: string[], script: string, o: { svall?: boolean; inherited?: string } = {}) => execFileSync('/bin/zsh', [...flags, '-c', script], {
      encoding: 'utf8',
      env: { HOME: dir, PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, ...(o.svall === false ? {} : codexZshEnv(zdotdir, o.inherited)) },
    }).trim();
    return { dir, zdotdir, zsh };
  }

  it('runs codex off the shared server, but not beside --remote or a subcommand that needs the server', () => {
    const { zsh } = home();
    const calls = [
      'codex', 'codex resume --last', "codex 'explain --remote and --no-daemon'", 'codex -- --remote',
      'codex resume --no-daemon s1', 'codex --remote ws://h:1', 'codex --remote=ws://h:1', 'codex agents', 'codex queue s1 hi', 'codex remote-control stop',
    ];
    expect(zsh(['-i'], calls.join('; ')).split('\n')).toEqual([
      'codex --no-daemon', 'codex --no-daemon resume --last', 'codex --no-daemon explain --remote and --no-daemon', 'codex --no-daemon -- --remote',
      'codex resume --no-daemon s1', 'codex --remote ws://h:1', 'codex --remote=ws://h:1', 'codex agents', 'codex queue s1 hi', 'codex remote-control stop',
    ]);
  });

  it("runs the user's startup files as zsh would without it, and leaves children no ZDOTDIR", () => {
    const { zsh } = home(Object.fromEntries(['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map((f) => [f, `echo ${f}\n`])));
    const script = 'echo "ZDOTDIR=$(printenv ZDOTDIR)"';
    expect(zsh(['-l', '-i'], script)).toBe('.zshenv\n.zprofile\n.zshrc\n.zlogin\nZDOTDIR=');
    expect(zsh(['-l', '-i'], script)).toBe(zsh(['-l', '-i'], script, { svall: false }));
  });

  it('follows a ZDOTDIR the user sets in .zshenv, or one svalld was started with', () => {
    const moved = home({ '.zshenv': 'ZDOTDIR=$HOME/.config/zsh\n', '.config/zsh/.zshrc': 'echo moved\n' });
    expect(moved.zsh(['-i'], 'true')).toBe('moved');
    const inherited = home({ 'zd/.zshenv': 'echo env\n', 'zd/.zshrc': 'echo rc\n' });
    expect(inherited.zsh(['-i'], 'echo $ZDOTDIR', { inherited: path.join(inherited.dir, 'zd') })).toBe(`env\nrc\n${path.join(inherited.dir, 'zd')}`);
  });

  it('gives codex only to an interactive shell, under any alias the user gives it', () => {
    expect(home().zsh([], 'whence -w codex')).toBe('codex: command');
    expect(home({ '.zshrc': "alias codex='codex --yolo'\n" }).zsh(['-i'], 'codex hi')).toBe('codex --no-daemon --yolo hi');
    expect(home({ '.zshenv': "alias codex='codex --env'\n" }).zsh(['-i'], 'codex')).toBe('codex --no-daemon --env');
  });

  it("writes the file again when it differs, and passes on svalld's own ZDOTDIR but never its own dir", () => {
    const { zdotdir } = home();
    expect(codexZshEnv(zdotdir, undefined)).toEqual({ ZDOTDIR: zdotdir });
    const written = fs.readFileSync(path.join(zdotdir, '.zshenv'), 'utf8');
    fs.writeFileSync(path.join(zdotdir, '.zshenv'), 'stale');
    expect(codexZshEnv(zdotdir, '/u/zd')).toEqual({ ZDOTDIR: zdotdir, SVALL_ZDOTDIR: '/u/zd' });
    expect(fs.readFileSync(path.join(zdotdir, '.zshenv'), 'utf8')).toBe(written);
    expect(codexZshEnv(zdotdir, zdotdir)).toEqual({ ZDOTDIR: zdotdir });
  });
});
