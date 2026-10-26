import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupRow } from '@svall/protocol';
import { silentLogger } from '../../src/log.js';
import { fieldKey, setConsent } from '../../src/placement/mirror-consent.js';
import { setupRows, type ConfigReport } from '../../src/placement/mirror-report.js';
import { Mirror, mirrorPlan } from '../../src/placement/mirror.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { editJson, farHome, macHome, put } from './mirror-homes.js';
import { W, world } from './world.js';

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  vi.unstubAllEnvs();
  cleanHomes();
});

const O = { machine: 'w1', fleetFlag: '', unchecked: 'not checked: w1 is not reachable' };
const byKey = (key: string) => (r: SetupRow) => r.key === key;
const report = (o: Partial<ConfigReport> = {}): ConfigReport => ({ commands: {}, vars: {}, secrets: {}, oauth: {}, ...o });
const executable = (file: string) => { put(file, '#!/bin/sh\n'); fs.chmodSync(file, 0o755); };

describe('the setup rows of the mirror', () => {
  let mac: ReturnType<typeof macHome>;
  beforeEach(() => { mac = macHome(); });
  const rows = (r: ConfigReport | undefined, consent = new Set<string>(), o = O) => setupRows(mirrorPlan(mac, consent), r, o);
  // the row of `key` with every field of its item ticked, or none
  const row = (key: string, o: { ticked: boolean; secrets?: ConfigReport['secrets'] }, r: ConfigReport | undefined = report({ secrets: o.secrets ?? {} })) => {
    const fields = rows(undefined).find(byKey(key))!.tick!.fields;
    return rows(r, new Set(o.ticked ? fields.map((f) => fieldKey(key, f)) : [])).find(byKey(key));
  };

  it('a ticked and copied server is ok with its masked keys; unticked asks to copy them with the overrides folder in details; the worker\'s own is ok', () => {
    expect(row('claude:mcp:linear', { ticked: true, secrets: { 'claude:mcp:linear#env.LINEAR_API_KEY': 'copied' } }))
      .toMatchObject({ status: 'ok', detail: 'keys copied to w1: env.LINEAR_API_KEY lin…90', tick: { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true } });
    expect(row('claude:mcp:linear', { ticked: false, secrets: {} }))
      .toMatchObject({ status: 'warn', action: "copy linear's keys to w1", detail: 'mirrored without env.LINEAR_API_KEY lin…90; or set them in ~/.svall/mirror-overrides on w1' });
    expect(row('claude:mcp:linear', { ticked: false, secrets: { 'claude:mcp:linear#env.LINEAR_API_KEY': 'own' } })).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
  });

  it('a ticked server not yet copied says pushed, not yet on w1', () => {
    expect(row('claude:mcp:linear', { ticked: true, secrets: {} })).toMatchObject({ status: 'warn', action: 'check w1 again', detail: 'pushed; not yet on w1' });
  });

  it('a ${VAR} the worker lacks is "set VAR on w1" with svall worker env VAR, under the fleet\'s flag; one it has is ok', () => {
    expect(rows(report({ vars: { REMOTE_TOKEN: false } })).find(byKey('var:REMOTE_TOKEN')))
      .toMatchObject({ status: 'warn', action: 'set REMOTE_TOKEN on w1', run: 'svall worker env REMOTE_TOKEN', detail: "remote read REMOTE_TOKEN, which w1's daemon does not have" });
    expect(rows(report({ vars: {} }), new Set(), { ...O, fleetFlag: '-p work ' }).find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ run: 'svall -p work worker env REMOTE_TOKEN' });
    expect(rows(report({ vars: { REMOTE_TOKEN: true } })).find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ status: 'ok', detail: 'REMOTE_TOKEN is set on w1' });
  });

  it('a missing npx is "install npx on w1"; a Mac-only server is skipped and listed; a known-host remote is a login row running claude; config.toml is one row for its key fields', () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.notion = { type: 'http', url: 'https://mcp.notion.com/mcp' }; });
    const all = rows(report({ commands: { node: true, npx: false } }));
    expect(all.find(byKey('runtime:npx'))).toMatchObject({ status: 'warn', action: 'install npx on w1', run: 'sudo apt install nodejs npm', detail: 'linear, empty, github need it' });
    expect(all.find(byKey('runtime:node'))).toBeUndefined();
    expect(all.find(byKey('maconly:claude:chrome'))).toMatchObject({ status: 'skip', detail: 'chrome only runs on a Mac; not mirrored' });
    expect(all.find(byKey('oauth:claude:mcp:notion'))).toMatchObject({ status: 'warn', action: 'log in once on w1', run: 'claude', detail: 'then /mcp and sign in to notion' });
    expect(rows(report({ oauth: { 'claude:mcp:notion': true } })).find(byKey('oauth:claude:mcp:notion'))).toMatchObject({ status: 'ok', detail: 'logged in on w1' });
    expect(all.filter(byKey('codex:config'))).toMatchObject([{ status: 'warn', action: "copy config.toml's keys to w1", tick: { item: 'codex:config', on: false } }]);
  });

  it('a command under the Mac\'s home is "install <name> on w1" naming its path; an OpenCode login is skipped with its command; the rows come in their order', () => {
    const db = path.join(mac.homedir, '.local/bin/db-mcp');
    put(path.join(mac.opencodeDir, 'opencode.json'), JSON.stringify({ mcp: { servers: { sentry: { type: 'remote', url: 'https://mcp.sentry.dev/mcp' } } } }));
    const all = rows(report({ commands: { [db]: false, bun: false }, vars: { REMOTE_TOKEN: true } }));
    expect(all.find(byKey(`runtime:${db}`))).toEqual({
      key: `runtime:${db}`, status: 'warn', action: 'install db-mcp on w1', detail: `db run ${db}, which w1 lacks (a path under this Mac's home is looked for under w1's)`,
    });
    expect(all.find(byKey('oauth:opencode:mcp:sentry')))
      .toEqual({ key: 'oauth:opencode:mcp:sentry', status: 'skip', run: 'opencode mcp auth sentry', detail: 'log in once on w1 with opencode mcp auth sentry; Svall cannot see whether you did' });
    const kinds = all.map((r) => r.key.replace(/^(var|oauth|runtime|maconly|unreadable):.*$/, '$1').replace(/^.*:mcp:.*$/, 'server').replace(/^.*:(config|settings)$/, 'config'));
    expect(kinds.filter((k, i) => k !== kinds[i - 1])).toEqual(['server', 'var', 'oauth', 'runtime', 'maconly', 'config']);
  });

  it('a server whose fields Svall does not know is one row to copy it whole, and the only one; a plugin\'s config too; a file that cannot be read is to set up by hand', () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', env: { K: '${ODD_VAR}' }, sandbox: { token: 'odd_token_1234567890' } }; });
    put(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json'), JSON.stringify({ env: { ACME_KEY: 'acme_1234567890abcd' } }));
    const toml = path.join(mac.codexDir, 'config.toml');
    put(toml, 'model = [');
    const all = rows(report({ commands: { odd: false } }));
    expect(all.filter((r) => /(^|:)(odd|ODD_VAR)$/.test(r.key))).toEqual([{
      key: 'claude:mcp:odd', status: 'warn', action: 'copy odd whole to w1', detail: 'odd has fields Svall does not know; it is not mirrored until you tick it',
      tick: { item: 'claude:mcp:odd', fields: ['command', 'env', 'sandbox'], on: false, preview: ['command', 'env', 'sandbox'] },
    }]);
    expect(row('claude:mcp:odd', { ticked: true })).toMatchObject({ status: 'ok', detail: 'copied whole to w1', tick: { on: true } });
    expect(all.find(byKey('claude:plugin:acme'))).toEqual({
      key: 'claude:plugin:acme', status: 'warn', action: "copy acme's config whole to w1", detail: "acme's config has fields Svall does not know; it is not mirrored until you tick it",
      tick: { item: 'claude:plugin:acme', fields: ['env'], on: false, preview: ['env'] },
    });
    expect(row('claude:plugin:acme', { ticked: true })).toMatchObject({ status: 'ok', detail: 'copied whole to w1' });
    expect(all.filter((r) => r.key.startsWith('unreadable:')))
      .toEqual([{ key: `unreadable:${toml}`, status: 'warn', detail: `${toml} cannot be read as JSON or TOML; set it up on w1 by hand` }]);
    expect(all.find(byKey('codex:mcp:github'))).toBeUndefined();
  });

  it('without a report the rows still come, the probe-dependent ones not checked with check w1 again and no runtime rows; a link in mismatch says to upgrade', () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.notion = { type: 'http', url: 'https://mcp.notion.com/mcp' }; });
    const linear = new Set([fieldKey('claude:mcp:linear', 'env.LINEAR_API_KEY')]);
    const all = rows(undefined, linear);
    expect(all.find(byKey('claude:mcp:linear'))).toMatchObject({ status: 'warn', action: 'check w1 again', detail: 'not checked: w1 is not reachable' });
    expect(all.find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ status: 'warn', action: 'check w1 again', detail: 'not checked: w1 is not reachable' });
    expect(all.find(byKey('oauth:claude:mcp:notion'))).toMatchObject({ status: 'warn', action: 'log in once on w1', run: 'claude' });
    expect(all.find(byKey('codex:mcp:github'))).toMatchObject({ status: 'warn', action: "copy github's keys to w1" });
    expect(all.filter((r) => r.key.startsWith('runtime:'))).toEqual([]);
    const odd = rows(undefined, linear, { ...O, unchecked: 'not checked: w1 runs another release; upgrade it' });
    for (const key of ['claude:mcp:linear', 'var:REMOTE_TOKEN']) expect(odd.find(byKey(key))).toMatchObject({ detail: 'not checked: w1 runs another release; upgrade it' });
  });

  it('Mirror.report reads no link as not reachable and one in mismatch as another release; a call that fails is logged and the rows come unchecked', async () => {
    const errors: string[] = [];
    const mirror = new Mirror({ ...mac, consent: path.join(makeHome(), 'mirror-consent.json'), log: { ...silentLogger, error: (m) => errors.push(m) } });
    const remote = async (link: Parameters<Mirror['report']>[0]) => (await mirror.report(link, W, { name: 'w1', fleetFlag: '' })).find(byKey('var:REMOTE_TOKEN'));
    const call = () => Promise.reject(new Error('timed out'));
    expect(await remote(undefined)).toMatchObject({ detail: 'not checked: w1 is not reachable' });
    expect(await remote({ connected: () => false, mismatch: () => ({}) as never, call })).toMatchObject({ detail: 'not checked: w1 runs another release; upgrade it' });
    expect(errors).toEqual([]);
    expect(await remote({ connected: () => true, mismatch: () => undefined, call })).toMatchObject({ action: 'check w1 again', detail: 'not checked: w1 is not reachable' });
    expect(errors).toEqual(['mirror: w1 did not answer config.state: timed out', 'mirror: w1 did not answer config.report: timed out']);
  });
});

