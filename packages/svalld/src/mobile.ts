import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import type { MobileStatus } from '@svall/protocol';
import { homeWord } from './machine.js';
import { resolvePaths } from './paths.js';
import type { Phones } from './phones.js';
import { PRIVATE, PRIVATE_HTTPS_PORT, SHIM, profileLabel } from './profile.js';
import { svalldUnitName } from './linux/setup.js';
import { isRelease, repoRoot } from './release.js';
import { mobileDist } from './runtime.js';

export type MobileDeps = {
  run(cmd: string, args: string[], cwd?: string): Promise<string>;
  exists(file: string): boolean;
  read(file: string): string | undefined;
};

// the GUI app keeps its CLI inside the bundle rather than on PATH
const TAILSCALE = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale'];

/** Why the phone link cannot serve, in Svall's words: what is wrong, what to do, the command that does it there, and what a tool said. */
export class LinkProblem extends Error {
  constructor(message: string, readonly said: Pick<MobileStatus, 'fix' | 'run' | 'raw'> = {}) { super(message); }
}

export type TailscaleState = 'missing' | 'stopped' | 'signedOut';

// a Mac runs Tailscale as an app; a Linux machine as a systemd service with its own CLI
function tailscaleSaid(state: TailscaleState, machine: string, linux: boolean): [string, Pick<MobileStatus, 'fix' | 'run'>] {
  if (state === 'missing') return [`${machine.replace(/^this /, 'This ')} has no Tailscale`, { fix: 'Install it from tailscale.com/download and sign in' }];
  if (state === 'stopped') return [`Tailscale is not running on ${machine}`, linux ? { fix: 'Start it: sudo systemctl start tailscaled', run: 'sudo systemctl start tailscaled' } : { fix: 'Open the Tailscale app' }];
  return [`Tailscale on ${machine} is signed out`, linux ? { fix: 'Sign in: sudo tailscale up', run: 'sudo tailscale up' } : { fix: 'Sign in from the Tailscale app' }];
}

/** A Tailscale that cannot serve this machine: not installed, its daemon stopped, or not signed in. */
export class TailscaleDown extends LinkProblem {
  constructor(readonly state: TailscaleState, raw?: string) {
    const [message, said] = tailscaleSaid(state, homeWord(), process.platform === 'linux');
    super(message, { ...said, ...(raw && { raw }) });
  }
}

export async function resolveTailscale(d: MobileDeps): Promise<string> {
  for (const bin of TAILSCALE) {
    try { await d.run(bin, ['version']); return bin; } catch { /* next candidate */ }
  }
  throw new TailscaleDown('missing');
}

type Status = {
  BackendState?: string;
  Self?: { DNSName?: string; UserID?: number; Tags?: string[] };
  User?: Record<string, { ID?: number; LoginName?: string }>;
};

/** The name this Mac answers to on the tailnet, also the origin the phone loads the page from, and the login it is
 *  signed in as; a tagged Mac belongs to no login. */
export async function tailnetSelf(d: MobileDeps, bin: string): Promise<{ host: string; owner?: string }> {
  let said: string;
  // installed, and its status does not run: its daemon is stopped
  try { said = await d.run(bin, ['status', '--json']); } catch (e) { throw new TailscaleDown('stopped', (e as Error).message); }
  const status = JSON.parse(said) as Status;
  if (status.BackendState !== 'Running') throw new TailscaleDown('signedOut', `BackendState ${status.BackendState ?? 'none'}`);
  const host = status.Self?.DNSName?.replace(/\.$/, '');
  if (!host) throw new TailscaleDown('signedOut', 'tailscale status names no DNSName for this machine');
  // matched by number, not by key: an id past 2^53 parses short on both sides alike
  const owner = status.Self?.Tags?.length ? undefined : Object.values(status.User ?? {}).find((u) => u.ID === status.Self?.UserID)?.LoginName;
  return { host, owner };
}

export const fleetOrigin = (d: MobileDeps, home: string): string | undefined => {
  const p = Number(d.read(resolvePaths(home).port)?.trim());
  return p ? `http://127.0.0.1:${p}/` : undefined;
};

