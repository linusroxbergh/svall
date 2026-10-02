import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MobileStatus } from '@svall/protocol';
import { MOBILE_DIST } from '../src/api/bundle.js';
import { fleetTarget, freePort, mobileControl, phoneKey, phoneUrl, resolveTailscale, serve, servePort, servesOther, servesTarget, tailnetSelf, unserve, watchServed, type MobileDeps } from '../src/mobile.js';
import { Phones } from '../src/phones.js';
import { cleanHomes, makeHome } from './helpers.js';

type Call = { cmd: string; args: string[] };

const HOME = '/tmp/svall-home';
const TARGET = 'http://127.0.0.1:47812/abcdef';
// what `tailscale serve status --json` says of the https ports in `web` and the proxy behind each, and of plain tcp forwards
const mappings = (web: Record<number, string>, tcp: number[] = []) => JSON.stringify({
  TCP: Object.fromEntries([...Object.keys(web).map((p) => [p, { HTTPS: true }]), ...tcp.map((p) => [p, { TCPForward: '127.0.0.1:22' }])]),
  Web: Object.fromEntries(Object.entries(web).map(([p, proxy]) => [`mac.tailnet.ts.net:${p}`, { Handlers: { '/': { Proxy: proxy } } }])),
});
const mapping = (proxy: string) => mappings({ 8443: proxy });
// what `tailscale status --json` says of a Mac signed in as owner@example.com
const SIGNED_IN = {
  BackendState: 'Running',
  Self: { DNSName: 'mac.tailnet.ts.net.', UserID: 7 },
  User: { 3: { ID: 3, LoginName: 'peer@example.com' }, 7: { ID: 7, LoginName: 'owner@example.com' } },
};
const TAGGED = { ...SIGNED_IN, Self: { ...SIGNED_IN.Self, UserID: 9, Tags: ['tag:server'] }, User: { 9: { ID: 9, LoginName: 'tagged-devices' } } };

// `served` is what 8443 proxies to, `web` what any port does, `tcp` the ports a plain tcp forward holds
function deps(opts: { served?: string; web?: Record<number, string>; tcp?: number[]; files?: Record<string, string>; status?: object } = {}): MobileDeps & { calls: Call[]; web: Record<number, string> } {
  const files = opts.files ?? { [path.join(HOME, 'port')]: '47812\n', [path.join(HOME, 'mobile-key')]: 'abcdef\n', [MOBILE_DIST]: 'built' };
  const calls: Call[] = [];
  const web: Record<number, string> = { ...opts.web };
  if (opts.served) web[8443] = opts.served;
  const portOf = (args: string[]) => Number(args.find((a) => a.startsWith('--https='))!.slice('--https='.length));
  return {
    calls,
    web,
    run: (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd !== 'tailscale' && cmd !== 'pnpm') return Promise.reject(new Error(`no ${cmd}`));
      if (args[0] === 'serve' && args[1] === 'status') return Promise.resolve(Object.keys(web).length || opts.tcp ? mappings(web, opts.tcp) : '{}');
      if (args[0] === 'serve' && args.includes('--bg')) { web[portOf(args)] = args[args.length - 1]; return Promise.resolve(''); }
      if (args[0] === 'serve') { delete web[portOf(args)]; return Promise.resolve(''); }
      if (args[0] === 'status') return Promise.resolve(JSON.stringify(opts.status ?? SIGNED_IN));
      return Promise.resolve('1.80.0');
    },
    exists: (f) => f in files,
    read: (f) => files[f],
  };
}

// no other fleet keeps a port, and every save works
const NONE = { kept: () => [], savePort: () => true };
const control = (d: MobileDeps, phones = new Phones()) =>
  mobileControl(d, { ...NONE, home: HOME, profile: 'work', logins: ['me@example.com'], phones, rotateKey: () => {} });

