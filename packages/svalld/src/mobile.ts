import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import type { MobileStatus } from '@svall/protocol';
import { MOBILE_DIST } from './api/bundle.js';
import { repoRoot, resolvePaths } from './paths.js';
import type { Phones } from './phones.js';
import { PRIVATE, PRIVATE_HTTPS_PORT, SHIM, profileLabel } from './profile.js';

export type MobileDeps = {
  run(cmd: string, args: string[], cwd?: string): Promise<string>;
  exists(file: string): boolean;
  read(file: string): string | undefined;
};

// the GUI app keeps its CLI inside the bundle rather than on PATH
const TAILSCALE = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale'];

export async function resolveTailscale(d: MobileDeps): Promise<string> {
  for (const bin of TAILSCALE) {
    try { await d.run(bin, ['version']); return bin; } catch { /* next candidate */ }
  }
  throw new Error('tailscale not found: install it from https://tailscale.com/download and sign in');
}

type Status = {
  BackendState?: string;
  Self?: { DNSName?: string; UserID?: number; Tags?: string[] };
  User?: Record<string, { ID?: number; LoginName?: string }>;
};

/**
 * The name this Mac answers to on the tailnet, which is also the origin the phone loads the page from,
 * and the login it is signed in as. A tagged Mac belongs to no login.
 */
export async function tailnetSelf(d: MobileDeps, bin: string): Promise<{ host: string; owner?: string }> {
  const status = JSON.parse(await d.run(bin, ['status', '--json'])) as Status;
  if (status.BackendState !== 'Running') throw new Error(`tailscale is not connected${status.BackendState ? ` (${status.BackendState})` : ''}; sign in and try again`);
  const host = status.Self?.DNSName?.replace(/\.$/, '');
  if (!host) throw new Error('tailscale did not report a name for this machine');
  // matched by number, not by key: an id past 2^53 parses short on both sides alike
  const owner = status.Self?.Tags?.length ? undefined : Object.values(status.User ?? {}).find((u) => u.ID === status.Self?.UserID)?.LoginName;
  return { host, owner };
}

export const fleetOrigin = (d: MobileDeps, home: string): string | undefined => {
  const p = Number(d.read(resolvePaths(home).port)?.trim());
  return p ? `http://127.0.0.1:${p}/` : undefined;
};

