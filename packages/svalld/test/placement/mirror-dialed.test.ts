import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { applyMirror } from '../../src/placement/mirror-apply.js';
import { mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { readState } from '../../src/placement/mirror-state.js';
import { unpack } from '../../src/placement/move-steps.js';
import { editJson, farHome, json, macHome, put, read } from './mirror-homes.js';
import { makeHome } from '../helpers.js';

const walk = (d: string): string[] => (fs.existsSync(d) ? (fs.readdirSync(d, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort() : []);
const dump = (h: { homedir: string }, mac: { homedir: string }) => Object.fromEntries(walk(h.homedir).filter((f) => !f.includes('.svall/cache') && !f.includes('mirror-vars')).map((f) => [f, fs.readFileSync(path.join(h.homedir, f), 'utf8').split(h.homedir).join('<W>').split(mac.homedir).join('<M>')]));
function setup() {
  const home = macHome();
  const w = farHome();
  const stateFile = path.join(w.homedir, '.svall/cache/mirror-state.json');
  const varsFile = path.join(w.homedir, '.svall/mirror-vars.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  let seq = 0;
  const consent = new Set<string>();
  const push = async () => {
    const dir = makeHome();
    const tar = path.join(dir, 'm.tar');
    const state = readState(stateFile);
    const plan = mirrorPlan(home, consent, { state, projects: {}, platform: 'linux' } as never);
    await packMirror(plan, tar, state);
    await unpack(tar, path.join(dir, 'blob'));
    await applyMirror(path.join(dir, 'blob'), { ...w, stateFile, varsFile, seq: ++seq } as never);
  };
  return { home, w, push, consent, stateFile };
}
const server = (v: string) => ({ command: 'npx', args: ['-y', 'y-mcp'], env: { Y_API_KEY: v } });
const jsonOr = (f: string) => (fs.existsSync(f) ? json(f) : {});
const scenarios: Record<string, () => Promise<unknown>> = {
  async 'fresh first push'() { const s = setup(); await s.push(); return dump(s.w, s.home); },
  async 'second push, a rule changed, one removed'() { const s = setup(); put(path.join(s.home.claudeDir, 'rules/gone.md'), 'g\n'); await s.push(); put(path.join(s.home.claudeDir, 'rules/style.md'), 'terser\n'); fs.rmSync(path.join(s.home.claudeDir, 'rules/gone.md')); await s.push(); return dump(s.w, s.home); },
  async 'own file only the worker has'() { const s = setup(); put(path.join(s.w.claudeDir, 'rules/mine.md'), 'mine\n'); await s.push(); return dump(s.w, s.home); },
  async 'worker file same name, replaced'() { const s = setup(); put(path.join(s.w.claudeDir, 'rules/style.md'), 'mine\n'); await s.push(); return dump(s.w, s.home); },
  async 'worker literal, home reference'() { const s = setup(); const h = json(s.home.claudeJson); h.mcpServers.byEnv = server('${Y_API_KEY}'); put(s.home.claudeJson, JSON.stringify(h)); const o = jsonOr(s.w.claudeJson); o.mcpServers = { ...o.mcpServers, byEnv: server('sk_worker_1234567890') }; put(s.w.claudeJson, JSON.stringify(o)); await s.push(); return dump(s.w, s.home); },
  async 'worker literal, home literal unticked'() { const s = setup(); const h = json(s.home.claudeJson); h.mcpServers.byEnv = server('sk_home_1234567890'); put(s.home.claudeJson, JSON.stringify(h)); const o = jsonOr(s.w.claudeJson); o.mcpServers = { ...o.mcpServers, byEnv: server('sk_worker_1234567890') }; put(s.w.claudeJson, JSON.stringify(o)); await s.push(); return dump(s.w, s.home); },
  async 'home drops a server the mirror gave'() { const s = setup(); const h = json(s.home.claudeJson); h.mcpServers.byEnv = server('${Y_API_KEY}'); put(s.home.claudeJson, JSON.stringify(h)); await s.push(); const h2 = json(s.home.claudeJson); delete h2.mcpServers.byEnv; put(s.home.claudeJson, JSON.stringify(h2)); await s.push(); return dump(s.w, s.home); },
  async 'home drops a server, worker filled its key by hand'() { const s = setup(); const h = json(s.home.claudeJson); h.mcpServers.byEnv = server('${Y_API_KEY}'); put(s.home.claudeJson, JSON.stringify(h)); await s.push(); const o = json(s.w.claudeJson); o.mcpServers.byEnv.env.Y_API_KEY = 'sk_by_hand_1234567890'; put(s.w.claudeJson, JSON.stringify(o)); const h2 = json(s.home.claudeJson); delete h2.mcpServers.byEnv; put(s.home.claudeJson, JSON.stringify(h2)); await s.push(); return dump(s.w, s.home); },
  async 'tick a key on a worker with none, then untick'() { const s = setup(); s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY'); await s.push(); const ticked = dump(s.w, s.home); s.consent.clear(); await s.push(); return { ticked, unticked: dump(s.w, s.home) }; },
  async 'tick over the worker\'s own literal, then untick'() { const s = setup(); const o = jsonOr(s.w.claudeJson); o.mcpServers = { ...o.mcpServers, linear: { ...json(s.home.claudeJson).mcpServers.linear, env: { LINEAR_API_KEY: 'lin_worker_own_123456' } } }; put(s.w.claudeJson, JSON.stringify(o)); s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY'); await s.push(); const ticked = dump(s.w, s.home); s.consent.clear(); await s.push(); return { ticked, unticked: dump(s.w, s.home) }; },
  async 'tick with the same value the worker holds, then untick'() { const s = setup(); const o = jsonOr(s.w.claudeJson); const l = json(s.home.claudeJson).mcpServers.linear; o.mcpServers = { ...o.mcpServers, linear: l }; put(s.w.claudeJson, JSON.stringify(o)); s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY'); await s.push(); s.consent.clear(); await s.push(); return dump(s.w, s.home); },
  async 'own plugin in the list on a first push'() { const s = setup(); put(path.join(s.w.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'own@x': [{ scope: 'user', installPath: path.join(s.w.claudeDir, 'plugins/cache/own'), version: '1' }] } })); put(path.join(s.w.claudeDir, 'plugins/known_marketplaces.json'), JSON.stringify({ ownm: { source: { source: 'github', repo: 'a/b' } } })); await s.push(); return dump(s.w, s.home); },
  async 'plugin added on the worker after a push, list changes'() { const s = setup(); await s.push(); const l = json(path.join(s.w.claudeDir, 'plugins/installed_plugins.json')); l.plugins['own@x'] = [{ scope: 'user', installPath: 'x', version: '1' }]; put(path.join(s.w.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify(l)); const hl = json(path.join(s.home.claudeDir, 'plugins/installed_plugins.json')); hl.plugins['second@m'] = [{ scope: 'user', installPath: path.join(s.home.claudeDir, 'plugins/cache/mp/acme/1.0.0'), version: '2' }]; put(path.join(s.home.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify(hl)); await s.push(); return dump(s.w, s.home); },
  async 'enabledPlugins own on a first push'() { const s = setup(); editJson(path.join(s.home.claudeDir, 'settings.json'), (j) => { j.enabledPlugins = { 'acme@mp': true }; }); put(path.join(s.w.claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'own@x': true }, permissions: { allow: ['mine'] }, onlyHere: 1 })); await s.push(); return dump(s.w, s.home); },
  async 'settings key dropped by the home'() { const s = setup(); editJson(path.join(s.home.claudeDir, 'settings.json'), (j) => { j.fromHome = 1; }); await s.push(); editJson(path.join(s.home.claudeDir, 'settings.json'), (j) => { delete j.fromHome; }); await s.push(); return dump(s.w, s.home); },
  async 'worker settings literal under a key the home holds'() { const s = setup(); editJson(path.join(s.home.claudeDir, 'settings.json'), (j) => { j.provider = { apiKey: '${P_KEY}', url: 'https://home' }; }); put(path.join(s.w.claudeDir, 'settings.json'), JSON.stringify({ provider: { apiKey: 'sk_settings_own_1234567890', url: 'https://mine' } })); await s.push(); return dump(s.w, s.home); },
  async 'rollback .bak holding an unticked key'() { const s = setup(); s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY'); await s.push(); put(`${s.w.claudeJson}.bak-1700000000000`, read(s.w.claudeJson)); s.consent.clear(); await s.push(); return dump(s.w, s.home); },
  async 'override over a doc and a file'() { const s = setup(); put(path.join(s.w.overrides, 'claude/rules/style.md'), 'override\n'); await s.push(); return dump(s.w, s.home); },
};
// what main wrote in each scenario, but for the rollback copy an untick takes: on any change, compare with main before accepting a new snapshot
it('a Linux worker its home dials behaves as on main in each of these', async () => {
  const results: Record<string, unknown> = {};
  for (const [name, run] of Object.entries(scenarios)) {
    try { results[name] = await run(); } catch (e) { results[name] = { threw: (e as Error).message.slice(0, 300) }; }
  }
  await expect(JSON.stringify(results, null, 1)).toMatchFileSnapshot('./mirror-dialed.snap.json');
}, 90_000);