describe('resolveTailscale', () => {
  const onlyAt = (bins: string[]): MobileDeps => ({
    run: (cmd) => (bins.includes(cmd) ? Promise.resolve('1.80.0') : Promise.reject(new Error(`no ${cmd}`))),
    exists: () => true,
    read: () => undefined,
  });

  it('falls through to the CLI inside the GUI app when PATH has none', async () => {
    const inBundle = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    await expect(resolveTailscale(onlyAt([inBundle]))).resolves.toBe(inBundle);
    await expect(resolveTailscale(onlyAt([]))).rejects.toThrow('tailscale not found');
  });
});

describe('tailnetSelf', () => {
  it('names the backend that is not running rather than the name it lacks', async () => {
    const stopped: MobileDeps = { run: () => Promise.resolve(JSON.stringify({ BackendState: 'Stopped' })), exists: () => true, read: () => undefined };
    await expect(tailnetSelf(stopped, 'tailscale')).rejects.toThrow('tailscale is not connected (Stopped); sign in and try again');
  });

  it('names the login this Mac is signed in as, and none for a tagged Mac', async () => {
    await expect(tailnetSelf(deps(), 'tailscale')).resolves.toEqual({ host: 'mac.tailnet.ts.net', owner: 'owner@example.com' });
    await expect(tailnetSelf(deps({ status: TAGGED }), 'tailscale')).resolves.toEqual({ host: 'mac.tailnet.ts.net', owner: undefined });
  });
});

describe('serve and unserve', () => {
  const quiet = (calls: Call[]): MobileDeps => ({
    run: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve(''); },
    exists: () => true,
    read: () => undefined,
  });

  it('puts the fleet behind the port, and takes down only that mapping', async () => {
    const calls: Call[] = [];
    await serve(quiet(calls), 'tailscale', TARGET, 8443);
    await unserve(quiet(calls), 'tailscale', 8443);
    expect(calls.map((c) => c.args)).toEqual([
      ['serve', '--bg', '--yes', '--https=8443', TARGET],
      ['serve', '--https=8443', 'off'],
    ]);
  });

  it('takes a handler that is already gone for the state it was asked for', async () => {
    const absent: MobileDeps = { run: () => Promise.reject(new Error('handler does not exist')), exists: () => true, read: () => undefined };
    await expect(unserve(absent, 'tailscale', 8443)).resolves.toBe('');
    const down: MobileDeps = { ...absent, run: () => Promise.reject(new Error('tailscaled is not running')) };
    await expect(unserve(down, 'tailscale', 8443)).rejects.toThrow('tailscaled is not running');
  });
});

describe('the link the phone opens', () => {
  it('gives the private fleet the port a browser assumes, and leaves it out of the url', () => {
    expect(servePort('private')).toBe(443);
    expect(servePort('lab')).toBe(8443);
    expect(servePort('lab', 10000)).toBe(10000);
    expect(phoneUrl('mac.tailnet.ts.net', 443)).toBe('https://mac.tailnet.ts.net/');
    expect(phoneUrl('mac.tailnet.ts.net', 8443)).toBe('https://mac.tailnet.ts.net:8443/');
  });
});

describe('freePort', () => {
  it('takes the first port from 8443 up that nothing serves and no other fleet keeps', () => {
    expect(freePort('{}', [])).toBe(8443);
    expect(freePort(mapping(TARGET), [])).toBe(8444);
    // a plain tcp forward shows only under TCP, and a foreground serve only under its session
    expect(freePort(JSON.stringify({ TCP: { 8443: {}, 8445: {} } }), [8444])).toBe(8446);
    expect(freePort(JSON.stringify({ Foreground: { s1: { TCP: { 8443: {} } } } }), [])).toBe(8444);
  });
});

