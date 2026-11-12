import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as tomlOf } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { silentLogger } from '../../src/log.js';
import { Mirror } from '../../src/placement/mirror.js';
import { applyMirror, takeBackCopies } from '../../src/placement/mirror-apply.js';
import { readConsent, setConsent } from '../../src/placement/mirror-consent.js';
import { refuseForeign } from '../../src/placement/mirror-copy.js';
import { mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { configReport, reportAsk, setupRows } from '../../src/placement/mirror-report.js';
import { readState, serverSha } from '../../src/placement/mirror-state.js';
import { unpack } from '../../src/placement/move-steps.js';
import { makeHome } from '../helpers.js';
import { editJson, farHome, json, macHome, put, read } from './mirror-homes.js';

const K = 'sk_home_key_1234567890';
const K2 = 'sk_home_key_0987654321';
function setup(mode: 'mac' | 'copy' | 'dialed' = 'mac') {
  const home = macHome();
  const w = farHome();
  fs.rmSync(w.overrides, { recursive: true, force: true });
  const scratch = makeHome();
  const stateFile = path.join(w.homedir, '.svall/cache/mirror-state.json');
  const varsFile = path.join(w.homedir, '.svall/mirror-vars.json');
  const backups = path.join(w.homedir, '.svall/mirror-backup');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  let seq = 0;
  const consent = new Set<string>();
  const options = { ...w, stateFile, varsFile, ...(mode !== 'dialed' && { backups }), ...(mode === 'copy' && { additive: true, refuse: refuseForeign }) };
  const push = async () => {
    const dir = path.join(scratch, String(++seq));
    const state = readState(stateFile);
    await packMirror(mirrorPlan(home, consent, { state, projects: {}, platform: 'darwin' } as never), `${dir}.tar`, state);
    await unpack(`${dir}.tar`, dir);
    return applyMirror(dir, { ...options, seq });
  };
  const rows = () => {
    const plan = mirrorPlan(home, consent);
    return setupRows(plan, configReport(reportAsk(plan), { ...options, envFile: path.join(w.homedir, '.svall/.env') }), { machine: 'm', fleetFlag: '', unchecked: 'not checked', overrides: 'overrides' });
  };
  return { home, w, push, rows, consent, stateFile, backups, homeToml: path.join(home.codexDir, 'config.toml'), toml: path.join(w.codexDir, 'config.toml') };
}

describe('what the round\'s tests leave', () => {
  it('PX1 a rollback copy of an edited whole server, its key only in a secret field, goes once the live one is gone', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', env: { T: K }, sandbox: { on: true } }; });
    for (const f of ['command', 'env', 'sandbox']) s.consent.add(`claude:mcp:odd#${f}`);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    const bak = `${s.w.claudeJson}.bak-1700000000000`;
    fs.writeFileSync(bak, read(s.w.claudeJson));
    s.consent.clear();
    await s.push();
    expect(fs.existsSync(bak)).toBe(true);
    editJson(s.w.claudeJson, (j) => { delete j.mcpServers.odd; });
    await s.push();
    expect(read(s.w.claudeJson)).not.toContain(K);
    expect(fs.existsSync(bak)).toBe(false);
  });
  it('PX2 a section the target holds with a scalar beside tables, the sender holding only tables, stays one value', async () => {
    const s = setup();
    const [at, here] = [path.join(s.home.claudeDir, 'settings.json'), path.join(s.w.claudeDir, 'settings.json')];
    editJson(at, (j) => { j.sandbox = { network: { allowedDomains: ['a'] } }; });
    editJson(here, (j) => { j.sandbox = { enabled: false, network: { allowedDomains: ['*'] } }; });
    await s.push();
    expect(json(here).sandbox).toEqual({ network: { allowedDomains: ['a'] } });
  });
  it('PX3 a Codex env copy its still-carried server no longer lists goes, named in env_vars', async () => {
    const s = setup();
    put(s.homeToml, ['[mcp_servers.gh]', 'command = "gh-mcp"', '[mcp_servers.gh.env]', `GH_KEY = "${K}"`, ''].join('\n'));
    s.consent.add('codex:mcp:gh#env.GH_KEY');
    await s.push();
    expect(read(s.toml)).toContain(K);
    put(s.homeToml, ['[mcp_servers.gh]', 'command = "gh-mcp"', ''].join('\n'));
    await s.push();
    const gh = (parseToml(read(s.toml)) as any).mcp_servers.gh;
    expect(read(s.toml)).not.toContain(K);
    expect(gh.env?.GH_KEY).toBeUndefined();
  });
});

