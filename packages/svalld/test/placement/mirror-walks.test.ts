import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { sha256Hex } from '../../src/hash.js';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { applyMirror } from '../../src/placement/mirror-apply.js';
import { mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { readState } from '../../src/placement/mirror-state.js';
import { unpack } from '../../src/placement/move-steps.js';
import { farHome, macHome, put, read } from './mirror-homes.js';
import { makeHome } from '../helpers.js';

const N = 20;
const STEPS = 8;
const K = 'sk_k_aaaaaaaaaaaaaaaaaaaaaaaa';
const K2 = 'sk_k_bbbbbbbbbbbbbbbbbbbbbbbb';
const OWN = 'sk_own_cccccccccccccccccccccc';
const rng = (seed: number) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const walk = (d: string): string[] => (fs.existsSync(d) ? (fs.readdirSync(d, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort() : []);

const TICKS = ['claude:mcp:linear#env.LINEAR_API_KEY', 'codex:config#model_providers.acme.http_headers.X-Key', 'codex:config#model_providers.acme.auth.args[--token]', 'codex:mcp:github#env.GITHUB_TOKEN', 'opencode:config#provider.openai.options.apiKey', 'claude:settings#env.ANTHROPIC_API_KEY', 'claude:mcp:neu#env.NEU_KEY', 'claude:mcp:a#args[--api-key]'];
const ODD = ['command', 'env', 'sandbox'].map((f) => `claude:mcp:odd#${f}`);
const provider = (key: string, args: string[] | undefined) => ['model = "gpt-5"', '[model_providers.acme]', 'name = "Acme"', 'base_url = "https://acme.test/v1"', `http_headers = { "X-Key" = "${key}" }`, ...(args ? ['[model_providers.acme.auth]', 'command = "tok"', `args = ${JSON.stringify(args)}`] : []), '[mcp_servers.github]', 'command = "npx"', `env = { GITHUB_TOKEN = "${key}" }`, ''].join('\n');
const e = (f: string, fn: (j: any) => void): void => { const j = fs.existsSync(f) ? JSON.parse(read(f)) : {}; fn(j); put(f, JSON.stringify(j, null, 2)); };
const t = (f: string, fn: (j: any) => void): void => { const j: any = fs.existsSync(f) ? parseToml(read(f)) : {}; fn(j); put(f, stringifyToml(j)); };

// what main wrote on each of these walks: ticks, rotations, a person's edits, reshaped lists, moved args and overrides in each config file;
// on any change, compare with main before accepting a new snapshot
it('a Linux worker its home dials walks as on main', async () => {
  const results: Record<string, string> = {};
  for (let seed = 1; seed <= N; seed++) {
    const r = rng(seed * 7919);
    const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
    const home = macHome();
    const w = farHome();
    if (r() < 0.5) fs.rmSync(w.overrides, { recursive: true, force: true });
    const stateFile = path.join(w.homedir, '.svall/cache/mirror-state.json');
    const varsFile = path.join(w.homedir, '.svall/mirror-vars.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const consent = new Set<string>();
    const scratch = makeHome();
    const hToml = path.join(home.codexDir, 'config.toml');
    const wToml = path.join(w.codexDir, 'config.toml');
    const hSet = path.join(home.claudeDir, 'settings.json');
    const wSet = path.join(w.claudeDir, 'settings.json');
    const proj = path.join(home.homedir, 'code/app');
    let seq = 0;
    const sender: (() => void)[] = [
      () => { const x = pick(TICKS); if (consent.has(x)) consent.delete(x); else consent.add(x); },
      () => { if (consent.has(ODD[0])) ODD.forEach((x) => consent.delete(x)); else ODD.forEach((x) => consent.add(x)); },
      () => consent.clear(),
      () => e(home.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = pick([K, K2, '${LINEAR_API_KEY}']); }),
      () => e(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', env: { T: pick([K, K2]) }, sandbox: { token: pick([K, K2]) } }; }),
      () => e(home.claudeJson, (j) => { delete j.mcpServers.odd; }),
      () => e(home.claudeJson, (j) => { j.mcpServers.neu = { command: 'neu', env: { NEU_KEY: pick([K, K2]) } }; }),
      () => e(home.claudeJson, (j) => { delete j.mcpServers.neu; }),
      () => e(home.claudeJson, (j) => { j.mcpServers.a = { command: 'a-mcp', args: pick([['--api-key', K], ['--verbose', '--api-key', K2], ['--verbose']]) }; }),
      () => e(home.claudeJson, (j) => { delete j.mcpServers.a; }),
      () => e(home.claudeJson, (j) => { j.mcpServers.byEnv = { command: 'npx', args: ['y'], env: { Y: '${Y}' } }; }),
      () => e(home.claudeJson, (j) => { j.projects[proj].mcpServers.dbk = { command: 'db', env: { DB_KEY: pick([K, K2]) } }; }),
      () => e(home.claudeJson, (j) => { delete j.projects[proj].mcpServers.dbk; }),
      () => put(hToml, provider(pick([K, K2]), pick([undefined, ['--verbose', '--token', K], ['--token', K2], ['--verbose']]))),
      () => t(hToml, (j) => { delete j.model_providers; }),
      () => t(hToml, (j) => { delete j.mcp_servers; }),
      () => e(hSet, (j) => { j.fromHome = pick([1, 2]); }),
      () => e(hSet, (j) => { delete j.fromHome; }),
      () => e(hSet, (j) => { j.provider = { apiKey: pick([K, '${P_KEY}']), url: 'https://home' }; }),
      () => e(hSet, (j) => { j.enabledPlugins = { 'acme@mp': pick([true, false]) }; }),
      () => e(hSet, (j) => { delete j.enabledPlugins; }),
      () => e(hSet, (j) => { j.env.ANTHROPIC_API_KEY = pick(['sk-mac', K2]); }),
    ];
    const person: (() => void)[] = [
      () => e(w.claudeJson, (j) => { j.mcpServers ??= {}; j.mcpServers.linear = { ...(j.mcpServers.linear ?? { command: 'npx' }), env: { LINEAR_API_KEY: pick([OWN, K]) } }; }),
      () => e(w.claudeJson, (j) => { if (j.mcpServers?.linear) j.mcpServers.linear.timeout = 5; }),
      () => e(w.claudeJson, (j) => { if (j.mcpServers?.linear?.env) j.mcpServers.linear.env.MINE = OWN; }),
      () => e(w.claudeJson, (j) => { delete j.mcpServers?.linear; }),
      () => e(w.claudeJson, (j) => { if (j.mcpServers?.odd) j.mcpServers.odd.env = { ...j.mcpServers.odd.env, MINE: OWN }; }),
      () => e(w.claudeJson, (j) => { if (j.mcpServers?.a?.args) j.mcpServers.a.args = pick([['--api-key', OWN], [...j.mcpServers.a.args, '--more'], ['--more', ...j.mcpServers.a.args], ['--x']]); }),
      () => e(w.claudeJson, (j) => { j.mcpServers ??= {}; j.mcpServers.neu = { command: 'mine', env: { NEU_KEY: OWN } }; }),
      () => { if (fs.existsSync(wToml)) t(wToml, (j) => { delete j.model_providers; }); },
      () => { if (fs.existsSync(wToml)) t(wToml, (j) => { if (j.model_providers?.acme) j.model_providers.acme.name = 'Edited'; }); },
      () => { if (fs.existsSync(wToml)) t(wToml, (j) => { const a = j.model_providers?.acme?.auth; if (a?.args) a.args = pick([[...a.args, '--more'], ['--more', ...a.args], ['--verbose'], ['--token', OWN]]); }); },
      () => { if (fs.existsSync(wToml)) t(wToml, (j) => { if (j.model_providers?.acme) delete j.model_providers.acme.auth; }); },
      () => t(wToml, (j) => { j.model_providers ??= {}; j.model_providers.mine = { name: 'Mine', env_key: 'M', http_headers: { 'X-Key': OWN } }; }),
      () => t(wToml, (j) => { j.model_providers ??= {}; if (j.model_providers.acme) j.model_providers.acme.http_headers = { 'X-Key': pick([OWN, '']) }; }),
      () => t(wToml, (j) => { j.mcp_servers ??= {}; j.mcp_servers.github = { command: 'npx', env: { GITHUB_TOKEN: OWN } }; }),
      () => { const f = path.join(w.opencodeDir, 'opencode.jsonc'); if (fs.existsSync(f)) e(f, (j) => { if (j.provider?.openai?.options) j.provider.openai.options.apiKey = OWN; }); },
      () => e(wSet, (j) => { j.provider = { apiKey: OWN, url: 'https://mine' }; }),
      () => e(wSet, (j) => { j.onlyHere = 1; j.enabledPlugins = { ...j.enabledPlugins, 'own@x': true }; }),
      () => e(wSet, (j) => { j.env = { ...j.env, ANTHROPIC_API_KEY: pick([OWN, '']) }; }),
      () => put(path.join(w.overrides, 'claude/.claude.json'), JSON.stringify({ mcpServers: { over: { command: 'o' } } })),
      () => put(path.join(w.claudeDir, 'rules/style.md'), 'mine\n'),
    ];
    const log: unknown[] = [];
    for (let i = 0; i < STEPS; i++) {
      for (const _ of [0, 1]) pick(sender)();
      if (r() < 0.6) pick(person)();
      const dir = path.join(scratch, String(++seq));
      let threw: string | undefined;
      try {
        const state = readState(stateFile);
        await packMirror(mirrorPlan(home, consent, { state, projects: {}, platform: 'linux' } as never), `${dir}.tar`, state);
        await unpack(`${dir}.tar`, dir);
        await applyMirror(dir, { ...w, stateFile, varsFile, seq } as never);
      } catch (x) { threw = (x as Error).message.slice(0, 200).split(w.homedir).join('<W>').split(home.homedir).join('<M>'); }
      const files = Object.fromEntries(walk(w.homedir).filter((f) => !f.includes('.svall/cache') && !f.includes('mirror-vars')).map((f) => [f, read(path.join(w.homedir, f)).split(w.homedir).join('<W>').split(home.homedir).join('<M>')]));
      const st = fs.existsSync(stateFile) ? JSON.parse(read(stateFile).split(w.homedir).join('<W>').split(home.homedir).join('<M>')) : {};
      // a record's shas of what lies under a temp home differ by run, so it counts by its names; a key's sha does not
      const names = (of?: object): string[] => Object.keys(of ?? {});
      log.push({ i, threw, files, state: { files: names(st.files), docs: names(st.docs).map((d) => [d, names(st.docs[d])]), servers: names(st.servers), whole: names(st.whole), secrets: st.secrets, bare: st.bare, applied: st.applied } });
    }
    results[String(seed)] = sha256Hex(JSON.stringify(log).split('/private<W>').join('<W>'));
  }
  await expect(`${JSON.stringify(results, null, 1)}
`).toMatchFileSnapshot('./mirror-walks.snap.json');
}, 120_000);
