import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { applyMirror } from '../../src/placement/mirror-apply.js';
import { mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { readState } from '../../src/placement/mirror-state.js';
import { unpack } from '../../src/placement/move-steps.js';
import { makeHome } from '../helpers.js';
import { editJson, farHome, json, macHome, put, read } from './mirror-homes.js';

const K = 'sk_home_key_1234567890';
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