describe('fleetTarget', () => {
  it('names what is missing when the daemon left no port or no key', () => {
    expect(fleetTarget(deps(), HOME)).toBe(TARGET);
    const noPort = deps({ files: { [path.join(HOME, 'mobile-key')]: 'abcdef' } });
    expect(() => fleetTarget(noPort, HOME)).toThrow('the fleet is not running');
    const noKey = deps({ files: { [path.join(HOME, 'port')]: '47812' } });
    expect(() => fleetTarget(noKey, HOME)).toThrow('restart the daemon so it writes one');
  });
});

describe('servesTarget', () => {
  it('counts only the mapping this fleet put on the port', () => {
    expect(servesTarget(mapping(TARGET), 'mac.tailnet.ts.net', 8443, TARGET)).toBe(true);
    // a second fleet took the port first: the phone would reach that one, not this
    expect(servesTarget(mapping('http://127.0.0.1:99999/other'), 'mac.tailnet.ts.net', 8443, TARGET)).toBe(false);
    expect(servesTarget('{}', 'mac.tailnet.ts.net', 8443, TARGET)).toBe(false);
  });
});

describe('servesOther', () => {
  it('tells this fleet\'s mapping, on whatever daemon port, from anything else on the port', () => {
    expect(servesOther(mapping('http://127.0.0.1:50001/abcdef'), 'mac.tailnet.ts.net', 8443, 'abcdef')).toBe(false);
    expect(servesOther('{}', 'mac.tailnet.ts.net', 8443, 'abcdef')).toBe(false);
    expect(servesOther(mapping('http://127.0.0.1:47900/other'), 'mac.tailnet.ts.net', 8443, 'abcdef')).toBe(true);
    expect(servesOther(mapping('http://127.0.0.1:47812/old'), 'mac.tailnet.ts.net', 8443, 'abcdef', 'http://127.0.0.1:47812/')).toBe(false);
    expect(servesOther(mapping('http://127.0.0.1:47900/other'), 'mac.tailnet.ts.net', 8443, 'abcdef', 'http://127.0.0.1:47812/')).toBe(true);
    const text = JSON.stringify({ Web: { 'mac.tailnet.ts.net:8443': { Handlers: { '/': { Text: 'hi' } } } } });
    expect(servesOther(text, 'mac.tailnet.ts.net', 8443, 'abcdef')).toBe(true);
    expect(servesOther(mappings({}, [8443]), 'mac.tailnet.ts.net', 8443, 'abcdef')).toBe(true);
    expect(servesOther(JSON.stringify({ Foreground: { s1: { TCP: { 8443: {} } } } }), 'mac.tailnet.ts.net', 8443, 'abcdef')).toBe(true);
  });
});

