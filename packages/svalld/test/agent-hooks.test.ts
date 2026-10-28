import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claudeHooksCurrent, codexHooksCurrent, hookCommand, hooksInstalled, mergeCodexHooks, mergeHooks, mergeStatusLine, statusWrapper, unmergeHooks, unmergeStatusLine,
} from '../src/agent-hooks.js';
import { codexHookCommand } from '../src/codex/install.js';
import { CLAUDE_HOOKS } from '../src/hooks/receiver.js';
import { isOurs, nodeRun } from '../src/paths.js';
import { shq } from '../src/text.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { cleanHomes(); vi.unstubAllEnvs(); });
const script = '/h/.svall/hooks/agent-hook.mjs';
const status = '/h/.svall/hooks/claude-status.mjs';

describe('isOurs', () => {
  const quoted = "/Users/o'brien/.svall/hooks/agent-hook.mjs";
  it('matches the installed script anywhere in a command, bare or quoted', () => {
    expect(isOurs(`SVALL_PID=$PPID ${hookCommand('/n/node', quoted, 'claude')} --from-hook`, quoted)).toBe(true);
    expect(isOurs(`FOO=1 node "${quoted}" claude; true`, quoted)).toBe(true);
    expect(isOurs(`/n/node ${script}`, script)).toBe(true);
  });
  it('leaves a script of the user own that shares the name', () => {
    for (const cmd of ['node ~/bin/agent-hook.mjs --notify', `node ${shq(quoted.replace('agent-hook', 'notify-agent-hook'))}`, 'node /elsewhere/hooks/agent-hook.mjs', undefined]) {
      expect(isOurs(cmd, quoted)).toBe(false);
    }
  });
});

describe('mergeHooks', () => {
  const cmd = `node ${shq(script)}`;
  it('adds one entry per event and keeps existing hooks', () => {
    const existing = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'other.sh' }] }] }, model: 'x' };
    const out = mergeHooks(existing, cmd, script) as { hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>; model: string };
    expect(out.model).toBe('x');
    expect(out.hooks.Stop).toHaveLength(2);
    expect(out.hooks.Stop[0].hooks[0].command).toBe('other.sh');
    for (const ev of CLAUDE_HOOKS) expect(out.hooks[ev].some((g) => g.matcher === '*' && g.hooks.some((h) => h.command === cmd && h.timeout === 10))).toBe(true);
    expect(existing.hooks.Stop).toHaveLength(1);
  });
  it('runs the hooks that only tell which subagent started or stopped without holding the agent up', () => {
    const out = mergeHooks({}, cmd, script) as { hooks: Record<string, { hooks: { async?: boolean }[] }[]> };
    expect(out.hooks.SubagentStart[0].hooks[0].async).toBe(true);
    expect(out.hooks.SubagentStop[0].hooks[0].async).toBe(true);
    // a question must be on record before the tool call that follows its answer
    expect(out.hooks.PermissionRequest[0].hooks[0].async).toBeUndefined();
    expect(out.hooks.PreToolUse[0].hooks[0].async).toBeUndefined();
  });
  it('makes a hook an earlier setup ran in the background wait again', () => {
    const stale = mergeHooks({}, cmd, script) as { hooks: Record<string, { hooks: { async?: boolean }[] }[]> };
    stale.hooks.PermissionRequest[0].hooks[0].async = true;
    const out = mergeHooks(stale, cmd, script) as typeof stale;
    expect(out.hooks.PermissionRequest[0].hooks[0].async).toBeUndefined();
    expect(out.hooks.SubagentStop[0].hooks[0].async).toBe(true);
  });
  it('is idempotent', () => {
    const once = mergeHooks({}, cmd, script);
    expect(mergeHooks(once, cmd, script)).toEqual(once);
  });
  it('rewrites the command an earlier setup wrote, keeping the hooks beside it', () => {
    const stale = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `'/old/node' '/h/.svall/hooks/agent-hook.mjs'`, timeout: 10 }, { type: 'command', command: 'mine.sh' }] }] } };
    const out = mergeHooks(stale, cmd, script) as { hooks: Record<string, { hooks: { command: string; timeout?: number }[] }[]> };
    expect(out.hooks.Stop).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 10 }, { type: 'command', command: 'mine.sh' }] }]);
  });
  it('leaves a hook of the user own that shares the script name, on the way in and out', () => {
    const mine = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node ~/bin/agent-hook.mjs --notify' }] }] } };
    const out = mergeHooks(mine, cmd, script, ['Stop']) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(out.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))).toEqual(['node ~/bin/agent-hook.mjs --notify', cmd]);
    expect(unmergeHooks(mine, script)).toEqual(mine);
  });
});

