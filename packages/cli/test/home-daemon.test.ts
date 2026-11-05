import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ exec: [] as string[][], kick: [] as string[][], stop: [] as string[], serve: [] as { fleet: string; home: string }[], answers: [] as unknown[], connects: [] as string[] }));
vi.mock('node:child_process', async (actual) => ({ ...(await actual<object>()), execFile: (file: string, args: string[], cb: (e: null, o: { stdout: string; stderr: string }) => void) => { calls.exec.push([file, ...args]); cb(null, { stdout: '', stderr: '' }); } }));
vi.mock('@svall/svalld/launchd', async (actual) => ({ ...(await actual<object>()), kickstart: (labels: string[]) => { calls.kick.push(labels); return Promise.resolve([]); } }));
vi.mock('@svall/svalld/linux/service', async (actual) => ({ ...(await actual<object>()), stopUnit: (_run: unknown, unit: string) => { calls.stop.push(unit); return Promise.resolve(); } }));
vi.mock('@svall/svalld/linux/setup', async (actual) => ({ ...(await actual<object>()), serveAsWorker: (o: { fleet: string; home: string }) => { calls.serve.push({ fleet: o.fleet, home: o.home }); return Promise.resolve([]); } }));
vi.mock('../src/client.js', async (actual) => {
  const real = await actual<typeof import('../src/client.js')>();
  return { ...real, Client: { connect: (home: string) => { calls.connects.push(home); const next = calls.answers.shift(); return next instanceof Error ? Promise.reject(next) : Promise.resolve({ call: () => Promise.resolve(next), close: () => {} }); } } };
});

const { realHomeDaemon } = await import('../src/controller/home.js');

const FLEET = '11111111-2222-3333-4444-555555555555';
const target = { name: 'joined', home: '/tmp/never/.svall-joined', managed: true };
const platform = process.platform;
const on = (p: string) => Object.defineProperty(process, 'platform', { value: p });

beforeEach(() => { calls.exec = []; calls.kick = []; calls.stop = []; calls.serve = []; calls.answers = []; calls.connects = []; });
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); });

describe('a move\'s hold on a fleet\'s daemon', () => {
  it('on Linux stops its unit, and starts it again written to what the fleet home holds', async () => {
    on('linux');
    const d = realHomeDaemon(target);
    await d.stop();
    await d.start();
    expect(calls.stop).toEqual(['svall-svalld@joined.service']);
    expect(calls.serve).toEqual([{ fleet: 'joined', home: target.home }]);
    expect(calls.exec).toEqual([]);
    expect(calls.kick).toEqual([]);
  });

  it('on a Mac signals its launchd job, and kicks it to start', async () => {
    on('darwin');
    const d = realHomeDaemon(target);
    await d.stop();
    await d.start();
    expect(calls.exec).toEqual([['launchctl', 'kill', 'SIGTERM', expect.stringMatching(/^gui\/\d+\/.*joined/)]]);
    expect(calls.kick).toEqual([[expect.stringMatching(/joined/)]]);
    expect(calls.stop).toEqual([]);
  });

  it('answers home only for the daemon that says it is, of this fleet', async () => {
    calls.answers = [new Error('svalld is not running'), { mine: false, fleetId: FLEET }, { mine: true, fleetId: 'another' }, { mine: true, fleetId: FLEET }];
    expect(await realHomeDaemon(target).answersHome(FLEET)).toBe(true);
    expect(calls.connects).toHaveLength(4);
    expect(new Set(calls.connects)).toEqual(new Set([target.home]));
  }, 30_000);

  it('gives up with no such answer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    try {
      const pending = realHomeDaemon(target).answersHome(FLEET);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await pending).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