/** Where serve sends the phone: the daemon's port behind the key tailscaled prepends to each request it proxies. */
export function fleetTarget(d: MobileDeps, home: string): string {
  const origin = fleetOrigin(d, home);
  if (!origin) throw new LinkProblem('The fleet is not running', { fix: `Start the app, or run ${SHIM} <profile>` });
  const { mobileKey } = resolvePaths(home);
  const key = d.read(mobileKey)?.trim();
  if (!key) throw new LinkProblem('The fleet has no phone key', { fix: "Restart Svall's background service, which writes one", raw: `no ${mobileKey}` });
  return `${origin}${key}`;
}

/** The key the daemon checks, and the file `fleetTarget` hands tailscale serve: a fresh one shuts out whoever learned the last. */
export function phoneKey(file: string, initial: string): { get(): string; rotate(): void } {
  let key = initial;
  return {
    get: () => key,
    rotate: () => { const next = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(file, next, { mode: 0o600 }); key = next; },
  };
}

/** How the daemon of `profile` restarts on `platform`. */
export const restartLine = (profile: string, platform: NodeJS.Platform = process.platform): string =>
  (platform === 'linux' ? `systemctl --user restart ${svalldUnitName(profile)}` : `launchctl kickstart -k gui/$(id -u)/${profileLabel(profile)}`);

const buildBundle = (d: MobileDeps): Promise<string> =>
  d.run('pnpm', ['--filter', '@svall/desktop-web', 'build:mobile'], repoRoot());

/** Where the phone page is, built from the checkout first when it can be; a release ships it built, with no pnpm to run. */
export async function ensureBundle(d: MobileDeps, o: { rebuild?: boolean } = {}): Promise<{ dist: string; missing: boolean }> {
  const dist = mobileDist();
  if (!isRelease() && (o.rebuild || !d.exists(dist))) await buildBundle(d);
  return { dist, missing: !d.exists(dist) };
}

// a port is part of the origin, so each fleet on its own port is its own app on the phone
export const servePort = (profile: string, configured?: number): number => configured ?? (profile === PRIVATE ? PRIVATE_HTTPS_PORT : 8443);

export const phoneUrl = (host: string, port: number): string => `https://${host}${port === 443 ? '' : `:${port}`}/`;

// tailscale refuses serve to a user it was not told to take it from
const DENIED = /access denied|serve config denied|--operator/i;
const OPERATOR = 'sudo tailscale set --operator=$USER';

export const serve = (d: MobileDeps, bin: string, target: string, port: number): Promise<string> =>
  d.run(bin, ['serve', '--bg', '--yes', `--https=${port}`, target]);

// `serve reset` would take every other mapping on the machine with it; drop only the one serve() added,
// and treat an already-absent handler as the state the caller asked for
export const unserve = async (d: MobileDeps, bin: string, port: number): Promise<string> => {
  try { return await d.run(bin, ['serve', `--https=${port}`, 'off']); } catch (e) {
    if (/handler does not exist/i.test(String(e))) return '';
    throw e;
  }
};