describe('hooksInstalled', () => {
  const statusLine = { type: 'command', command: statusWrapper('/n/node', status) };
  it('counts only hooks that run this fleet script, whatever they are named', () => {
    const foreign = Object.fromEntries(CLAUDE_HOOKS.map((ev) => [ev, [{ matcher: '*', hooks: [{ type: 'command', command: 'node /x/agent-hook.mjs claude' }] }]]));
    expect(hooksInstalled({ hooks: foreign, statusLine }, '/h/.svall')).toBe(false);
    expect(hooksInstalled({ ...mergeHooks({}, hookCommand('/n/node', script, 'claude'), script), statusLine }, '/h/.svall')).toBe(true);
  });
});

describe('claudeHooksCurrent', () => {
  const written = (node: string) => mergeStatusLine(mergeHooks({}, hookCommand(node, script, 'claude'), script), statusWrapper(node, status), status);
  it('reads hooks another node wrote as current while that node is there, and not once it is gone', () => {
    expect(claudeHooksCurrent(written(process.execPath), '/h/.svall')).toBe(true);
    const other = path.join(makeHome(), "o'brien-node");
    fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 });
    expect(claudeHooksCurrent(written(other), '/h/.svall')).toBe(true);
    fs.rmSync(other);
    expect(claudeHooksCurrent(written(other), '/h/.svall')).toBe(false);
  });
  it('reads hooks that miss an event setup now subscribes as out of date, so an install sets them up again', () => {
    const settings = written(process.execPath) as { hooks: Record<string, unknown> };
    delete settings.hooks.StopFailure;
    expect(claudeHooksCurrent(settings, '/h/.svall')).toBe(false);
    const codex = mergeCodexHooks({}, codexHookCommand(script), script) as { hooks: Record<string, unknown> };
    delete codex.hooks.Interrupt;
    expect(codexHooksCurrent(codex, script)).toBe(false);
  });
});

describe('mergeStatusLine', () => {
  const wrapper = `node ${shq(status)}`;
  const line = (o: Record<string, unknown>) => (mergeStatusLine(o, wrapper, status) as { statusLine: { type: string; command: string; padding?: number } }).statusLine;
  it('wraps the statusline the user already had and keeps its other keys', () => {
    const out = line({ statusLine: { type: 'command', command: 'ccstatusline', padding: 1 } });
    expect(out).toEqual({ type: 'command', command: `${wrapper} 'ccstatusline'`, padding: 1 });
  });
  it('stands alone when there is none', () => {
    expect(line({})).toEqual({ type: 'command', command: wrapper });
  });
  it('is idempotent', () => {
    const once = mergeStatusLine({ statusLine: { type: 'command', command: 'ccstatusline' } }, wrapper, status);
    expect(mergeStatusLine(once, wrapper, status)).toEqual(once);
  });
  it('rebuilds a wrapper whose node has moved, keeping the inner command', () => {
    // the inner command is `ccstatusline --it's`, shell-quoted the way setup writes it
    const quoted = String.raw`'ccstatusline --it'\''s'`;
    const stale = { statusLine: { type: 'command', command: `'/old/node' '/h/.svall/hooks/claude-status.mjs' ${quoted}` } };
    expect(line(stale)).toEqual({ type: 'command', command: `${wrapper} ${quoted}` });
  });
  it('rebuilds a wrapper that had no inner command', () => {
    const stale = { statusLine: { type: 'command', command: "'/old/node' '/h/.svall/hooks/claude-status.mjs'" } };
    expect(line(stale)).toEqual({ type: 'command', command: wrapper });
  });
  it('wraps a statusline of the user own that shares the script name, and leaves it on the way out', () => {
    const mine = { statusLine: { type: 'command', command: 'node ~/.claude/claude-status.mjs' } };
    expect(line(mine)).toEqual({ type: 'command', command: `${wrapper} 'node ~/.claude/claude-status.mjs'` });
    expect(unmergeStatusLine(mine, status)).toEqual(mine);
    expect(hooksInstalled({ ...mergeHooks({}, `node ${shq(script)}`, script), ...mine }, '/h/.svall')).toBe(false);
  });
});