describe('mobileControl', () => {
  it('reports the link and the port this fleet answers on', async () => {
    const status = await control(deps({ served: TARGET })).get();
    expect(status).toMatchObject({ serving: true, url: 'https://mac.tailnet.ts.net:8443/', port: 8443, logins: ['me@example.com'] });
    expect(status.qr).toMatch(/^data:image\/png;base64,/);
  });

  it('lets in the logins the config names, over the Mac\'s own', async () => {
    const control_ = control(deps());
    expect((await control_.get()).logins).toEqual(['me@example.com']);
    expect(control_.logins()).toEqual(['me@example.com']);
  });

  it('lets in no one with an empty config until tailscale names the Mac\'s login, then only that one, and keeps it through a failed look', async () => {
    const d = deps();
    const control_ = mobileControl(d, { ...NONE, home: HOME, profile: 'work', logins: [], phones: new Phones(), rotateKey: () => {} });
    expect(control_.logins()).toEqual([]);
    expect((await control_.get()).logins).toEqual(['owner@example.com']);
    expect(control_.logins()).toEqual(['owner@example.com']);
    d.run = () => Promise.reject(new Error('tailscaled is wedged'));
    expect(await control_.get()).toMatchObject({ error: expect.any(String), logins: ['owner@example.com'] });
    expect(control_.logins()).toEqual(['owner@example.com']);
  });

  it('will not serve a tagged Mac whose config names no login, and leaves the key alone', async () => {
    const d = deps({ status: TAGGED });
    let made = 0;
    const control_ = mobileControl(d, { ...NONE, home: HOME, profile: 'work', logins: [], phones: new Phones(), rotateKey: () => { made++; } });
    const status = await control_.set(true);
    expect(status).toMatchObject({ serving: false, logins: [], error: expect.stringContaining('set mobile.logins in config.json') });
    expect(d.calls.some((c) => c.args.includes('--bg'))).toBe(false);
    expect(made).toBe(0);
    expect(control_.logins()).toEqual([]);
    expect((await control(deps({ status: TAGGED })).set(true)).serving).toBe(true);
  });

  it('names the phones on the page, whether or not the link can be read', async () => {
    const phones = new Phones();
    phones.add('me@example.com');
    expect((await control(deps({ served: TARGET }), phones).get()).phones)
      .toEqual([{ login: 'me@example.com', since: expect.any(Number) }]);
    const broken: MobileDeps = { run: () => Promise.reject(new Error('nope')), exists: () => true, read: () => undefined };
    expect((await control(broken, phones).get()).phones).toHaveLength(1);
  });

  it('calls out a serve mapping standing over a checkout with no phone page', async () => {
    const files = { [path.join(HOME, 'port')]: '47812', [path.join(HOME, 'mobile-key')]: 'abcdef' };
    expect((await control(deps({ served: TARGET, files })).get()).pageMissing).toBe(true);
    // nothing is served, so there is nothing for a missing page to disappoint
    expect((await control(deps({ files })).get()).pageMissing).toBeUndefined();
    expect((await control(deps({ served: TARGET })).get()).pageMissing).toBeUndefined();
  });

  it('serves and stops on demand', async () => {
    const control_ = control(deps());
    expect((await control_.get()).serving).toBe(false);
    expect((await control_.set(true)).serving).toBe(true);
    expect((await control_.set(false)).serving).toBe(false);
  });

  it('gives a named fleet that keeps no port the first free one, past other fleets\' kept ports, and keeps it there', async () => {
    const theirs = 'http://127.0.0.1:47900/theirs';
    const site = 'http://127.0.0.1:5199';
    const d = deps({ web: { 8443: theirs, 8444: site } });
    const saved: number[] = [];
    const control_ = mobileControl(d, { home: HOME, profile: 'work', logins: ['me@example.com'], phones: new Phones(), rotateKey: () => {}, kept: () => [8445], savePort: (p) => saved.push(p) > 0 });
    expect(await control_.set(true)).toMatchObject({ serving: true, port: 8446, url: 'https://mac.tailnet.ts.net:8446/' });
    expect(d.web).toEqual({ 8443: theirs, 8444: site, 8446: TARGET });
    expect(await control_.set(false)).toMatchObject({ serving: false, port: 8446 });
    expect(d.web).toEqual({ 8443: theirs, 8444: site });
    delete d.web[8443];
    expect(await control_.set(true)).toMatchObject({ serving: true, port: 8446 });
    expect(saved).toEqual([8446]);
  });

  it('passes over a port another fleet keeps while its link is off, and one a plain tcp forward holds', async () => {
    const kept = mobileControl(deps(), { home: HOME, profile: 'work', logins: ['me@example.com'], phones: new Phones(), rotateKey: () => {}, kept: () => [8443], savePort: () => true });
    expect(await kept.set(true)).toMatchObject({ serving: true, port: 8444 });
    expect(await control(deps({ tcp: [8443] })).set(true)).toMatchObject({ serving: true, port: 8444 });
  });

  it('refuses an on where something else holds a port the fleet keeps, or the private fleet\'s, and leaves the key alone', async () => {
    const theirs = 'http://127.0.0.1:47900/theirs';
    for (const o of [{ profile: 'work', httpsPort: 8443 }, { profile: 'private' }]) {
      const d = deps({ web: { 8443: theirs, 443: theirs } });
      let made = 0;
      const control_ = mobileControl(d, { ...NONE, home: HOME, logins: ['me@example.com'], phones: new Phones(), rotateKey: () => { made++; }, ...o });
      expect((await control_.set(true)).error).toMatch(/^https port (8443|443) already serves another fleet or site/);
      expect(d.calls.some((c) => c.args.includes('--bg'))).toBe(false);
      expect(made).toBe(0);
    }
  });

  it('moves to a free port only once it is served there, so a failed on starts over from its own port', async () => {
    const d = deps({ served: 'http://127.0.0.1:47900/theirs' });
    const control_ = control(d);
    const run = d.run;
    d.run = (cmd, args, cwd) => (args.includes('--bg') ? Promise.reject(new Error('serve failed')) : run(cmd, args, cwd));
    expect(await control_.set(true)).toMatchObject({ port: 8443, error: expect.stringMatching(/serve failed/) });
    d.run = run;
    delete d.web[8443];
    expect(await control_.set(true)).toMatchObject({ serving: true, port: 8443 });
  });

  it('takes nothing down on an off while another fleet serves its port', async () => {
    const d = deps({ served: 'http://127.0.0.1:47900/theirs' });
    let made = 0;
    const control_ = mobileControl(d, { ...NONE, home: HOME, profile: 'work', logins: ['me@example.com'], phones: new Phones(), rotateKey: () => { made++; } });
    expect(await control_.set(false)).toMatchObject({ serving: false });
    expect(d.calls.some((c) => c.args.includes('--bg') || c.args.includes('off'))).toBe(false);
    expect((await control_.get()).serving).toBe(false);
    expect(made).toBe(1);
  });

  it('keeps the port it is served on for the next start, once, and none while not served', async () => {
    const saved: number[] = [];
    const opts = { ...NONE, home: HOME, profile: 'work', logins: ['me@example.com'], phones: new Phones(), rotateKey: () => {}, savePort: (p: number) => saved.push(p) > 0 };
    await mobileControl(deps(), opts).get();
    expect(saved).toEqual([]);
    const control_ = mobileControl(deps({ served: TARGET }), opts);
    await control_.get();
    await control_.get();
    expect(saved).toEqual([8443]);
    await mobileControl(deps({ served: TARGET }), { ...opts, httpsPort: 8443 }).get();
    expect(saved).toEqual([8443]);
  });

  it('tries the save again on the next look when it failed', async () => {
    const tries: number[] = [];
    const control_ = mobileControl(deps({ served: TARGET }), { ...NONE, home: HOME, profile: 'work', logins: ['me@example.com'], phones: new Phones(), rotateKey: () => {}, savePort: (p) => tries.push(p) > 1 });
    await control_.get();
    await control_.get();
    await control_.get();
    expect(tries).toEqual([8443, 8443]);
  });

  it('moves its link to the port the daemon started on this time, and leaves another fleet\'s alone', async () => {
    const d = deps({ served: 'http://127.0.0.1:51000/abcdef' });
    expect((await control(d).get()).serving).toBe(true);
    expect(d.calls.find((c) => c.args.includes('--bg'))!.args.at(-1)).toBe(TARGET);
    const theirs = deps({ served: 'http://127.0.0.1:51000/theirs' });
    expect((await control(theirs).get()).serving).toBe(false);
    expect(theirs.calls.some((c) => c.args.includes('--bg'))).toBe(false);
  });

  it('serves the fleet behind a fresh key on every on and off, and leaves the key alone on a look', async () => {
    const files = { [path.join(HOME, 'port')]: '47812', [path.join(HOME, 'mobile-key')]: 'abcdef', [MOBILE_DIST]: 'built' };
    const d = deps({ files });
    let made = 0;
    const control_ = mobileControl(d, { ...NONE, home: HOME, profile: 'work', logins: [], phones: new Phones(), rotateKey: () => { files[path.join(HOME, 'mobile-key')] = `key${++made}`; } });
    await control_.get();
    expect(made).toBe(0);
    expect((await control_.set(true)).serving).toBe(true);
    expect(d.calls.find((c) => c.args.includes('--bg'))!.args.at(-1)).toBe('http://127.0.0.1:47812/key1');
    expect((await control_.set(false)).serving).toBe(false);
    expect(made).toBe(2);
  });

  it('still knows its own mapping by the daemon\'s address after a change that failed once the key had turned over', async () => {
    const files: Record<string, string> = { [path.join(HOME, 'port')]: '47812', [path.join(HOME, 'mobile-key')]: 'abcdef', [MOBILE_DIST]: 'built' };
    const d = deps({ files, served: TARGET });
    let made = 0;
    const control_ = mobileControl(d, { ...NONE, home: HOME, profile: 'work', logins: [], phones: new Phones(), rotateKey: () => { files[path.join(HOME, 'mobile-key')] = `key${++made}`; } });
    const run = d.run;
    d.run = (cmd, args, cwd) => (args.at(-1) === 'off' ? Promise.reject(new Error('serve off failed')) : run(cmd, args, cwd));
    expect((await control_.set(false)).error).toMatch(/serve off failed/);
    d.run = run;
    expect((await control_.set(false)).serving).toBe(false);
    expect((await control_.set(true)).serving).toBe(true);
    d.run = (cmd, args, cwd) => (args.includes('--bg') ? Promise.reject(new Error('serve failed')) : run(cmd, args, cwd));
    expect((await control_.set(true)).error).toMatch(/serve failed/);
    d.run = run;
    expect((await control_.set(true)).serving).toBe(true);
    expect(made).toBe(5);
  });

  it('leaves the key a served link carries alone when an on cannot reach tailscale or build the page', async () => {
    const files: Record<string, string> = { [path.join(HOME, 'port')]: '47812', [path.join(HOME, 'mobile-key')]: 'abcdef', [MOBILE_DIST]: 'built' };
    const d = deps({ files });
    let made = 0;
    const control_ = mobileControl(d, { ...NONE, home: HOME, profile: 'work', logins: [], phones: new Phones(), rotateKey: () => { files[path.join(HOME, 'mobile-key')] = `key${++made}`; } });
    await control_.set(true);
    const run = d.run;
    d.run = (cmd, args, cwd) => (args[0] === 'status' ? Promise.resolve(JSON.stringify({ BackendState: 'Stopped' })) : run(cmd, args, cwd));
    expect((await control_.set(true)).error).toMatch(/Stopped/);
    d.run = (cmd, args, cwd) => (cmd === 'pnpm' ? Promise.reject(new Error('build failed')) : run(cmd, args, cwd));
    delete files[MOBILE_DIST];
    expect((await control_.set(true)).error).toMatch(/build failed/);
    files[MOBILE_DIST] = 'built';
    d.run = run;
    expect(made).toBe(1);
    expect((await control_.get()).serving).toBe(true);
  });

  it('remembers the link it last saw served, so a push can ask without running tailscale', async () => {
    const d = deps();
    const control_ = control(d);
    expect(control_.served()).toBeUndefined();
    await control_.set(true);
    const ran = d.calls.length;
    expect(control_.served()).toBe('https://mac.tailnet.ts.net:8443/');
    expect(d.calls.length).toBe(ran);
    // a look that cannot reach tailscale keeps what was seen; a change that fails leaves nothing served
    const run = d.run;
    d.run = () => Promise.reject(new Error('tailscaled is wedged'));
    await control_.get();
    expect(control_.served()).toBe('https://mac.tailnet.ts.net:8443/');
    await control_.set(true);
    expect(control_.served()).toBeUndefined();
    d.run = run;
    await control_.get();
    expect(control_.served()).toBe('https://mac.tailnet.ts.net:8443/');
    await control_.set(false);
    expect(control_.served()).toBeUndefined();
  });

  it('builds the phone page when the checkout has none', async () => {
    const d = deps({ files: { [path.join(HOME, 'port')]: '47812', [path.join(HOME, 'mobile-key')]: 'abcdef' } });
    await control(d).set(true);
    expect(d.calls.map((c) => c.cmd)).toContain('pnpm');
  });

  it('keeps the phone key out of the reason it hands the panel', async () => {
    const d = deps();
    const ran = d.run;
    // tailscale carries the key in the target it is given, and execFile repeats the command it failed to run
    d.run = (cmd, args, cwd) => (args.includes('--bg')
      ? Promise.reject(new Error(`Command failed: ${cmd} ${args.join(' ')}`))
      : ran(cmd, args, cwd));
    const { error } = await control(d).set(true);
    expect(error).toContain('Command failed: tailscale serve');
    expect(error).not.toContain('abcdef');
  });

  it('hands the panel the reason instead of failing the call', async () => {
    const broken: MobileDeps = { run: () => Promise.reject(new Error('nope')), exists: () => true, read: () => undefined };
    expect(await control(broken).get()).toMatchObject({ serving: false, error: expect.stringMatching(/tailscale not found/) });

    const stopped = deps();
    stopped.read = () => undefined;
    expect(await control(stopped).get()).toMatchObject({ serving: false, error: expect.stringMatching(/not running/) });
  });
});