describe('the worker\'s report over the link', () => {
  let mac: ReturnType<typeof macHome>;
  let worker: ReturnType<typeof farHome>;
  let w: ReturnType<typeof world>;
  beforeEach(async () => {
    mac = macHome();
    worker = farHome();
    w = world({ mirror: { home: mac, worker } });
    stops.push(() => w.stop());
    await w.link();
    await w.home.links.pushMirror(W);
  });
  const setup = () => w.home.mirror!.report(w.home.links.for(W), W, { name: 'w1', fleetFlag: '' });
  const rowOf = async (key: string) => (await setup()).find(byKey(key));
  const tick = (item: string, fields: string[], on: boolean) => setConsent(w.home.paths.mirrorConsent, W, item, fields, on);
  const push = () => w.home.mirror!.push(w.home.links.for(W)!);

  it('config.report answers from its PATH, env and .env', async () => {
    fs.appendFileSync(w.worker.paths.env, 'REMOTE_TOKEN=abc\nE=\n');
    const rows = await setup();
    expect(rows.find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ status: 'ok', detail: 'REMOTE_TOKEN is set on w1' });
    expect(rows.find(byKey('var:E'))).toMatchObject({ status: 'warn', action: 'set E on w1' });
    const bin = path.join(makeHome(), 'bin');
    for (const b of ['node', 'npx']) executable(path.join(bin, b));
    vi.stubEnv('PATH', bin);
    vi.stubEnv('E', 'from-the-daemon');
    const again = await setup();
    expect(again.filter((r) => r.key.startsWith('runtime:'))).toEqual([
      { key: 'runtime:bun', status: 'warn', action: 'install bun on w1', run: 'curl -fsSL https://bun.sh/install | bash', detail: 'ctx need it' },
    ]);
    expect(again.find(byKey('var:E'))).toMatchObject({ status: 'ok' });
  });

  it('config.state names the projects the worker has; a command under the Mac\'s home is looked for under the worker\'s; a project server\'s key is read under the worker\'s path of it', async () => {
    const db = path.join(mac.homedir, '.local/bin/db-mcp');
    const item = `claude:mcp:db@${path.join(mac.homedir, 'code/app')}`;
    editJson(mac.claudeJson, (j) => { j.projects[path.join(mac.homedir, 'code/app')].mcpServers.db.env = { DB_PASSWORD: 'db_pass_1234567890' }; });
    tick(item, ['env.DB_PASSWORD'], true);
    expect((await setup()).filter((r) => r.key.includes('db-mcp') || r.key === item)).toEqual([]);
    fs.mkdirSync(path.join(worker.homedir, 'code/app'), { recursive: true });
    expect(await rowOf(`runtime:${db}`)).toMatchObject({ status: 'warn', action: 'install db-mcp on w1' });
    expect(await rowOf(item)).toMatchObject({ status: 'warn', detail: 'pushed; not yet on w1' });
    await push();
    expect(await rowOf(item)).toMatchObject({ status: 'ok', detail: 'keys copied to w1: env.DB_PASSWORD db_…90' });
    executable(path.join(worker.homedir, '.local/bin/db-mcp'));
    expect((await setup()).filter((r) => r.key.includes('db-mcp'))).toEqual([]);
  });

  it('a ticked key is ok once the worker holds the copy, a plugin server\'s too; unticked, the reference the mirror leaves is not the worker\'s own, a value it set itself is', async () => {
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    tick('claude:plugin:acme:mcp:pdf', ['env.PDF_KEY'], true);
    expect(await rowOf('claude:mcp:linear')).toMatchObject({ status: 'warn', detail: 'pushed; not yet on w1' });
    await push();
    expect(await rowOf('claude:mcp:linear')).toMatchObject({ status: 'ok', detail: 'keys copied to w1: env.LINEAR_API_KEY lin…90' });
    expect(await rowOf('claude:plugin:acme:mcp:pdf')).toMatchObject({ status: 'ok', detail: 'keys copied to w1: env.PDF_KEY pdf…90' });
    tick('claude:mcp:linear', [], false);
    // the copy stays until the next push takes it
    expect(await rowOf('claude:mcp:linear')).toMatchObject({ status: 'warn', action: "copy linear's keys to w1" });
    await push();
    expect(await rowOf('claude:mcp:linear')).toMatchObject({ status: 'warn', action: "copy linear's keys to w1" });
    editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = 'worker-own'; });
    expect(await rowOf('claude:mcp:linear')).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
    // a plugin server file the worker changed holds its own
    tick('claude:plugin:acme:mcp:pdf', [], false);
    await push();
    editJson(path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json'), (j) => { j.mcpServers.pdf.env.PDF_KEY = 'pdf-own'; });
    expect(await rowOf('claude:plugin:acme:mcp:pdf')).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
  });

  it('a key in the worker\'s overrides or its own settings env is its own before the next push; a Claude login is read from its credentials', async () => {
    expect(await rowOf('codex:mcp:github')).toMatchObject({ status: 'warn', action: "copy github's keys to w1" });
    put(path.join(worker.overrides, 'codex/config.toml'), '[mcp_servers.github.env]\nGITHUB_TOKEN = "worker-own"\n');
    expect(await rowOf('codex:mcp:github')).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
    expect(await rowOf('claude:settings')).toMatchObject({ status: 'warn', action: "copy settings.json's keys to w1" });
    editJson(path.join(worker.claudeDir, 'settings.json'), (j) => { j.env.ANTHROPIC_API_KEY = 'sk-worker'; });
    expect(await rowOf('claude:settings')).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
    editJson(mac.claudeJson, (j) => { j.mcpServers.notion = { type: 'http', url: 'https://mcp.notion.com/mcp' }; });
    expect(await rowOf('oauth:claude:mcp:notion')).toMatchObject({ status: 'warn', action: 'log in once on w1' });
    put(path.join(worker.claudeDir, '.credentials.json'), JSON.stringify({ mcpOAuth: { 'notion|4f1c': { accessToken: 'x' } } }));
    expect(await rowOf('oauth:claude:mcp:notion')).toMatchObject({ status: 'ok', detail: 'logged in on w1' });
  });
});