const agentText = (key: string, note = 'hi') => `---\nname: x\nmcpServers:\n  - s:\n      command: npx\n      env:\n        S_API_KEY: ${key}\n---\n${note}\n`;
// a subagent holding a key, ticked, landing through a link into the target's dotfiles
function linked(mode: 'mac' | 'copy' | 'dialed' = 'mac') {
  const s = setup(mode);
  const agent = path.join(s.home.claudeDir, 'agents/x.md');
  put(agent, agentText(K));
  const row = mirrorPlan(s.home).plugins.find((p) => p.key.startsWith('claude:agent:'))!;
  const ticks = row.fields.map((f) => `${row.key}#${f}`);
  const tick = () => { for (const t of ticks) s.consent.add(t); };
  const landed = path.join(s.w.claudeDir, 'agents/x.md');
  const dot = path.join(s.w.homedir, 'dotfiles/agents/x.md');
  put(dot, 'orig\n');
  fs.mkdirSync(path.dirname(landed), { recursive: true });
  fs.symlinkSync(dot, landed);
  tick();
  return { ...s, agent, landed, dot, tick, row: () => s.rows().find((r) => r.key === row.key) };
}

describe('a link to a keyed file no longer the copy', () => {
  for (const mode of ['mac', 'copy'] as const) {
    it(`on a ${mode}, unticked, the home's next change and a later tick: nothing writes through it, and it stays named`, async () => {
      const s = linked(mode);
      await s.push();
      expect(read(s.dot)).toContain(K);
      fs.appendFileSync(s.dot, 'MY-EDIT\n');
      const edited = read(s.dot);
      s.consent.clear();
      expect((await s.push()).left).toEqual([s.landed]);
      put(s.agent, agentText(K, 'the home changed it'));
      s.tick();
      const later = await s.push();
      expect(read(s.dot)).toBe(edited);
      expect(fs.lstatSync(s.landed).isSymbolicLink()).toBe(true);
      expect(later.left).toEqual([s.landed]);
      expect(later.written).not.toContain(s.landed);
      expect(s.row()).toMatchObject({ status: 'warn', detail: 'edited on m; stays as it is', gap: { what: 'stays as you edited it, with any key Svall copied in it' } });
    });
    it(`on a ${mode}, under a standing tick, the home's next change does not write through it, nor the one after`, async () => {
      const s = linked(mode);
      await s.push();
      fs.appendFileSync(s.dot, 'MY-EDIT\n');
      const edited = read(s.dot);
      put(s.agent, agentText(K, 'the home changed it'));
      expect((await s.push()).left).toEqual([s.landed]);
      put(s.agent, agentText(K, 'and again'));
      await s.push();
      expect(read(s.dot)).toBe(edited);
      expect(s.row()?.detail).toBe('edited on m; stays as it is');
    });
    it(`on a ${mode}, once the person removes the link, the next tick writes a plain file and the dotfile stays`, async () => {
      const s = linked(mode);
      await s.push();
      fs.appendFileSync(s.dot, 'MY-EDIT\n');
      const edited = read(s.dot);
      put(s.agent, agentText(K, 'the home changed it'));
      await s.push();
      fs.rmSync(s.landed);
      const later = await s.push();
      expect(fs.lstatSync(s.landed).isSymbolicLink()).toBe(false);
      expect(read(s.landed)).toBe(agentText(K, 'the home changed it'));
      expect(read(s.dot)).toBe(edited);
      expect(later.left).toBeUndefined();
      expect(s.row()?.detail).not.toBe('edited on m; stays as it is');
    });
  }
  it('removed while unticked, a later tick of the same file writes a plain file and the dotfile stays', async () => {
    const s = linked();
    await s.push();
    fs.appendFileSync(s.dot, 'MY-EDIT\n');
    const edited = read(s.dot);
    s.consent.clear();
    await s.push();
    fs.rmSync(s.landed);
    await s.push();
    expect(readState(s.stateFile).keyed).toBeUndefined();
    s.tick();
    await s.push();
    expect(fs.lstatSync(s.landed).isSymbolicLink()).toBe(false);
    expect(read(s.landed)).toBe(agentText(K));
    expect(read(s.dot)).toBe(edited);
  });
  it('still the copy, takes the home\'s change through the link', async () => {
    const s = linked();
    await s.push();
    put(s.agent, agentText(K, 'the home changed it'));
    await s.push();
    expect(read(s.dot)).toBe(agentText(K, 'the home changed it'));
  });
  it('on a Linux worker its home dials, is written through as ever', async () => {
    const s = linked('dialed');
    await s.push();
    fs.appendFileSync(s.dot, 'MY-EDIT\n');
    put(s.agent, agentText(K, 'the home changed it'));
    await s.push();
    expect(read(s.dot)).toBe(agentText(K, 'the home changed it'));
  });
  it('keeps the record of the key it holds, so an uninstall takes that out, whatever the home\'s holds now', async () => {
    const s = linked();
    await s.push();
    fs.appendFileSync(s.dot, 'MY-EDIT\n');
    const places = Object.keys(readState(s.stateFile).secrets);
    put(s.agent, `---\nname: x\nmcpServers:\n  - s:\n      command: npx\n      env:\n        S_API_KEY: ${K2}\n        S_OTHER_KEY: ${K2}\n---\nhi\n`);
    s.tick();
    for (const f of mirrorPlan(s.home).plugins.flatMap((p) => p.fields.map((x) => `${p.key}#${x}`))) s.consent.add(f);
    await s.push();
    expect(Object.keys(readState(s.stateFile).secrets)).toEqual(places);
    expect((await takeBackCopies({ ...s.w, stateFile: s.stateFile })).join()).toContain('took 1 key');
    expect(read(s.dot)).toContain('MY-EDIT');
    expect(read(s.dot)).not.toContain(K);
  });
  it('reads as a link for a row of two files, one of them edited in place', () => {
    const w = farHome();
    const stateFile = path.join(w.homedir, '.svall/cache/mirror-state.json');
    const dot = path.join(w.homedir, 'dotfiles/a.md');
    put(dot, 'edited\n');
    fs.mkdirSync(path.join(w.claudeDir, 'agents'), { recursive: true });
    fs.symlinkSync(dot, path.join(w.claudeDir, 'agents/a.md'));
    put(path.join(w.claudeDir, 'agents/b.md'), 'edited\n');
    const [a, b] = ['claude/agents/a.md', 'claude/agents/b.md'];
    put(stateFile, JSON.stringify({ files: { [a]: 'f'.repeat(64), [b]: 'f'.repeat(64) }, keyed: { [a]: 'f'.repeat(64), [b]: 'f'.repeat(64) }, docs: {}, servers: {}, secrets: {} }));
    const ask = { homedir: w.homedir, claudeDir: w.claudeDir, commands: [], vars: [], secrets: [], oauth: [], held: [], whole: [a, b].map((file) => ({ item: 'i', file, place: [], fields: [] })) };
    expect(configReport(ask, { ...w, stateFile, varsFile: path.join(w.homedir, 'vars'), backups: path.join(w.homedir, 'b'), envFile: path.join(w.homedir, '.env') } as never).edited).toEqual({ i: 'link' });
  });
  for (const mode of ['mac', 'copy'] as const) {
    it(`on a ${mode}, takes no whole-file override, one put there after the edit or standing from before it`, async () => {
      const s = linked(mode);
      await s.push();
      fs.appendFileSync(s.dot, 'MY-EDIT\n');
      const edited = read(s.dot);
      const override = path.join(s.w.overrides, 'claude/agents/x.md');
      put(override, 'OVERRIDE\n');
      expect((await s.push()).written).not.toContain(s.landed);
      expect(read(s.dot)).toBe(edited);
      const b = linked(mode);
      put(path.join(b.w.overrides, 'claude/agents/x.md'), 'OVERRIDE\n');
      await b.push();
      expect(read(b.dot)).toBe('OVERRIDE\n');
      fs.appendFileSync(b.dot, 'MY-EDIT\n');
      await b.push();
      expect(read(b.dot)).toBe('OVERRIDE\nMY-EDIT\n');
    });
  }
  it('takes an override once the link is gone', async () => {
    const s = linked();
    await s.push();
    fs.appendFileSync(s.dot, 'MY-EDIT\n');
    put(path.join(s.w.overrides, 'claude/agents/x.md'), 'OVERRIDE\n');
    await s.push();
    fs.rmSync(s.landed);
    await s.push();
    expect(read(s.landed)).toBe('OVERRIDE\n');
    expect(read(s.dot)).toContain('MY-EDIT');
  });
  it('in a plugin\'s server file with a key by its field, its row says so, ticked or not, and no other row speaks for it', async () => {
    const s = setup();
    const acme = path.join(s.home.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    put(path.join(s.home.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: acme, version: '1.0.0' }] } }));
    put(path.join(acme, '.mcp.json'), JSON.stringify({ mcpServers: { pdf: { command: 'pdf', env: { P_KEY: K } } } }));
    const item = mirrorPlan(s.home).servers.find((x) => x.name === 'pdf')!;
    const ticks = item.secretFields.map((f) => `${item.key}#${f}`);
    for (const t of ticks) s.consent.add(t);
    const landed = path.join(s.w.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json');
    const dot = path.join(s.w.homedir, 'dotfiles/mcp.json');
    put(dot, '{}\n');
    fs.mkdirSync(path.dirname(landed), { recursive: true });
    fs.symlinkSync(dot, landed);
    await s.push();
    expect(s.rows().find((r) => r.key === item.key)?.detail).toBe('copied');
    put(dot, JSON.stringify({ ...JSON.parse(read(dot)), mine: 'MY-EDIT' }));
    const words = 'edited on m; stays as it is';
    expect(s.rows().find((r) => r.key === item.key)?.detail).toBe(words);
    s.consent.clear();
    await s.push();
    expect(read(dot)).toContain(K);
    expect(s.rows().find((r) => r.key === item.key)).toMatchObject({ status: 'warn', detail: words });
    expect(s.rows().find((r) => r.key === `edited:${item.key}`)).toBeUndefined();
  });
  it('whose target no longer holds the key, its row does not say it does', async () => {
    const s = linked();
    await s.push();
    put(s.dot, 'mine only, no key\n');
    s.consent.clear();
    await s.push();
    expect(s.row()?.detail).toBe('edited on m; stays as it is');
  });
});