type ServeConfig = { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
type ServeStatus = ServeConfig & { Foreground?: Record<string, ServeConfig> };

/** Every port a serve on this Mac holds, in the background or in a foreground session. */
function heldPorts(json: string): Set<number> {
  const status = JSON.parse(json) as ServeStatus;
  const of = (c: ServeConfig) => [...Object.keys(c.TCP ?? {}).map(Number), ...Object.keys(c.Web ?? {}).map((at) => Number(at.slice(at.lastIndexOf(':') + 1)))];
  return new Set([...of(status), ...Object.values(status.Foreground ?? {}).flatMap(of)]);
}

/** The first port from 8443 up that nothing on this Mac serves and no other fleet keeps. */
export function freePort(json: string, kept: number[]): number {
  const used = new Set([...heldPorts(json), ...kept]);
  let port = 8443;
  while (used.has(port)) port++;
  return port;
}

/** The https ports that proxy to a daemon behind `key`, on whatever port it listened, or to the daemon at `origin`
 *  under a key a failed on or off already turned over. */
export function portsServing(json: string, key: string | undefined, origin?: string): number[] {
  const web = (JSON.parse(json) as ServeStatus).Web ?? {};
  return Object.entries(web)
    .filter(([, site]) => {
      const proxy = site.Handlers?.['/']?.Proxy;
      return !!proxy?.startsWith('http://127.0.0.1:') && (!!(key && proxy.endsWith(`/${key}`)) || !!(origin && proxy.startsWith(origin)));
    })
    .map(([at]) => Number(at.slice(at.lastIndexOf(':') + 1)));
}

/** Whether this fleet's own port already proxies to this fleet: another fleet's mapping there is not ours. */
export function servesTarget(json: string, host: string, port: number, target: string): boolean {
  const web = (JSON.parse(json) as ServeStatus).Web ?? {};
  return web[`${host}:${port}`]?.Handlers?.['/']?.Proxy === target;
}

/** Whether the port's link carries `key`, wherever the daemon behind it was. */
function servesKey(json: string, host: string, port: number, key: string): boolean {
  return !!(JSON.parse(json) as ServeStatus).Web?.[`${host}:${port}`]?.Handlers?.['/']?.Proxy?.endsWith(`/${key}`);
}

/** Whether the port serves anything but this fleet: another fleet's link, the other Svall build's, or the user's own.
 *  Its mapping carries its key across a daemon restart, and its daemon's address across a change that failed after the key turned over. */
export function servesOther(json: string, host: string, port: number, key: string | undefined, origin?: string): boolean {
  const site = (JSON.parse(json) as ServeStatus).Web?.[`${host}:${port}`];
  // a port with no web mapping here may still carry a tcp forward or a foreground serve
  if (!site) return heldPorts(json).has(port);
  return Object.values(site.Handlers ?? {}).some((h) => !(key && h.Proxy?.endsWith(`/${key}`)) && !(origin && h.Proxy?.startsWith(origin)));
}

const exec = promisify(execFile);

// a build prints a great deal, and a pnpm that wedges must still let mobile.set answer before its own deadline
const RUN = { maxBuffer: 16 * 1024 * 1024, timeout: 150_000 };
const runCommand: MobileDeps['run'] = async (cmd, args, cwd) => (await exec(cmd, args, { cwd, ...RUN })).stdout;

export const realDeps = (run: MobileDeps['run'] = runCommand): MobileDeps => ({
  run,
  exists: (file) => fs.existsSync(file),
  read: (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } },
});

export type Mobile = {
  get(): Promise<MobileStatus>;
  set(enabled: boolean): Promise<MobileStatus>;
};

/** The link as last seen, which a push reads rather than asking tailscale: its https url while served. */
type Served = { served(): string | undefined };

/** Looks at the link, and again every `ms` while a look fails and `wanted` holds: at login tailscale may still be starting. */
export function watchServed(mobile: Pick<Mobile, 'get'>, wanted: () => boolean, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const look = () => { void mobile.get().then((s) => { if (s.error && wanted() && !stopped) timer = setTimeout(look, ms); }); };
  look();
  return () => { stopped = true; clearTimeout(timer); };
}

/** The phone link as a panel drives it: every environment failure comes back as `error`, not a rejection, since the
 *  panel that shows the switch is where the reason belongs. */
