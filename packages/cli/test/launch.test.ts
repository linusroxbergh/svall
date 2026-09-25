import { describe, expect, it } from 'vitest';
import type { HomeSetup } from '@archipelago/archid/setup';
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
      if (o.mismatch) throw new ProtocolMismatch('the running archid speaks protocol 1 and this archi speaks 2');
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

const work = { name: 'work', home: '/u/.archipelago-work', managed: true };
const priv = { name: 'private', home: '/u/.archipelago', managed: true };
const adhoc = { name: 'archi-dev', home: '/tmp/archi-dev', managed: false };

describe('launch', () => {
  it('opens an existing, loaded profile without touching launchd', async () => {
    const f = fake({ homes: [priv.home], loaded: ['io.github.linusroxbergh.archipelago.archid'] });
    await launch(priv, f.deps);
    expect(f.setups).toEqual([]);
    expect(f.calls).toEqual([
      ['launchctl', ['print', 'gui/501/io.github.linusroxbergh.archipelago.archid']],
      ['open', ['-n', '--env', 'ARCHI_HOME=/u/.archipelago', '-a', 'Archipelago']],
    ]);
  });

  it('creates a missing profile after a yes, with a free port and its own label, then bootstraps it', async () => {
    const f = fake({ answer: 'y' });
    await launch(work, f.deps);
    expect(f.prompts).toEqual(['create profile work at /u/.archipelago-work? [y/N] ']);
    expect(f.setups).toEqual([{ home: work.home, label: 'io.github.linusroxbergh.archipelago.archid.work', repoRoot: '/r', launchAgentsDir: '/u/Library/LaunchAgents', launchctl: false, port: 0 }]);
    expect(f.calls).toContainEqual(['launchctl', ['bootstrap', 'gui/501', '/u/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.work.plist']]);
    expect(f.calls.at(-1)).toEqual(['open', ['-n', '--env', 'ARCHI_HOME=/u/.archipelago-work', '-a', 'Archipelago']]);
  });

  it('refuses to create without a TTY or after a no', async () => {
    const msg = 'no profile work; run archi work in a terminal to create it';
    await expect(launch(work, fake({ isTTY: false }).deps)).rejects.toThrow(msg);
    const f = fake({ answer: 'n' });
    await expect(launch(work, f.deps)).rejects.toThrow(msg);
    expect(f.setups).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('rewrites a missing plist for an existing home before bootstrapping', async () => {
    const f = fake({ homes: [priv.home] });
    await launch(priv, f.deps);
    expect(f.setups.map((s) => [s.label, s.port])).toEqual([['io.github.linusroxbergh.archipelago.archid', undefined]]);
    expect(f.calls).toContainEqual(['launchctl', ['bootstrap', 'gui/501', '/u/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.plist']]);
  });

  it('sends a fleet whose agent still runs under the old label to desktop:install rather than start a second one', async () => {
    for (const [t, old] of [[priv, 'com.archipelago.archid'], [work, 'com.archipelago.archid.work']] as const) {
      const f = fake({ homes: [t.home, `/u/Library/LaunchAgents/${old}.plist`] });
      await expect(launch(t, f.deps)).rejects.toThrow('this fleet still runs under its old launchd label; run pnpm desktop:install to finish the update');
      expect(f.setups).toEqual([]);
      expect(f.calls.some(([, args]) => args[0] === 'bootstrap')).toBe(false);
    }
  });

  it('gives up when the daemon never answers', async () => {
    const f = fake({ homes: [work.home], loaded: ['io.github.linusroxbergh.archipelago.archid.work'], daemonUp: false });
    await expect(launch(work, f.deps)).rejects.toThrow('archid did not start; see /u/.archipelago-work/archid.log');
    expect(f.calls.some(([c]) => c === 'open')).toBe(false);
  });

  it('names the install step when the app is missing', async () => {
    const f = fake({ homes: [priv.home], loaded: ['io.github.linusroxbergh.archipelago.archid'], openFails: true });
    await expect(launch(priv, f.deps)).rejects.toThrow('Archipelago.app is not installed; run pnpm desktop:install');
  });

  it('sends a missing private home to setup instead of creating half of one', async () => {
    const f = fake({ answer: 'y' });
    await expect(launch(priv, f.deps)).rejects.toThrow('no private fleet yet; run archi setup first');
    expect(f.prompts).toEqual([]);
    expect(f.setups).toEqual([]);
  });

  it('opens an ad-hoc $ARCHI_HOME without giving it a launchd agent', async () => {
    const f = fake({ homes: [adhoc.home] });
    await launch(adhoc, f.deps);
    expect(f.setups).toEqual([]);
    expect(f.calls).toEqual([['open', ['-n', '--env', 'ARCHI_HOME=/tmp/archi-dev', '-a', 'Archipelago']]]);
  });

  it('refuses to create an ad-hoc home', async () => {
    const f = fake({ answer: 'y' });
    await expect(launch(adhoc, f.deps)).rejects.toThrow('no fleet at /tmp/archi-dev');
    expect(f.setups).toEqual([]);
  });

  it('gives up on a protocol mismatch instead of waiting it out', async () => {
    const f = fake({ homes: [work.home], loaded: ['io.github.linusroxbergh.archipelago.archid.work'], mismatch: true });
    await expect(launch(work, f.deps)).rejects.toThrow('the running archid speaks protocol 1 and this archi speaks 2');
    expect(f.connects).toHaveLength(1);
    expect(f.calls.some(([c]) => c === 'open')).toBe(false);
  });

  it('carries the underlying reason into the timeout', async () => {
    const f = fake({ homes: [work.home], loaded: ['io.github.linusroxbergh.archipelago.archid.work'], daemonUp: false });
    await expect(launch(work, f.deps)).rejects.toThrow('(down)');
  });
});