describe('hookCommand and nodeRun', () => {
  const sh = (cmd: string, env: Record<string, string> = {}) =>
    execFileSync('sh', ['-c', cmd], { env: { ...process.env, ...env }, encoding: 'utf8', input: '' });
  const scripts = () => {
    const dir = makeHome();
    const script = path.join(dir, 'agent-hook.mjs');
    fs.writeFileSync(script, "process.stdout.write('ran ' + (process.argv[2] ?? ''))\n");
    const pinned = path.join(dir, 'node');
    fs.writeFileSync(pinned, '#!/bin/sh\necho pinned\n', { mode: 0o755 });
    return { dir, script, pinned };
  };

  it('runs the node setup ran with while it exists', () => {
    const { script, pinned } = scripts();
    expect(sh(hookCommand(pinned, script, 'claude'), { SVALL_ROBOT_ID: 'c1' })).toBe('pinned\n');
    expect(sh(nodeRun(pinned, script))).toBe('pinned\n');
  });

  it('falls back to node on PATH once that node is gone', () => {
    const { dir, script } = scripts();
    const gone = path.join(dir, 'gone', 'node');
    expect(sh(hookCommand(gone, script, 'codex'), { SVALL_ROBOT_ID: 'c1' })).toBe('ran codex');
    const wrapped = mergeStatusLine({ statusLine: { type: 'command', command: 'echo mine' } }, statusWrapper(gone, script), script);
    expect(sh((wrapped as { statusLine: { command: string } }).statusLine.command, { SVALL_ROBOT_ID: 'c1' })).toBe('ran echo mine');
  });

  it('skips node outside a robot', () => {
    const { script, pinned } = scripts();
    expect(sh(hookCommand(pinned, script, 'claude'), { SVALL_ROBOT_ID: '' })).toBe('');
    expect(sh(statusWrapper(pinned, script), { SVALL_ROBOT_ID: '' })).toBe('');
    const wrapped = mergeStatusLine({ statusLine: { type: 'command', command: 'echo "args:$#"' } }, statusWrapper(pinned, script), script);
    expect(sh((wrapped as { statusLine: { command: string } }).statusLine.command, { SVALL_ROBOT_ID: '' })).toBe('args:0\n');
  });

  it('runs the helper for a session an older svalld started, which carries SVALL_CHAR_ID', () => {
    const { dir, script, pinned } = scripts();
    fs.writeFileSync(path.join(dir, 'svall-hook'), '#!/bin/sh\necho "helper $*"\n', { mode: 0o755 });
    expect(sh(hookCommand(pinned, script, 'claude'), { SVALL_CHAR_ID: 'c1' })).toMatch(/^helper claude \d+\n$/);
    expect(sh(codexHookCommand(script), { SVALL_CHAR_ID: 'c1' })).toMatch(/^helper codex \d+\n$/);
    expect(sh(statusWrapper(pinned, script), { SVALL_CHAR_ID: 'c1' })).toBe('helper status\n');
  });

  it('runs the helper beside the script while it is there and executable, with the arguments the script would get', () => {
    const { dir, script, pinned } = scripts();
    const helper = path.join(dir, 'svall-hook');
    fs.writeFileSync(helper, '#!/bin/sh\necho "helper $*"\n', { mode: 0o755 });
    const wrapped = (inner: string) => (mergeStatusLine({ statusLine: { type: 'command', command: inner } }, statusWrapper(pinned, script), script) as { statusLine: { command: string } }).statusLine.command;
    expect(sh(hookCommand(pinned, script, 'claude'), { SVALL_ROBOT_ID: 'c1' })).toMatch(/^helper claude \d+\n$/);
    expect(sh(codexHookCommand(script), { SVALL_ROBOT_ID: 'c1' })).toMatch(/^helper codex \d+\n$/);
    expect(sh(wrapped("echo it's mine"), { SVALL_ROBOT_ID: 'c1' })).toBe("helper status echo it's mine\n");
    expect(sh(statusWrapper(pinned, script), { SVALL_ROBOT_ID: 'c1' })).toBe('helper status\n');
    expect(sh(wrapped('echo mine'), { SVALL_ROBOT_ID: '' })).toBe('mine\n');
    fs.chmodSync(helper, 0o644);
    expect(sh(hookCommand(pinned, script, 'claude'), { SVALL_ROBOT_ID: 'c1' })).toBe('pinned\n');
    expect(sh(wrapped('echo mine'), { SVALL_ROBOT_ID: 'c1' })).toBe('pinned\n');
  });

  it("starts nothing for an agent of the other variant's fleet, and still runs the wrapped statusline", () => {
    const root = makeHome();
    const run = (variant: string, home: string) => {
      const script = path.join(root, variant, 'hooks', 'agent-hook.mjs');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, '');
      const pinned = path.join(root, 'node');
      fs.writeFileSync(pinned, '#!/bin/sh\necho pinned\n', { mode: 0o755 });
      const status = (mergeStatusLine({ statusLine: { type: 'command', command: 'echo mine' } }, statusWrapper(pinned, script), script) as { statusLine: { command: string } }).statusLine.command;
      const env = { SVALL_ROBOT_ID: 'c1', SVALL_HOME: path.join(root, home) };
      return [sh(hookCommand(pinned, script, 'claude'), env), sh(status, env)];
    };
    expect(run('.svall', '.svall-dev')).toEqual(['', 'mine\n']);
    expect(run('.svall', '.svall-dev-x')).toEqual(['', 'mine\n']);
    expect(run('.svall', '.svall-work')).toEqual(['pinned\n', 'pinned\n']);
    expect(run('.svall-dev', '.svall')).toEqual(['', 'mine\n']);
    expect(run('.svall-dev', '.svall-work')).toEqual(['', 'mine\n']);
    expect(run('.svall-dev', '.svall-dev')).toEqual(['pinned\n', 'pinned\n']);
    expect(run('.svall-dev', 'fleet')).toEqual(['pinned\n', 'pinned\n']);
  });

  it('keeps the inner statusline when an earlier wrapper is rebuilt', () => {
    const once = mergeStatusLine({ statusLine: { type: 'command', command: "ccstatusline --it's" } }, nodeRun('/n/node', status), status);
    const moved = statusWrapper('/other/node', status);
    expect((mergeStatusLine(once, moved, status) as { statusLine: { command: string } }).statusLine.command)
      .toBe(`${moved} 'ccstatusline --it'\\''s'`);
  });
});

