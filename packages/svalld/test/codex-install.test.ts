import { describe, expect, it } from 'vitest';
import { codexHookCommand, codexPaths } from '../src/codex/install.js';
import { CODEX_HOOKS } from '../src/hooks/receiver.js';
import { codexInstalled, mergeCodexHooks, unmergeHooks } from '../src/setup.js';

const SCRIPT = '/h/agent-hook.mjs';
const CMD = codexHookCommand(SCRIPT);
type Hooks = { hooks: Record<string, { matcher?: string; hooks: { command: string; timeout: number; additionalContextLimit?: number }[] }[]> };

describe('codexPaths', () => {
  it('follows CODEX_HOME, else the home folder', () => {
    expect(codexPaths({ CODEX_HOME: '/x/cfg' }, '/h')).toEqual({ dir: '/x/cfg', config: '/x/cfg/config.toml', hooks: '/x/cfg/hooks.json' });
    expect(codexPaths({}, '/h').dir).toBe('/h/.codex');
  });
});

describe('mergeCodexHooks', () => {
  it('writes every codex event with no matcher', () => {
    const out = mergeCodexHooks({}, CMD, SCRIPT) as Hooks;
    expect(Object.keys(out.hooks).sort()).toEqual([...CODEX_HOOKS].sort());
    for (const groups of Object.values(out.hooks)) expect(groups[0].matcher).toBeUndefined();
  });

  it('gives SessionEnd and Interrupt a timeout inside their own cap', () => {
    const { hooks } = mergeCodexHooks({}, CMD, SCRIPT) as Hooks;
    expect(hooks.SessionEnd[0].hooks[0].timeout).toBeLessThanOrEqual(3);
    expect(hooks.Interrupt[0].hooks[0].timeout).toBeLessThanOrEqual(3);
  });

  it('lets the brief through whole on the two events the daemon answers', () => {
    const out = mergeCodexHooks({}, CMD, SCRIPT) as Hooks;
    expect(out.hooks.SessionStart[0].hooks[0].additionalContextLimit).toBe(0);
    expect(out.hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit).toBe(0);
    expect(out.hooks.Stop[0].hooks[0].additionalContextLimit).toBeUndefined();
  });

  it('writes one entry an event however often it runs', () => {
    const twice = mergeCodexHooks(mergeCodexHooks({}, CMD, SCRIPT), CMD, SCRIPT) as Hooks;
    for (const groups of Object.values(twice.hooks)) expect(groups.flatMap((g) => g.hooks)).toHaveLength(1);
    expect(codexInstalled(twice, SCRIPT)).toBe(true);
    expect(codexInstalled({}, SCRIPT)).toBe(false);
  });

  it('runs the helper beside the script, else plain node, so a node upgrade leaves the hook trusted', () => {
    expect(CMD).toBe(`[ -z "$SVALL_CHAR_ID" ] || { if [ -x '/h/svall-hook' ]; then '/h/svall-hook' codex "$PPID"; else node '/h/agent-hook.mjs' codex "$PPID"; fi; }`);
  });

  it('repairs an earlier command for the same script and keeps a hook of the user own', () => {
    const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /h/agent-hook.mjs codex' }] }, { hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    const out = mergeCodexHooks(mine, CMD, SCRIPT) as Hooks;
    expect(out.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command)).sort()).toEqual([CMD, 'mine.sh'].sort());
  });

  it('leaves a hook of the user own that shares the script name', () => {
    const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ~/hooks/agent-hook.mjs' }] }] } };
    const out = mergeCodexHooks(mine, CMD, SCRIPT) as Hooks;
    expect(out.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))).toEqual(['node ~/hooks/agent-hook.mjs', CMD]);
    expect(codexInstalled(mine, SCRIPT)).toBe(false);
  });

  it('counts as installed only with hooks that run this script, whatever they are named', () => {
    const foreign = { hooks: Object.fromEntries(CODEX_HOOKS.map((ev) => [ev, [{ hooks: [{ type: 'command', command: 'node /x/agent-hook.mjs codex' }] }]])) };
    expect(codexInstalled(foreign, SCRIPT)).toBe(false);
    expect(codexInstalled(mergeCodexHooks({}, CMD, SCRIPT), SCRIPT)).toBe(true);
  });

  it('takes back only its own', () => {
    const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    expect(unmergeHooks(mergeCodexHooks(mine, CMD, SCRIPT), SCRIPT)).toEqual(mine);
    expect(unmergeHooks(mergeCodexHooks({}, CMD, SCRIPT), SCRIPT)).toEqual({});
  });
});
