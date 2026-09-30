import { describe, expect, it } from 'vitest';
import type { HomeSetup } from '@svall/svalld/setup';
import { ProtocolMismatch } from '../src/client.js';
import { launch, type LaunchDeps } from '../src/launch.js';

type Call = [string, string[]];

function fake(o: {
  homes?: string[]; loaded?: string[]; answer?: string; isTTY?: boolean; daemonUp?: boolean; openFails?: boolean; mismatch?: boolean;
} = {}) {
  const calls: Call[] = [];
  const connects: string[] = [];
  const setups: HomeSetup[] = [];
  const prompts: string[] = [];
  const files = new Set(o.homes ?? []);
  const deps: LaunchDeps = {
    exists: (p) => files.has(p),
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'launchctl' && args[0] === 'print' && !(o.loaded ?? []).some((l) => args[1].endsWith(`/${l}`))) throw new Error('not loaded');
      if (cmd === 'open' && o.openFails) throw new Error('Unable to find application');
    },
    prompt: async (q) => { prompts.push(q); return o.answer ?? ''; },
    isTTY: o.isTTY ?? true,
    connect: async (home) => {
      connects.push(home);
      if (o.mismatch) throw new ProtocolMismatch('the running svalld speaks protocol 1 and this svall speaks 2');
      if (o.daemonUp === false) throw new Error('down');
      return { close() {} };
    },
    setupHome: async (s) => { setups.push(s); files.add(s.home); files.add(`${s.launchAgentsDir}/${s.label}.plist`); return []; },
    uid: 501,
    launchAgentsDir: '/u/Library/LaunchAgents',
    repoRoot: '/r',
    timeoutMs: 30,
    intervalMs: 5,
  };
  return { deps, calls, setups, prompts, connects };
}

const work = { name: 'work', home: '/u/.svall-work', managed: true };
const priv = { name: 'private', home: '/u/.svall', managed: true };
const adhoc = { name: 'svall-dev', home: '/tmp/svall-dev', managed: false };

describe('launch', () => {
  it('opens an existing, loaded profile without touching launchd', async () => {
    const f = fake({ homes: [priv.home], loaded: ['io.github.linusroxbergh.svall.svalld'] });
    await launch(priv, f.deps);
    expect(f.setups).toEqual([]);
    expect(f.calls).toEqual([
      ['launchctl', ['print', 'gui/501/io.github.linusroxbergh.svall.svalld']],
      ['open', ['-n', '--env', 'SVALL_HOME=/u/.svall', '-b', 'io.github.linusroxbergh.svall']],
    ]);
  });

  it('creates a missing profile after a yes, with a free port and its own label, then bootstraps it', async () => {
    const f = fake({ answer: 'y' });
    await launch(work, f.deps);
    expect(f.prompts).toEqual(['create profile work at /u/.svall-work? [y/N] ']);
    expect(f.setups).toEqual([{ home: work.home, label: 'io.github.linusroxbergh.svall.svalld.work', repoRoot: '/r', launchAgentsDir: '/u/Library/LaunchAgents', launchctl: false, port: 0 }]);
    expect(f.calls).toContainEqual(['launchctl', ['bootstrap', 'gui/501', '/u/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.work.plist']]);
    expect(f.calls.at(-1)).toEqual(['open', ['-n', '--env', 'SVALL_HOME=/u/.svall-work', '-b', 'io.github.linusroxbergh.svall']]);
  });

  it('refuses to create without a TTY or after a no', async () => {
    const msg = 'no profile work; run svall work in a terminal to create it';
    await expect(launch(work, fake({ isTTY: false }).deps)).rejects.toThrow(msg);
    const f = fake({ answer: 'n' });
    await expect(launch(work, f.deps)).rejects.toThrow(msg);
    expect(f.setups).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('rewrites a missing plist for an existing home before bootstrapping', async () => {
    const f = fake({ homes: [priv.home] });
    await launch(priv, f.deps);
    expect(f.setups.map((s) => [s.label, s.port])).toEqual([['io.github.linusroxbergh.svall.svalld', undefined]]);
    expect(f.calls).toContainEqual(['launchctl', ['bootstrap', 'gui/501', '/u/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist']]);
  });

  it('gives up when the daemon never answers', async () => {
    const f = fake({ homes: [work.home], loaded: ['io.github.linusroxbergh.svall.svalld.work'], daemonUp: false });
    await expect(launch(work, f.deps)).rejects.toThrow('svalld did not start; see /u/.svall-work/svalld.log');
    expect(f.calls.some(([c]) => c === 'open')).toBe(false);
  });

  it('names the install step when the app is missing', async () => {
    const f = fake({ homes: [priv.home], loaded: ['io.github.linusroxbergh.svall.svalld'], openFails: true });
    await expect(launch(priv, f.deps)).rejects.toThrow('Svall is not installed; run pnpm desktop:install');
  });

  it('sends a missing private home to setup instead of creating half of one', async () => {
    const f = fake({ answer: 'y' });
    await expect(launch(priv, f.deps)).rejects.toThrow('no private fleet yet; run svall setup first');
    expect(f.prompts).toEqual([]);
    expect(f.setups).toEqual([]);
  });

  it('opens an ad-hoc $SVALL_HOME without giving it a launchd agent', async () => {
    const f = fake({ homes: [adhoc.home] });
    await launch(adhoc, f.deps);
    expect(f.setups).toEqual([]);
    expect(f.calls).toEqual([['open', ['-n', '--env', 'SVALL_HOME=/tmp/svall-dev', '-b', 'io.github.linusroxbergh.svall']]]);
  });

  it('refuses to create an ad-hoc home', async () => {
    const f = fake({ answer: 'y' });
    await expect(launch(adhoc, f.deps)).rejects.toThrow('no fleet at /tmp/svall-dev');
    expect(f.setups).toEqual([]);
  });

  it('gives up on a protocol mismatch instead of waiting it out', async () => {
    const f = fake({ homes: [work.home], loaded: ['io.github.linusroxbergh.svall.svalld.work'], mismatch: true });
    await expect(launch(work, f.deps)).rejects.toThrow('the running svalld speaks protocol 1 and this svall speaks 2');
    expect(f.connects).toHaveLength(1);
    expect(f.calls.some(([c]) => c === 'open')).toBe(false);
  });

  it('carries the underlying reason into the timeout', async () => {
    const f = fake({ homes: [work.home], loaded: ['io.github.linusroxbergh.svall.svalld.work'], daemonUp: false });
    await expect(launch(work, f.deps)).rejects.toThrow('(down)');
  });
});