describe('commands Svall 0.1 wrote', () => {
  // what setup wrote before the helper, word for word
  const v01 = {
    hook: (node: string, script: string) => `[ -z "$SVALL_CHAR_ID" ] || { n=${shq(node)}; [ -x "$n" ] || n=node; "$n" ${shq(script)} claude "$PPID"; }`,
    codex: (script: string, node: string) => `[ -z "$SVALL_CHAR_ID" ] || { n=${shq(node)}; [ -x "$n" ] || n=node; "$n" ${shq(script)} codex "$PPID"; }`,
    status: (node: string, script: string) =>
      `svall_status() { if [ -n "$SVALL_CHAR_ID" ] && [ -f "$1" ]; then n=${shq(node)}; [ -x "$n" ] || n=node; "$n" "$@"; elif [ -n "$2" ]; then c=$2; shift 2; eval "$c"; fi; }; svall_status ${shq(script)}`,
  };
  const R = { hook: '/u/.svall/hooks/agent-hook.mjs', status: '/u/.svall/hooks/claude-status.mjs' };
  const D = { hook: '/u/.svall-dev/hooks/agent-hook.mjs', status: '/u/.svall-dev/hooks/claude-status.mjs' };
  const command = (s: Record<string, unknown>) => (s.statusLine as { command: string }).command;
  const old = (v: typeof R, inner?: string) => ({
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: v01.hook('/n/node', v.hook), timeout: 10 }, { type: 'command', command: 'mine.sh' }] }] },
    statusLine: { type: 'command', command: inner ? `${v01.status('/n/node', v.status)} ${shq(inner)}` : v01.status('/n/node', v.status) },
  });
  const now = (s: Record<string, unknown>, v: typeof R) =>
    mergeStatusLine(mergeHooks(s, hookCommand('/n/node', v.hook, 'claude'), v.hook, ['Stop']), statusWrapper('/n/node', v.status), v.status);

  it('rewrites them for the helper, keeping the hooks and the statusline beside them', () => {
    const out = now(old(R, "ccstatusline --it's"), R) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(out.hooks.Stop[0].hooks.map((h) => h.command)).toEqual([hookCommand('/n/node', R.hook, 'claude'), 'mine.sh']);
    expect(command(out)).toBe(`${statusWrapper('/n/node', R.status)} ${shq("ccstatusline --it's")}`);
    expect(hooksInstalled(old(R), '/u/.svall')).toBe(true);
    expect(claudeHooksCurrent(old(R), '/u/.svall')).toBe(false);
    const codex = { hooks: { Stop: [{ hooks: [{ type: 'command', command: v01.codex(R.hook, '/A/node') }] }] } };
    expect((mergeCodexHooks(codex, codexHookCommand(R.hook), R.hook) as { hooks: { Stop: { hooks: { command: string }[] }[] } }).hooks.Stop[0].hooks)
      .toEqual([expect.objectContaining({ command: codexHookCommand(R.hook) })]);
  });

  it('takes them out on the way out', () => {
    expect(unmergeStatusLine(unmergeHooks(old(R, 'my-status'), R.hook), R.status))
      .toEqual({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'mine.sh' }] }] }, statusLine: { type: 'command', command: 'my-status' } });
  });

  // each variant updates on its own, so a 0.1 wrapper sits outside or inside the other variant's newer one
  const wrap = (s: Record<string, unknown>, v: typeof R) => mergeStatusLine(s, statusWrapper('/n/node', v.status), v.status);
  for (const [first, second] of [[R, D], [D, R]]) {
    const start = { statusLine: { type: 'command', command: 'my-status' } };
    const current = wrap(wrap(start, first), second);

    it(`nests a 0.1 wrapper outside a newer one (${first === R ? 'release' : 'dev'} outside)`, () => {
      const both = wrap({ statusLine: old(first, 'my-status').statusLine }, second);
      expect(command(both).startsWith(v01.status('/n/node', first.status))).toBe(true);
      expect(wrap(both, second)).toEqual(both);
      expect(wrap(both, first)).toEqual(current);
      expect(unmergeStatusLine(both, first.status)).toEqual(wrap(start, second));
      expect(command(unmergeStatusLine(both, second.status))).toBe(`${v01.status('/n/node', first.status)} 'my-status'`);
    });

    it(`nests a 0.1 wrapper inside a newer one (${first === R ? 'release' : 'dev'} outside)`, () => {
      const both = { statusLine: { type: 'command', command: `${statusWrapper('/n/node', first.status)} ${shq(`${v01.status('/n/node', second.status)} 'my-status'`)}` } };
      expect(wrap(both, first)).toEqual(both);
      expect(wrap(both, second)).toEqual(current);
      expect(unmergeStatusLine(both, second.status)).toEqual(wrap(start, first));
      expect(command(unmergeStatusLine(both, first.status))).toBe(`${v01.status('/n/node', second.status)} 'my-status'`);
    });
  }
});

