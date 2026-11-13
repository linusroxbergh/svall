import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { askLimits, connectArgs, connectChoice, flagLimits } from '../src/commands/limits.js';
import { addHost } from '../src/controller/host.js';
import { limitFlags, limitsLine, parseLimits, parseMemory } from '../src/controller/limits.js';
import { FLEET, LIMITS, REMOTE, TOKEN, archive, daemon, deps, healthy, ssh, step, useHostWorld } from './controller/host-world.js';

useHostWorld();

const SET = { ...LIMITS, limits: { cpus: 11, memoryMb: 94_976 }, state: 'applied' };

async function add(o: object = {}): Promise<{ result: string; set: string[][] }> {
  const d = await daemon();
  ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
  const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive(), ...o }, deps());
  await d.close();
  return { result: out.result, set: ssh.remoteCalls().filter((w) => w.includes('limits') && w.includes('set')).map((w) => w.slice(w.indexOf('set') + 1)) };
}

describe('host add and what the fleet may use of the machine', () => {
  it('sets nothing with no one to ask, says what the machine has and the command that caps it, and is ready all the same', async () => {
    healthy();
    const { result, set } = await add();
    expect(set).toEqual([]);
    expect(step('limits').at(-1)).toEqual({
      step: 'limits', status: 'warn',
      detail: 'trift has 12 cores and 93.8 GB, and this fleet may use all of it; svall host limits trift --cpus 11 --memory 94976M keeps the rest for the machine',
      offer: { size: LIMITS.size, suggested: LIMITS.suggested },
    });
    expect(result).toBe('ready');
  });

  it('sets what --limits names on the machine, and what a person answers when asked', async () => {
    ssh.reply(['fleet', 'limits', 'set'], { stdout: JSON.stringify(SET) });
    healthy();
    expect((await add({ limits: { cpus: 11, memoryMb: 94_976 } })).set).toEqual([['--cpus', '11', '--memory', '94976M']]);
    expect(step('limits').at(-1)).toEqual({ step: 'limits', status: 'ok', detail: 'this fleet may use 11 of 12 cores and 92.8 GB of 93.8 GB on trift' });
    const asked: unknown[] = [];
    const { set } = await add({ ask: (q: { name: string; report: unknown }) => { asked.push(q); return Promise.resolve({ memoryMb: 8192 }); } });
    expect(asked).toEqual([{ name: 'trift', report: LIMITS }]);
    expect(set.at(-1)).toEqual(['--memory', '8G']);
  });

  it('leaves a machine with no limit alone on --no-limits, and shows one that has a limit without asking', async () => {
    healthy();
    expect((await add({ limits: {} })).set).toEqual([]);
    expect(step('limits').at(-1)).toMatchObject({ status: 'ok', detail: 'trift has 12 cores and 93.8 GB, and this fleet may use all of it' });
    ssh.clearReplies();
    healthy({ limits: SET });
    const { set } = await add({ ask: () => { throw new Error('asked'); } });
    expect(set).toEqual([]);
    expect(step('limits').at(-1)).toMatchObject({ status: 'ok', detail: 'this fleet may use 11 of 12 cores and 92.8 GB of 93.8 GB on trift' });
  });

  it('goes on when the machine refuses the limit, with why and the way to set one later', async () => {
    ssh.reply(['fleet', 'limits', 'set'], { code: 1, stderr: 'svall: 6.2 GB is in use now; stop a robot or allow at least 7 GB\n' });
    healthy();
    const { result } = await add({ limits: { memoryMb: 4096 } });
    expect(step('limits').at(-1)).toEqual({ step: 'limits', status: 'warn', detail: 'no limit was set on trift: 6.2 GB is in use now; stop a robot or allow at least 7 GB; svall host limits trift sets one' });
    expect(result).toBe('ready');
  });
});

describe('the words of a limit', () => {
  it('reads cores,memory with either part left out, and refuses anything else', () => {
    expect(parseLimits('11,93G')).toEqual({ cpus: 11, memoryMb: 95_232 });
    expect(parseLimits(',512M')).toEqual({ memoryMb: 512 });
    expect(parseLimits('4')).toEqual({ cpus: 4 });
    expect(parseMemory('1.5g')).toBe(1536);
    for (const bad of ['', ',', '0,1G', '4,lots', '4,8G,2', '4,100M']) expect(() => parseLimits(bad)).toThrow();
  });

  it('turns flags into a limit: --none is no limit, none of them no answer', () => {
    expect(flagLimits({ cpus: '4', memory: '8G' })).toEqual({ cpus: 4, memoryMb: 8192 });
    expect(flagLimits({ none: true })).toEqual({});
    expect(flagLimits({})).toBeUndefined();
    expect(() => flagLimits({ none: true, cpus: '2' })).toThrow('--none goes with neither --cpus nor --memory');
    expect(limitFlags({})).toEqual(['--none']);
    expect(connectArgs({ limits: false })).toEqual(['--no-limits']);
    expect(connectArgs({ limits: '4,8G' })).toEqual(['--limits', '4,8G']);
    expect(connectArgs({})).toEqual([]);
    expect(connectChoice({ limits: false }, false)).toEqual({ limits: {} });
    expect(connectChoice({}, false)).toEqual({});
  });

  it('asks with the default filled in: Return takes it, none leaves no limit, another is read, and a slip is asked again', async () => {
    const report = LIMITS as never;
    const said = (answers: string[]) => { const asked: string[] = []; return { asked, q: (q: string) => { asked.push(q); return Promise.resolve(answers.shift()!); } }; };
    const a = said(['']);
    expect(await askLimits(a.q)({ name: 'trift', report })).toEqual({ cpus: 11, memoryMb: 94_976 });
    expect(a.asked).toEqual(['trift has 12 cores and 93.8 GB. This fleet may use [11 cores, 92.8 GB], or none: ']);
    expect(await askLimits(said(['none']).q)({ name: 'trift', report })).toEqual({});
    expect(await askLimits(said(['lots', '4,8G']).q)({ name: 'trift', report })).toEqual({ cpus: 4, memoryMb: 8192 });
  });

  it('says why a limit does not hold, and how often the fleet reached it', () => {
    const r = { ...SET, state: 'outside', hits: 3, lastHit: new Date(2026, 0, 1, 14, 2).getTime() } as never;
    expect(limitsLine(r, 'studio')).toBe('this fleet may use 11 of 12 cores and 92.8 GB of 93.8 GB on studio, but the fleet\'s terminals run outside its unit, on a tmux Svall did not bring, until every robot there is closed and the daemon restarts; it reached its memory limit 3 times, last 14:02');
    const cleared = { ...LIMITS, hits: 1, lastHit: new Date(2026, 0, 1, 14, 2).getTime() } as never;
    expect(limitsLine(cleared, 'studio')).toBe('studio has 12 cores and 93.8 GB, and this fleet may use all of it; it reached its memory limit once, last 14:02');
  });
});