describe('an override a target that keeps its own holds', () => {
  it('naming a command or a url, reaches the file though nothing else holds that server', async () => {
    const s = setup();
    put(s.homeToml, 'model = "x"\n');
    put(path.join(s.w.overrides, 'codex/config.toml'), '[mcp_servers.mine]\ncommand = "my-tool"\n[mcp_servers.far]\nurl = "https://far.test/mcp"\n');
    await s.push();
    const servers = (parseToml(read(s.toml)) as any).mcp_servers;
    expect(servers.mine).toEqual({ command: 'my-tool' });
    expect(servers.far).toEqual({ url: 'https://far.test/mcp' });
  });
  it('of a timeout alone, does not', async () => {
    const s = setup();
    put(s.homeToml, 'model = "x"\n');
    put(path.join(s.w.overrides, 'codex/config.toml'), '[mcp_servers.gh]\nstartup_timeout_sec = 99\n');
    await s.push();
    expect((parseToml(read(s.toml)) as any).mcp_servers).toBeUndefined();
  });
});

const BEFORE = { url: 'https://x.test/mcp', default_tools_approval_mode: 'approve', http_headers: { 'X-Key': K, 'Y-Key': K2 } };
const ITEM = 'codex:mcp:odd';
const RAW = Object.keys(BEFORE);
const W = 'm_worker' as MachineId;
// a whole copy of a shape that read as unknown when it was ticked and reads as known now: its record, unedited, its ticks by raw field
async function tickedBefore(mode: 'mac' | 'dialed') {
  const s = setup(mode);
  put(s.homeToml, tomlOf({ mcp_servers: { odd: { ...BEFORE, scopes: ['r'] } } }));
  for (const f of [...RAW, 'scopes']) s.consent.add(`${ITEM}#${f}`);
  await s.push();
  const d = parseToml(read(s.toml)) as any;
  delete d.mcp_servers.odd.scopes;
  put(s.toml, tomlOf(d));
  const st = JSON.parse(read(s.stateFile));
  st.whole[JSON.stringify(['config.toml', 'mcp_servers', 'odd'])] = serverSha(d.mcp_servers.odd);
  put(s.stateFile, JSON.stringify(st));
  put(s.homeToml, tomlOf({ mcp_servers: { odd: BEFORE } }));
  s.consent.delete(`${ITEM}#scopes`);
  return s;
}