describe('both variants in one statusLine', () => {
  const R = '/u/.svall/hooks/claude-status.mjs';
  const D = '/u/.svall-dev/hooks/claude-status.mjs';
  const merge = (s: Record<string, unknown>, script: string) => mergeStatusLine(s, statusWrapper('/n/node', script), script);
  const command = (s: Record<string, unknown>) => (s.statusLine as { command: string }).command;
  const start = { statusLine: { type: 'command', command: 'my-status' } };

  for (const [first, second] of [[R, D], [D, R]]) {
    it(`keeps both wrappers and the user's command when ${first === R ? 'the release' : 'Svall Dev'} set up first`, () => {
      const both = merge(merge(start, first), second);
      expect(merge(both, first)).toEqual(both);
      expect(merge(both, second)).toEqual(both);
    });

    it(`takes either variant out and leaves the other wrapping the user's command (${first === R ? 'release' : 'dev'} first)`, () => {
      const both = merge(merge(start, first), second);
      expect(command(unmergeStatusLine(both, first))).toBe(command(merge(start, second)));
      expect(command(unmergeStatusLine(both, second))).toBe(command(merge(start, first)));
      expect(command(unmergeStatusLine(unmergeStatusLine(both, second), first))).toBe('my-status');
      expect(unmergeStatusLine(unmergeStatusLine(merge(merge({}, first), second), first), second)).toEqual({});
    });
  }
});