export function mobileControl(d: MobileDeps, opts: {
  home: string; profile: string; logins: () => string[]; phones: Phones; httpsPort?: number; rotateKey: () => void; pass: string;
  // the ports other fleets keep, and where this fleet keeps the one it serves on, saying whether that worked
  kept: () => number[]; savePort: (port: number) => boolean;
}): Mobile & Served & { logins: () => string[] } {
  let saved = opts.httpsPort;
  let port = servePort(opts.profile, saved);
  const { mobileKey } = resolvePaths(opts.home);

  // who a phone socket and a push are let through for: the configured logins, else the Mac's own once tailscale named it
  let owner: string | undefined;
  const logins = (): string[] => { const configured = opts.logins(); return configured.length ? configured : owner ? [owner] : []; };

  // the commands carry the phone key in their target, and a failed one repeats its whole command line
  const masked = (text: string): string => {
    const key = d.read(mobileKey)?.trim();
    return key ? text.split(key).join('…') : text;
  };
  // what is wrong, in Svall's words; anything else a tool refused is the link's own failure, its words behind
  const problem = (e: unknown, enable?: boolean): Pick<MobileStatus, 'error' | 'fix' | 'run' | 'raw'> => {
    if (e instanceof LinkProblem) return { error: e.message, ...e.said, ...(e.said.raw && { raw: masked(e.said.raw) }) };
    const raw = masked(e instanceof Error ? e.message : String(e));
    const machine = homeWord();
    if (DENIED.test(raw)) return { error: `Tailscale on ${machine} does not let Svall share this fleet`, fix: `Run once on ${machine}: ${OPERATOR}`, run: OPERATOR, raw };
    const could = enable === undefined ? 'could not be read' : enable ? 'could not start' : 'could not stop';
    return { error: `The phone link ${could} on ${machine}`, raw };
  };

  const read = async (enable?: boolean): Promise<MobileStatus> => {
    // the key the link carries now, which tells this fleet's mapping from another's on the same port
    const key = d.read(mobileKey)?.trim();
    // every on and off serves a new key, so one learned while the link was up opens nothing afterwards
    if (enable === false) opts.rotateKey();
    const bin = await resolveTailscale(d);
    const self = await tailnetSelf(d, bin);
    const { host } = self;
    owner = self.owner;
    if (enable === true && logins().length === 0) {
      throw new LinkProblem(`Tailscale names no login for ${homeWord()}`, { fix: "Set mobile.logins in fleet.json, then restart Svall's background service", run: restartLine(opts.profile) });
    }
    const dist = mobileDist();
    // tailscale serve holds one mapping per port for the whole Mac, so a port another holds stays theirs. A fleet that
    // keeps no port yet takes a free one in place of its default; a kept port is the address a phone app already has
    const before = enable === undefined ? undefined : await d.run(bin, ['serve', 'status', '--json']);
    const other = !!before && servesOther(before, host, port, key, fleetOrigin(d, opts.home));
    const picks = enable === true && saved === undefined;
    const kept = picks ? opts.kept() : [];
    // the port this attempt serves on, which becomes the fleet's only once it is served
    let at = port;
    if (picks && before && (other || kept.includes(port))) at = freePort(before, kept);
    else if (enable === true && other) {
      throw new LinkProblem(`Port ${port} on ${homeWord()} already serves another fleet or site`, { fix: `Turn that one off with tailscale serve --https=${port} off, or set mobile.httpsPort to a free port in this fleet's node.json and restart it` });
    }
    // an on turns the key over only once tailscale and the page are ready, so one that fails leaves a working link alone
    if (enable === true) {
      await ensureBundle(d);
      opts.rotateKey();
    }
    const target = fleetTarget(d, opts.home);
    if (enable === true) await serve(d, bin, target, at);
    if (enable === false && !other) await unserve(d, bin, at);
    let json = await d.run(bin, ['serve', 'status', '--json']);
    // the daemon starts with the app, on a new port unless the fleet names one: its link, known by its key, follows it there
    if (enable === undefined && key && !servesTarget(json, host, at, target) && servesKey(json, host, at, key)) {
      await serve(d, bin, target, at);
      json = await d.run(bin, ['serve', 'status', '--json']);
    }
    const serving = servesTarget(json, host, at, target);
    if (serving) {
      port = at;
      // the port is part of the phone app's address, so the one served on is kept for the next start
      if (at !== saved && opts.savePort(at)) saved = at;
    }
    const url = phoneUrl(host, at);
    // the pass rides in the fragment, which a browser keeps to itself: neither tailscale nor the daemon's log sees it
    const pair = `${url}#${opts.pass}`;
    const status: MobileStatus = {
      serving, url, port: at, logins: logins(), phones: opts.phones.list(), pair,
      qr: await QRCode.toDataURL(pair, { margin: 1, width: 320 }),
    };
    // the mapping outlives the checkout it was made from: a page cleaned away leaves the switch on over nothing
    if (serving && !d.exists(dist)) status.pageMissing = true;
    return status;
  };

  // a look that cannot reach tailscale leaves what was seen; a change always replaces it, since the key turned over
  let served: string | undefined;
  const settle = async (enable?: boolean): Promise<MobileStatus> => {
    let s: MobileStatus;
    try { s = await read(enable); } catch (e) {
      s = { serving: false, url: '', port, logins: logins(), phones: opts.phones.list(), ...problem(e, enable) };
    }
    if (enable !== undefined || !s.error) served = s.serving ? s.url : undefined;
    return s;
  };
  // one at a time: a look still running when a change turns the key over would serve the fleet again under the new key.
  // A look asked for meanwhile takes the answer of the last one queued
  let queued: Promise<MobileStatus> | undefined;
  const status = (enable?: boolean): Promise<MobileStatus> => {
    if (enable === undefined && queued) return queued;
    const run = () => settle(enable);
    const next = (queued ?? Promise.resolve()).then(run, run);
    queued = next;
    void next.then(() => { if (queued === next) queued = undefined; });
    return next;
  };

  return { get: () => status(), set: (enabled) => status(enabled), served: () => served, logins };
}