describe('a known server with every raw field ticked', () => {
  for (const mode of ['mac', 'dialed'] as const) {
    it(`on a ${mode}, keeps its keys at the next push, the row saying they were copied`, async () => {
      const s = await tickedBefore(mode);
      await s.push();
      expect(read(s.toml)).toContain(K);
      expect(read(s.toml)).toContain(K2);
      expect(s.rows().find((r) => r.key === ITEM)).toMatchObject({ status: 'ok', detail: 'copied', tick: { on: true } });
    });
  }
  it('with one raw field not ticked, stands for no key', () => {
    const s = setup();
    put(s.homeToml, tomlOf({ mcp_servers: { odd: BEFORE } }));
    for (const f of RAW.slice(1)) s.consent.add(`${ITEM}#${f}`);
    expect(mirrorPlan(s.home, s.consent).servers.find((x) => x.key === ITEM)?.ticked).toEqual([]);
  });

  // the home's own Mirror over the same ticks, as a pane changes them
  function ticking() {
    const s = setup();
    put(s.homeToml, tomlOf({ mcp_servers: { odd: BEFORE } }));
    const file = path.join(makeHome(), 'mirror-consent.json');
    setConsent(file, W, ITEM, RAW, true);
    setConsent(file, W, 'other', ['f'], true);
    const mirror = new Mirror({ ...s.home, consent: file, log: silentLogger });
    const ticked = () => mirrorPlan(s.home, readConsent(file, W)).servers.find((x) => x.key === ITEM)?.ticked;
    const raw = () => RAW.filter((f) => readConsent(file, W).has(`${ITEM}#${f}`));
    return { ...s, file, mirror, ticked, raw };
  }
  it('takes a per-field untick: that key goes, the other stays ticked, and the push says so', async () => {
    const s = ticking();
    expect(s.ticked()).toEqual(['headers.X-Key', 'headers.Y-Key']);
    s.mirror.consent(W, ITEM, ['headers.X-Key'], false, true);
    expect(s.ticked()).toEqual(['headers.Y-Key']);
    expect(s.raw()).toEqual([]);
    expect(readConsent(s.file, W).has('other#f')).toBe(true);
    for (const k of readConsent(s.file, W)) s.consent.add(k);
    await s.push();
    expect(read(s.toml)).not.toContain(K);
    expect(read(s.toml)).toContain(K2);
  });
  it('takes the untick of every field by name, and an untick with no names', () => {
    let s = ticking();
    s.mirror.consent(W, ITEM, ['headers.X-Key', 'headers.Y-Key'], false, true);
    expect(s.ticked()).toEqual([]);
    expect(s.raw()).toEqual([]);
    s = ticking();
    s.mirror.consent(W, ITEM, [], false);
    expect(s.ticked()).toEqual([]);
    expect(s.raw()).toEqual([]);
  });
  it('leaves every key ticked at a tick, the raw ticks gone', () => {
    const s = ticking();
    s.mirror.consent(W, ITEM, ['headers.X-Key'], true, true);
    expect(s.ticked()).toEqual(['headers.X-Key', 'headers.Y-Key']);
    expect(s.raw()).toEqual([]);
  });
  it('holds its raw ticks through a change of another item, which they leave as it was', () => {
    const s = ticking();
    s.mirror.consent(W, 'other', ['g'], true);
    expect(s.raw()).toEqual(RAW);
    expect([...readConsent(s.file, W)].filter((k) => k.startsWith('other#'))).toEqual(['other#f', 'other#g']);
  });
  it('after its untick, stands for nothing at the home\'s next change', () => {
    const s = ticking();
    s.mirror.consent(W, ITEM, ['headers.X-Key'], false, true);
    s.mirror.consent(W, ITEM, ['headers.Y-Key'], false, true);
    put(s.homeToml, tomlOf({ mcp_servers: { odd: { ...BEFORE, http_headers: { 'X-Key': K, 'Y-Key': K2, 'Z-Key': K } } } }));
    expect(s.ticked()).toEqual([]);
  });
});

