import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { onPath } from '../../src/agents.js';
import { applyMirror } from '../../src/placement/mirror-apply.js';
import { mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { readState, serverSha } from '../../src/placement/mirror-state.js';
import { unpack } from '../../src/placement/move-steps.js';
import { makeHome } from '../helpers.js';
import { farHome, macHome, put, read } from './mirror-homes.js';

const K = 'sk_home_key_1234567890';
const K2 = 'sk_home_key_0987654321';
// the test environment's PATH leads with a fake agent of that name
const FOUND = onPath('codex', (process.env.PATH ?? '').split(':').filter((d) => !d.includes('test/fixtures')).join(':'));
const CODEX = FOUND && path.join(FOUND, 'codex');
const S = makeHome();
let n = 0;
function loads(toml: string): { ok: boolean; out: string } {
  const d = path.join(S, `run-${process.pid}-${++n}`);
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(toml, path.join(d, 'config.toml'));
  try {
    return { ok: true, out: execFileSync(CODEX!, ['mcp', 'list'], { env: { PATH: process.env.PATH, CODEX_HOME: d, HOME: S }, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).toString() };
  } catch (e) {
    const x = e as { stderr?: Buffer; stdout?: Buffer; message: string };
    return { ok: false, out: `${x.stderr?.toString() ?? ''}${x.stdout?.toString() ?? ''}` || x.message };
  }
}
function setup() {
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
  const push = async () => {
    const dir = path.join(scratch, String(++seq));
    const state = readState(stateFile);
    await packMirror(mirrorPlan(home, consent, { state, projects: {}, platform: 'darwin' } as never), `${dir}.tar`, state);
    await unpack(`${dir}.tar`, dir);
    return applyMirror(dir, { ...w, stateFile, varsFile, backups, seq });
  };
  return { home, w, push, consent, homeToml: path.join(home.codexDir, 'config.toml'), toml: path.join(w.codexDir, 'config.toml') };
}
const must = (s: { toml: string }, step: string): void => { const r = loads(s.toml); expect(r.ok, `${step}: ${r.out}\n${read(s.toml)}`).toBe(true); };

describe.skipIf(!CODEX)('real codex loads what a target keeps', () => {
  it('MF2 a whole server with an approval mode: loads at each step, untick, drop and later tick', async () => {
    const s = setup();
    const odd = ['[mcp_servers.odd]', 'command = "odd"', 'script = "run.sh"', 'default_tools_approval_mode = "approve"', '[mcp_servers.odd.env]', `T = "${K}"`, ''].join('\n');
    put(s.homeToml, odd);
    for (const f of ['command', 'script', 'default_tools_approval_mode', 'env']) s.consent.add(`codex:mcp:odd#${f}`);
    await s.push();
    must(s, 'ticked');
    expect(read(s.toml)).toContain(K);
    fs.appendFileSync(s.toml, '\n[mcp_servers.odd.tools.search]\napproval_mode = "approve"\n');
    must(s, 'edited');
    const edited = parseToml(read(s.toml)) as any;
    s.consent.clear();
    const r = await s.push();
    must(s, 'unticked');
    expect((parseToml(read(s.toml)) as any).mcp_servers.odd).toEqual(edited.mcp_servers.odd);
    expect(r.left).toEqual(['odd']);
    put(s.homeToml, 'model = "x"\n');
    await s.push();
    must(s, 'dropped');
    put(s.homeToml, odd);
    for (const f of ['command', 'script', 'default_tools_approval_mode', 'env']) s.consent.add(`codex:mcp:odd#${f}`);
    await s.push();
    must(s, 'ticked again');
  });
  it('a server only in the overrides, and a whole tick of a shape that reads known now: loads at each step, through a per-field untick', async () => {
    const s = setup();
    const stateFile = path.join(s.w.homedir, '.svall/cache/mirror-state.json');
    const odd = { url: 'https://x.test/mcp', default_tools_approval_mode: 'approve', http_headers: { 'X-Key': K, 'Y-Key': K2 } };
    put(s.homeToml, stringifyToml({ mcp_servers: { odd: { ...odd, scopes: ['r'] } } }));
    for (const f of [...Object.keys(odd), 'scopes']) s.consent.add(`codex:mcp:odd#${f}`);
    put(path.join(s.w.overrides, 'codex/config.toml'), '[mcp_servers.mine]\ncommand = "my-tool"\n[mcp_servers.far]\nurl = "https://far.test/mcp"\n');
    await s.push();
    must(s, 'ticked whole');
    const d = parseToml(read(s.toml)) as any;
    delete d.mcp_servers.odd.scopes;
    put(s.toml, stringifyToml(d));
    const st = JSON.parse(read(stateFile));
    st.whole[JSON.stringify(['config.toml', 'mcp_servers', 'odd'])] = serverSha(d.mcp_servers.odd);
    put(stateFile, JSON.stringify(st));
    put(s.homeToml, stringifyToml({ mcp_servers: { odd } }));
    s.consent.delete('codex:mcp:odd#scopes');
    await s.push();
    must(s, 'reads known');
    expect(read(s.toml)).toContain(K);
    expect((parseToml(read(s.toml)) as any).mcp_servers.mine).toEqual({ command: 'my-tool' });
    expect((parseToml(read(s.toml)) as any).mcp_servers.far).toEqual({ url: 'https://far.test/mcp' });
    s.consent.clear();
    s.consent.add('codex:mcp:odd#headers.Y-Key');
    await s.push();
    must(s, 'one key unticked');
    expect(read(s.toml)).not.toContain(K);
    expect(read(s.toml)).toContain(K2);
    s.consent.clear();
    await s.push();
    must(s, 'unticked');
    expect(read(s.toml)).not.toContain(K2);
  });
  it('MF3 a per-field server with a required url: loads when the home drops it, with a header of the person', async () => {
    const s = setup();
    put(s.homeToml, ['[mcp_servers.gh]', `url = "https://gh.test/mcp?api_key=${K}"`, ''].join('\n'));
    s.consent.add('codex:mcp:gh#url.api_key');
    await s.push();
    must(s, 'ticked');
    fs.appendFileSync(s.toml, '\n[mcp_servers.gh.http_headers]\nX-Mine = "sk_own_key_0987654321"\n');
    must(s, 'edited');
    put(s.homeToml, 'model = "x"\n');
    await s.push();
    must(s, 'dropped');
    expect(read(s.toml)).not.toContain(K);
  });
  it('MF3b a provider base_url and an otel endpoint: loads when the home drops them', async () => {
    const s = setup();
    put(s.homeToml, ['[otel.exporter.otlp-http]', `endpoint = "https://o.test/v1?api_key=${K}"`, 'protocol = "binary"', ''].join('\n'));
    const fields = mirrorPlan(s.home, s.consent).configs.find((c) => c.key === 'codex:config')?.fields.filter((f) => f.includes('endpoint')) ?? [];
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) s.consent.add(`codex:config#${f}`);
    await s.push();
    must(s, 'ticked');
    fs.appendFileSync(s.toml, '\n[otel.exporter.otlp-http.headers]\nX-Mine = "sk_own_key_0987654321"\n');
    must(s, 'edited');
    put(s.homeToml, 'model = "x"\n');
    await s.push();
    must(s, 'dropped');
    expect(read(s.toml)).not.toContain(K);
  });
});