describe('tests', () => {
  // a daemon looks at its phone link as it starts, so the first tailscale on PATH must be the double
  it('find the tailscale double before any real one', () => {
    const first = (process.env.PATH ?? '').split(':').map((d) => path.join(d, 'tailscale')).find((f) => fs.existsSync(f));
    expect(fs.readFileSync(first!, 'utf8')).toContain('Test double');
  });
});

describe('phoneKey', () => {
  afterEach(cleanHomes);

  it('keeps the key it was given until it makes a new one, which it leaves in the file for tailscale serve', () => {
    const file = path.join(makeHome(), 'mobile-key');
    fs.writeFileSync(file, 'old', { mode: 0o600 });
    const key = phoneKey(file, 'old');
    expect(key.get()).toBe('old');
    key.rotate();
    expect(key.get()).toMatch(/^[0-9a-f]{48}$/);
    expect(fs.readFileSync(file, 'utf8')).toBe(key.get());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  // the daemon and tailscale serve would answer to different keys, and the phone would reach neither
  it('keeps the key it has when the new one cannot be written', () => {
    const key = phoneKey(path.join(makeHome(), 'gone', 'mobile-key'), 'old');
    expect(() => key.rotate()).toThrow();
    expect(key.get()).toBe('old');
  });
});

describe('watchServed', () => {
  afterEach(() => { vi.useRealTimers(); });

  const looks = (answers: Partial<MobileStatus>[]) => {
    const seen: number[] = [];
    const mobile = { get: () => { seen.push(Date.now()); return Promise.resolve({ serving: true, url: 'https://mac/', port: 443, logins: [], phones: [], ...answers[seen.length - 1] }); } };
    return { seen, mobile };
  };

  // at login tailscale may still be starting, and a push waits on a look that answered
  it('looks again while a look fails and a device waits, and stops at the first answer', async () => {
    vi.useFakeTimers();
    const { seen, mobile } = looks([{ error: 'tailscale is Starting' }, { error: 'tailscale is Starting' }, {}]);
    watchServed(mobile, () => true, 1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toHaveLength(3);
  });

  it('looks once when no device waits, and not again once stopped', async () => {
    vi.useFakeTimers();
    const none = looks([{ error: 'tailscale not found' }]);
    watchServed(none.mobile, () => false, 1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(none.seen).toHaveLength(1);
    const stopped = looks([{ error: 'tailscale is Starting' }, { error: 'tailscale is Starting' }]);
    const stop = watchServed(stopped.mobile, () => true, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopped.seen).toHaveLength(2);
  });
});