describe('a whole copy edited since, as its row and result name it', () => {
  const ODD = { command: 'gh-mcp', extra: 1, env: { T: K } };
  const ticks = Object.keys(ODD).map((f) => `${ITEM}#${f}`);
  async function pushed() {
    const s = setup();
    put(s.homeToml, tomlOf({ mcp_servers: { odd: ODD } }));
    for (const t of ticks) s.consent.add(t);
    await s.push();
    return s;
  }
  it('with its key out and only its command kept, names no key', async () => {
    const s = await pushed();
    const d = parseToml(read(s.toml)) as any;
    delete d.mcp_servers.odd.env;
    put(s.toml, tomlOf(d));
    s.consent.clear();
    const r = await s.push();
    expect(r.left).toBeUndefined();
    expect(s.rows().find((x) => x.key === ITEM)?.action ?? '').not.toContain('copied key');
  });
  it('with its key kept, names it', async () => {
    const s = await pushed();
    fs.appendFileSync(s.toml, '\n[mcp_servers.odd.more]\non = true\n');
    s.consent.clear();
    expect((await s.push()).left).toEqual(['odd']);
    expect(s.rows().find((x) => x.key === ITEM)).toMatchObject({ detail: 'edited on m; stays as it is', action: 'Remove it on m if the copied key should go' });
  });
  it('holding a key in an sh -c, or args that could, names it', async () => {
    const s = setup();
    const SH = { command: 'sh', args: ['-c', `tool --token ${K}`] };
    put(s.homeToml, tomlOf({ mcp_servers: { odd: SH } }));
    for (const f of Object.keys(SH)) s.consent.add(`${ITEM}#${f}`);
    await s.push();
    const d = parseToml(read(s.toml)) as any;
    d.mcp_servers.odd.cwd = '/tmp';
    put(s.toml, tomlOf(d));
    s.consent.clear();
    expect((await s.push()).left).toEqual(['odd']);
    expect(read(s.toml)).toContain(K);
    expect(s.rows().find((x) => x.key === ITEM)).toMatchObject({ detail: 'edited on m; stays as it is', action: 'Remove it on m if the copied key should go' });
  });
  it('under a record naming none of its strings, names the key it may hold', async () => {
    const s = await pushed();
    const st = JSON.parse(read(s.stateFile));
    delete st.wholeKeys;
    put(s.stateFile, JSON.stringify(st));
    fs.appendFileSync(s.toml, '\n[mcp_servers.odd.more]\non = true\n');
    s.consent.clear();
    expect((await s.push()).left).toEqual(['odd']);
    expect(read(s.toml)).toContain(K);
    expect(s.rows().find((x) => x.key === ITEM)).toMatchObject({ detail: 'edited on m; stays as it is', action: 'Remove it on m if the copied key should go' });
  });
});
