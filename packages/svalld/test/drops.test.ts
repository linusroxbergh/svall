import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DROP_MAX, DROP_PART, type Response } from '@svall/protocol';
import { dispatch, type Ctx } from '../src/api/methods.js';
import { Drops, dropCalls, dropFolder, dropName, landHere } from '../src/drops.js';
import { sha256Hex } from '../src/hash.js';
import { inCallerNames } from '../src/machine.js';
import { resolvePaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import { makeHome } from './helpers.js';
import { H, W, island, placed, robot, stopWorlds, world } from './placement/world.js';

afterEach(async () => {
  vi.useRealTimers();
  await stopWorlds();
});

const uid = process.getuid!();
const mode = (f: string): number => fs.statSync(f).mode & 0o777;
const DAY = 86_400_000;

// sends `data` to `ctx` as one drop's parts, then lands it on robot `id` as `name`
async function drop(ctx: Ctx, id: string, name: string, data: Buffer): Promise<Response> {
  const upload = crypto.randomBytes(16).toString('hex');
  for (let index = 0; index === 0 || index * DROP_PART < data.length; index++) {
    const part = data.subarray(index * DROP_PART, (index + 1) * DROP_PART).toString('base64');
    const r = await dispatch({ id: 1, method: 'drop.part', params: { upload, index, data: part } }, ctx);
    if ('error' in r) return r;
  }
  return dispatch({ id: 2, method: 'robot.drop', params: { id, upload, name } }, ctx);
}

const landed = (r: Response): string => {
  if ('error' in r) throw new Error(r.error.message);
  return (r.result as { path: string }).path;
};

describe('a drop name', () => {
  it('is the last path component, without control or format characters', () => {
    expect(dropName('../../etc/passwd')).toBe('passwd');
    expect(dropName('a\x1b[31mb‮c​.png\n')).toBe('a[31mbc.png');
    expect(dropName('Screenshot 2026-11-03 at 10.41.22 AM.png')).toBe('Screenshot 2026-11-03 at 10.41.22 AM.png');
    for (const raw of ['..', '.', 'dir/', ' \t', '‮']) expect(dropName(raw)).toBe('file');
  });

  it('holds at most 255 bytes, its extension kept', () => {
    const name = dropName(`${'é'.repeat(300)}.png`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(name).toMatch(/^é+\.png$/);
  });
});

describe('the drop folder', () => {
  it('is this user\'s own at 0700, a new one per drop, and a drop in it is theirs alone and never overwritten', async () => {
    const tmp = makeHome();
    const src = path.join(tmp, 'src');
    fs.writeFileSync(src, 'one');
    const a = await landHere(src, 'shot.png', { machine: () => 'w1', folder: { tmp } });
    const b = await landHere(src, 'shot.png', { machine: () => 'w1', folder: { tmp } });
    const root = path.join(tmp, `svall-drop-${uid}`);
    expect(a).not.toBe(b);
    for (const f of [a, b]) {
      expect(path.basename(f)).toBe('shot.png');
      expect(path.dirname(path.dirname(f))).toBe(root);
      expect(mode(path.dirname(f))).toBe(0o700);
      expect(mode(f)).toBe(0o600);
      expect(fs.readFileSync(f, 'utf8')).toBe('one');
    }
    expect(mode(root)).toBe(0o700);
  });

  it('takes one of this user\'s made open to others back to 0700', () => {
    const tmp = makeHome();
    const root = path.join(tmp, `svall-drop-${uid}`);
    fs.mkdirSync(root);
    fs.chmodSync(root, 0o755);
    dropFolder({ tmp });
    expect(mode(root)).toBe(0o700);
  });

  it('refuses a link at its path, and makes nothing where the link points', () => {
    const tmp = makeHome();
    const elsewhere = makeHome();
    fs.symlinkSync(elsewhere, path.join(tmp, `svall-drop-${uid}`));
    expect(() => dropFolder({ tmp })).toThrow(`${path.join(tmp, `svall-drop-${uid}`)} is not a folder; nothing is dropped there`);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses one another user owns', () => {
    const tmp = makeHome();
    // this user's folder, under the name of another uid's
    fs.mkdirSync(path.join(tmp, `svall-drop-${uid + 1}`), { mode: 0o700 });
    expect(() => dropFolder({ tmp, uid: uid + 1 })).toThrow('belongs to another user; nothing is dropped there');
  });

  it('removes the drops older than a week as the next one lands', () => {
    const tmp = makeHome();
    const now = Date.now();
    const old = dropFolder({ tmp });
    const recent = dropFolder({ tmp });
    fs.utimesSync(old, new Date(now - 8 * DAY), new Date(now - 8 * DAY));
    fs.utimesSync(recent, new Date(now - 6 * DAY), new Date(now - 6 * DAY));
    dropFolder({ tmp, now });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });
});

describe('a drop through the API', () => {
  it('lands on this machine for a robot that runs here, and keeps nothing staged', async () => {
    const w = world({ home: { robots: { c_1: robot({ id: 'c_1' }) } } });
    const data = crypto.randomBytes(DROP_PART + 10);
    const at = landed(await drop(w.home.ctx, 'c_1', 'Screen shot.png', data));
    expect(at.startsWith(path.join(w.tmp.home, `svall-drop-${uid}/`))).toBe(true);
    expect(path.basename(at)).toBe('Screen shot.png');
    expect(fs.readFileSync(at).equals(data)).toBe(true);
    expect(fs.readdirSync(path.join(w.home.paths.cache, 'drops'))).toEqual([]);
  });

  it('lands on the worker a robot runs on, over the link, and nothing on the home', async () => {
    const w = world({ home: { robots: { c_1: placed({ id: 'c_1' }) } }, worker: { robots: { c_1: placed({ id: 'c_1' }) } } });
    await w.link();
    const data = crypto.randomBytes(2 * DROP_PART + 7);
    const at = landed(await drop(w.home.ctx, 'c_1', '../notes.log', data));
    expect(path.dirname(path.dirname(at))).toBe(path.join(w.tmp.worker, `svall-drop-${uid}`));
    expect(path.basename(at)).toBe('notes.log');
    expect(fs.readFileSync(at).equals(data)).toBe(true);
    expect(mode(at)).toBe(0o600);
    expect(fs.readdirSync(w.tmp.home)).toEqual([]);
  });

  it('refuses a robot on a worker the home cannot reach, in the app\'s words, and keeps nothing staged', async () => {
    const w = world({ home: { machines: { [W]: { name: 'w1', reachable: false, since: 1 } }, robots: { c_1: placed({ id: 'c_1' }) } } });
    const r = await drop(w.home.ctx, 'c_1', 'a.png', Buffer.from('x'));
    expect(r).toMatchObject({ error: { code: 'not_reachable', message: 'w1 is not reachable' } });
    expect(fs.readdirSync(path.join(w.home.paths.cache, 'drops'))).toEqual([]);
  });

  it('on a worker, lands a drop for its own robots alone', async () => {
    const w = world({ worker: { machines: { [H]: { name: 'mac', reachable: true, since: 1 } }, robots: { c_1: placed({ id: 'c_1' }), c_2: robot({ id: 'c_2' }) } } });
    expect(landed(await drop(w.worker.ctx, 'c_1', 'a.txt', Buffer.from('here'))).startsWith(w.tmp.worker)).toBe(true);
    expect(await drop(w.worker.ctx, 'c_2', 'a.txt', Buffer.from('there'))).toMatchObject({ error: { code: 'not_reachable', message: 'mac is not reachable' } });
  });

  it('refuses a robot that is moving, in the app\'s words, and a phone', async () => {
    const w = world({ home: { machines: { [W]: { name: 'w1', reachable: true, since: 1 } }, robots: { c_1: robot({ id: 'c_1' }) } } });
    w.home.store.update((d) => { d.robots.c_1.moving = { id: 'mv_0123456789', to: W, phase: 'prepare' } as never; });
    expect(await drop(w.home.ctx, 'c_1', 'a.png', Buffer.from('x'))).toMatchObject({ error: { code: 'moving', message: 'moving to w1' } });
    // asked from a window on the machine it moves to, as is its terminal
    expect(await inCallerNames({ me: W }, () => drop(w.home.ctx, 'c_1', 'a.png', Buffer.from('x')))).toMatchObject({ error: { code: 'moving', message: 'moving to this Mac' } });
    await expect(inCallerNames({ me: W }, async () => w.home.fleet.live('c_1'))).rejects.toThrow('moving to this Mac');
    const phone = { ...w.home.ctx, viewer: { ...w.home.ctx.viewer, kind: 'phone' as const } };
    const upload = crypto.randomBytes(16).toString('hex');
    expect(await dispatch({ id: 1, method: 'drop.part', params: { upload, index: 0, data: '' } }, phone)).toMatchObject({ error: { code: 'forbidden' } });
    expect(await dispatch({ id: 1, method: 'robot.drop', params: { id: 'c_1', upload, name: 'a.png' } }, phone)).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('refuses in words a drop past the disk\'s room here, and leaves no folder', async () => {
    const w = world({ home: { robots: { c_1: robot({ id: 'c_1' }) } } });
    const room = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0, bsize: 4096 } as fs.StatsFs);
    const r = await drop(w.home.ctx, 'c_1', 'a.png', Buffer.from('x'));
    room.mockRestore();
    expect(r).toMatchObject({ error: { code: 'too_large', message: 'mac has no room in /tmp for a.png' } });
    expect(fs.readdirSync(path.join(w.tmp.home, `svall-drop-${uid}`))).toEqual([]);
  });

  it('lets go of a drop no part has reached for a minute', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world({ home: { robots: { c_1: robot({ id: 'c_1' }) } } });
    const drops = w.home.ctx.drops!;
    const upload = crypto.randomBytes(16).toString('hex');
    drops.part(upload, 0, Buffer.from('x'));
    vi.advanceTimersByTime(59_000);
    drops.part(upload, 1, Buffer.from('y'));
    vi.advanceTimersByTime(59_000);
    expect(fs.readdirSync(path.join(w.home.paths.cache, 'drops'))).toEqual([upload]);
    vi.advanceTimersByTime(1_000);
    expect(fs.readdirSync(path.join(w.home.paths.cache, 'drops'))).toEqual([]);
    await expect(drops.land('c_1', upload, 'x')).rejects.toThrow(`no drop ${upload} is under way`);
  });

  it('refuses a part out of order, a part of a drop never begun, and what no part says is base64', async () => {
    const w = world({ home: { robots: { c_1: robot({ id: 'c_1' }) } } });
    const upload = crypto.randomBytes(16).toString('hex');
    const part = (index: number, data = 'eA==') => dispatch({ id: 1, method: 'drop.part', params: { upload, index, data } }, w.home.ctx);
    expect(await part(1)).toMatchObject({ error: { code: 'not_found' } });
    expect(await part(0)).toEqual({ id: 1, result: {} });
    expect(await part(2)).toMatchObject({ error: { code: 'invalid_params', message: `part 2 of drop ${upload} arrived where part 1 was due` } });
    expect(await dispatch({ id: 2, method: 'robot.drop', params: { id: 'c_1', upload, name: 'x' } }, w.home.ctx)).toMatchObject({ error: { code: 'not_found' } });
    expect(await part(0, 'not base64!')).toMatchObject({ error: { code: 'invalid_params' } });
  });

  it('refuses past 100 MB', async () => {
    const w = world({ home: { robots: { c_1: robot({ id: 'c_1' }) } } });
    const drops = w.home.ctx.drops!;
    const upload = crypto.randomBytes(16).toString('hex');
    const mib = Buffer.alloc(DROP_PART);
    for (let i = 0; i < DROP_MAX / DROP_PART; i++) drops.part(upload, i, mib);
    expect(() => drops.part(upload, DROP_MAX / DROP_PART, Buffer.from('x'))).toThrow('a drop carries at most 100 MB');
    expect(fs.readdirSync(path.join(w.home.paths.cache, 'drops'))).toEqual([]);
  });

  it('lets go of a drop whose socket closes', async () => {
    const w = world({ home: { robots: { c_1: robot({ id: 'c_1' }) } } });
    const ac = new AbortController();
    const upload = crypto.randomBytes(16).toString('hex');
    w.home.ctx.drops!.part(upload, 0, Buffer.from('x'), ac.signal);
    ac.abort();
    expect(fs.readdirSync(path.join(w.home.paths.cache, 'drops'))).toEqual([]);
    await expect(w.home.ctx.drops!.land('c_1', upload, 'x')).rejects.toThrow(`no drop ${upload} is under way`);
  });
});

describe('a drop the home sends a worker', () => {
  const blob = (receive: (into: string) => Promise<{ sha256: string }>) => {
    const tmp = makeHome();
    return { tmp, ...dropCalls({ connection: { receiveBlob: (_id, into) => receive(into) }, machine: () => 'w1', folder: { tmp } }) };
  };
  const folders = (tmp: string) => fs.readdirSync(path.join(tmp, `svall-drop-${uid}`));
  const offer = { id: 'd1', sha256: sha256Hex('x'), bytes: 1, name: 'a.txt' };

  it('is refused and removed when it does not arrive as it left', async () => {
    const { tmp, calls } = blob(async (into) => { fs.writeFileSync(into, 'other'); return { sha256: sha256Hex('other') }; });
    await calls['drop.blob']({ ...offer, sha256: sha256Hex('meant') });
    await expect(calls['drop.land']({ id: 'd1' })).rejects.toThrow('a.txt did not arrive as it left');
    expect(folders(tmp)).toEqual([]);
  });

  it('leaves nothing behind when the link closes before it has all come', async () => {
    let fail!: (e: Error) => void;
    const { tmp, calls } = blob(() => new Promise((_resolve, reject) => { fail = reject; }));
    await calls['drop.blob'](offer);
    expect(folders(tmp)).toHaveLength(1);
    fail(new Error('the link is closed'));
    await vi.waitFor(() => expect(folders(tmp)).toEqual([]));
    await expect(calls['drop.land']({ id: 'd1' })).rejects.toThrow('no drop d1 came here');
  });

  it('leaves nothing behind when the link is lost after it has all come', async () => {
    const { tmp, calls, linkLost } = blob(async () => ({ sha256: sha256Hex('x') }));
    await calls['drop.blob'](offer);
    linkLost();
    expect(folders(tmp)).toEqual([]);
    await expect(calls['drop.land']({ id: 'd1' })).rejects.toThrow('no drop d1 came here');
  });

  it('leaves nothing behind when the home never says what becomes of it, and a landing stops that clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { tmp, calls } = blob(async () => ({ sha256: sha256Hex('x') }));
    await calls['drop.blob'](offer);
    await calls['drop.blob']({ ...offer, id: 'd2' });
    const { path: kept } = await calls['drop.land']({ id: 'd2' }) as { path: string };
    vi.advanceTimersByTime(15 * 60_000);
    expect(folders(tmp)).toEqual([path.basename(path.dirname(kept))]);
  });

  it('refuses in words what would not fit, which would otherwise close the link as the write failed', async () => {
    const { tmp, calls } = blob(async () => ({ sha256: sha256Hex('x') }));
    await expect(calls['drop.blob']({ ...offer, bytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow('w1 has no room in /tmp for a.txt');
    expect(folders(tmp)).toEqual([]);
  });

  // a home whose link is this worker's calls, with `sent` standing in for the blob crossing it
  function linked(sent: () => void) {
    const tmp = makeHome();
    const { calls } = dropCalls({ connection: { receiveBlob: async () => ({ sha256: sha256Hex('x') }) }, machine: () => 'w1', folder: { tmp } });
    const link = {
      call: (method: string, params: unknown) => calls[method](params),
      sendBlob: async () => sent(),
    };
    const home = makeHome();
    const store = Store.load(resolvePaths(home).state, () => {});
    store.update((d) => { d.islands.i_1 = island; d.robots.c_1 = placed({ id: 'c_1' }); });
    const drops = new Drops({
      dir: path.join(home, 'drops'), store, router: { runsHere: () => false, placedAt: () => W }, links: { for: () => link as never }, machine: () => 'mac',
    });
    const upload = crypto.randomBytes(16).toString('hex');
    drops.part(upload, 0, Buffer.from('x'));
    return { tmp, drops, upload };
  }

  it('is removed when the page that sent it leaves while it crosses, as no one is left to type its path', async () => {
    const ac = new AbortController();
    const { tmp, drops, upload } = linked(() => ac.abort());
    await expect(drops.land('c_1', upload, 'a.txt', ac.signal)).rejects.toThrow('the page that sent this drop is gone');
    expect(folders(tmp)).toEqual([]);
  });

  it('lands once it has crossed, for the page still there', async () => {
    const { tmp, drops, upload } = linked(() => {});
    const { path: at } = await drops.land('c_1', upload, 'a.txt', new AbortController().signal);
    expect(folders(tmp)).toEqual([path.basename(path.dirname(at))]);
  });
});