/** Where serve sends the phone: the daemon's port behind the key only svalld and tailscaled hold. */
export function fleetTarget(d: MobileDeps, home: string): string {
  const origin = fleetOrigin(d, home);
  if (!origin) throw new Error(`the fleet is not running: start the app, or run \`${SHIM} <profile>\``);
  const { mobileKey } = resolvePaths(home);
  const key = d.read(mobileKey)?.trim();
  if (!key) throw new Error(`no phone key at ${mobileKey}: restart the daemon so it writes one`);
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

export const buildBundle = (d: MobileDeps): Promise<string> =>
  d.run('pnpm', ['--filter', '@svall/desktop-web', 'build:mobile'], repoRoot());

// a port is part of the origin, so each fleet on its own port is its own app on the phone
export const servePort = (profile: string, configured?: number): number => configured ?? (profile === PRIVATE ? PRIVATE_HTTPS_PORT : 8443);

export const phoneUrl = (host: string, port: number): string => `https://${host}${port === 443 ? '' : `:${port}`}/`;

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

type ServeStatus = { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };

/** The first port from 8443 up that nothing on this Mac serves and no other fleet keeps. */
export function freePort(json: string, kept: number[]): number {
  const { TCP = {}, Web = {} } = JSON.parse(json) as ServeStatus;
  const used = new Set([...Object.keys(TCP).map(Number), ...Object.keys(Web).map((at) => Number(at.slice(at.lastIndexOf(':') + 1))), ...kept]);
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
export function servesKey(json: string, host: string, port: number, key: string): boolean {
  return !!(JSON.parse(json) as ServeStatus).Web?.[`${host}:${port}`]?.Handlers?.['/']?.Proxy?.endsWith(`/${key}`);
}

/** Whether the port serves anything but this fleet: another fleet's link, the other Svall build's, or the user's own.
 *  Its mapping carries its key across a daemon restart, and its daemon's address across a change that failed after the key turned over. */
export function servesOther(json: string, host: string, port: number, key: string | undefined, origin?: string): boolean {
  const handlers = (JSON.parse(json) as ServeStatus).Web?.[`${host}:${port}`]?.Handlers ?? {};
  return Object.values(handlers).some((h) => !(key && h.Proxy?.endsWith(`/${key}`)) && !(origin && h.Proxy?.startsWith(origin)));
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
export type Served = { served(): string | undefined };

/** Looks at the link, and again every `ms` while a look fails and `wanted` holds: at login tailscale may still be starting. */
export function watchServed(mobile: Pick<Mobile, 'get'>, wanted: () => boolean, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const look = () => { void mobile.get().then((s) => { if (s.error && wanted() && !stopped) timer = setTimeout(look, ms); }); };
  look();
  return () => { stopped = true; clearTimeout(timer); };
}

/**
 * The phone link as a panel can drive it: every environment failure comes back as `error` rather than
 * a rejection, because the panel that shows the switch is also where the reason belongs.
 */
export function mobileControl(d: MobileDeps, opts: {
  home: string; profile: string; logins: string[]; phones: Phones; httpsPort?: number; rotateKey: () => void;
  // the ports other fleets keep, and where this fleet keeps the one it serves on
  kept?: () => number[]; savePort?: (port: number) => void;
}): Mobile & Served & { logins: () => string[] } {
  let saved = opts.httpsPort;
  let port = servePort(opts.profile, saved);
  const { mobileKey } = resolvePaths(opts.home);

  // who a phone socket and a push are let through for: the configured logins, else the Mac's own once tailscale named it
  let owner: string | undefined;
  const logins = (): string[] => (opts.logins.length ? opts.logins : owner ? [owner] : []);

  // the commands carry the phone key in their target, and a failed one repeats its whole command line
  const reason = (e: unknown): string => {
    const message = e instanceof Error ? e.message : String(e);
    const key = d.read(mobileKey)?.trim();
    return key ? message.split(key).join('…') : message;
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
    if (enable === true && logins().length === 0) throw new Error(`tailscale reports no login for this Mac: set mobile.logins in config.json, then restart the daemon with launchctl kickstart -k gui/$(id -u)/${profileLabel(opts.profile)}`);
    // tailscale serve holds one mapping per port for the whole Mac, so a port another holds stays theirs and an on moves to a free one
    const before = enable === undefined ? undefined : await d.run(bin, ['serve', 'status', '--json']);
    const other = !!before && servesOther(before, host, port, key, fleetOrigin(d, opts.home));
    if (enable === true && before && other) port = freePort(before, opts.kept?.() ?? []);
    // an on turns the key over only once tailscale and the page are ready, so one that fails leaves a working link alone
    if (enable === true) {
      if (!d.exists(MOBILE_DIST)) await buildBundle(d);
      opts.rotateKey();
    }
    const target = fleetTarget(d, opts.home);
    if (enable === true) await serve(d, bin, target, port);
    if (enable === false && !other) await unserve(d, bin, port);
    let json = await d.run(bin, ['serve', 'status', '--json']);
    // the daemon starts with the app, on a new port unless the fleet names one: its link, known by its key, follows it there
    if (enable === undefined && key && !servesTarget(json, host, port, target) && servesKey(json, host, port, key)) {
      await serve(d, bin, target, port);
      json = await d.run(bin, ['serve', 'status', '--json']);
    }
    const serving = servesTarget(json, host, port, target);
    // the port is part of the phone app's address, so the one served on is kept for the next start
    if (serving && port !== saved) { opts.savePort?.(port); saved = port; }
    const url = phoneUrl(host, port);
    const status: MobileStatus = {
      serving, url, port, logins: logins(), phones: opts.phones.list(),
      qr: await QRCode.toDataURL(url, { margin: 1, width: 320 }),
    };
    // the mapping outlives the checkout it was made from: a page cleaned away leaves the switch on over nothing
    if (serving && !d.exists(MOBILE_DIST)) status.pageMissing = true;
    return status;
  };

  // a look that cannot reach tailscale leaves what was seen; a change always replaces it, since the key turned over
  let served: string | undefined;
  const status = async (enable?: boolean): Promise<MobileStatus> => {
    let s: MobileStatus;
    try { s = await read(enable); } catch (e) {
      s = { serving: false, url: '', port, logins: logins(), phones: opts.phones.list(), error: reason(e) };
    }
    if (enable !== undefined || !s.error) served = s.serving ? s.url : undefined;
    return s;
  };

  return { get: () => status(), set: (enabled) => status(enabled), served: () => served, logins };
}
