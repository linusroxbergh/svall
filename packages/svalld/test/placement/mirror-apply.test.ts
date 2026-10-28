import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/hash.js';
import { agentServers } from '../../src/placement/mirror-agents.js';
import { applyMirror, takeBackCopies } from '../../src/placement/mirror-apply.js';
import { mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { unpack } from '../../src/placement/move-steps.js';
import { cleanHomes, diskLog, makeHome } from '../helpers.js';
import { editJson, FAR_HOOKS, FAR_STATUS, farHome, json, macHome, put, read } from './mirror-homes.js';

afterEach(() => cleanHomes());

describe('the agent configuration mirror', () => {
  it('applyMirror keeps the worker\'s hooks and statusLine, writes the servers into its .claude.json and merges mirror-overrides last; an unchanged file is not rewritten', async () => {
    const mac = macHome();
    const worker = farHome();
    const far = worker.homedir;
    const scratch = makeHome();
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    await packMirror(mirrorPlan(mac), path.join(scratch, 'mirror.tar'));
    const blob = path.join(scratch, 'blob');
    await unpack(path.join(scratch, 'mirror.tar'), blob);

    const { written } = await applyMirror(blob, o);
    expect(written.sort()).toEqual([
      path.join(far, '.agents/skills/lint/SKILL.md'), path.join(worker.agentProfiles, 'reviewer.md'),
      ...[
        'CLAUDE.md', 'agents/planner.md', 'commands/ship.md', 'keybindings.json', 'rules/style.md', 'settings.json', 'skills/review/SKILL.md', '.claude.json',
        'plugins/installed_plugins.json', 'plugins/known_marketplaces.json', 'plugins/cache/mp/acme/1.0.0/.mcp.json', 'plugins/cache/mp/acme/1.0.0/skills/pdf/SKILL.md',
        'plugins/marketplaces/mp/.claude-plugin/marketplace.json',
      ].map((f) => path.join(worker.claudeDir, f)),
      path.join(worker.codexDir, 'AGENTS.md'), path.join(worker.codexDir, 'config.toml'),
      path.join(worker.opencodeDir, 'opencode.jsonc'), path.join(worker.opencodeDir, 'plugins/mine.js'),
    ].sort());
    // the worker's own secrets, as its hooks and status line, stay as they were
    expect(json(path.join(worker.claudeDir, 'settings.json'))).toEqual({
      model: 'sonnet', cleanupPeriodDays: 7, hooks: FAR_HOOKS, statusLine: FAR_STATUS, env: { HTTPS_PROXY: 'http://proxy:3128' }, apiKeyHelper: '/home/ada/bin/key', theme: 'dark',
      scratchDir: path.join(far, 'scratch'), sandbox: { workPath: [path.join(far, 'code')], cwd: '/opt/shared' },
    });
    expect(read(path.join(worker.claudeDir, 'CLAUDE.md'))).toBe('# this worker\n');
    expect(read(path.join(worker.claudeDir, 'skills/review/SKILL.md'))).toBe('review it\n');
    for (const gone of ['skills/review/.env', '.credentials.json', 'projects']) expect(fs.existsSync(path.join(worker.claudeDir, gone))).toBe(false);
    expect(json(worker.claudeJson).mcpServers).toEqual({
      linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: '${LINEAR_API_KEY}' } },
      remote: { type: 'http', url: 'https://remote.test/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' } },
      empty: { command: 'npx', args: ['-y', 'empty-mcp'], env: { E: '${E}' } },
    });
    expect(fs.existsSync(path.join(far, '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(worker.codexDir, 'auth.json'))).toBe(false);
    expect(json(o.varsFile)).toEqual(['E', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'PDF_KEY', 'REMOTE_TOKEN']);

    const skill = fs.statSync(path.join(worker.claudeDir, 'skills/review/SKILL.md'));
    const settings = fs.statSync(path.join(worker.claudeDir, 'settings.json'));
    expect(await applyMirror(blob, o)).toEqual({ written: [], removed: [] });
    expect(fs.statSync(path.join(worker.claudeDir, 'skills/review/SKILL.md'))).toMatchObject({ ino: skill.ino, mtimeMs: skill.mtimeMs });
    expect(fs.statSync(path.join(worker.claudeDir, 'settings.json'))).toMatchObject({ ino: settings.ino, mtimeMs: settings.mtimeMs });
  });

  it('applyMirror writes its record of what it wrote last, once each file it wrote and each folder it wrote into is on disk', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    await packMirror(mirrorPlan(mac), path.join(scratch, 'mirror.tar'));
    await unpack(path.join(scratch, 'mirror.tar'), path.join(scratch, 'blob'));
    const events = diskLog();
    await applyMirror(path.join(scratch, 'blob'), o);
    const renames = events.flatMap((e, i) => (e.startsWith('rename ') ? [{ i, to: e.slice('rename '.length) }] : []));
    const final = renames[renames.length - 1];
    expect(final.to.endsWith('/mirror-state.json')).toBe(true);
    expect(renames.some((r) => r.to.endsWith('/mirror-vars.json'))).toBe(true);
    const unsynced = renames.slice(0, -1).filter((r) => !events.slice(r.i, final.i).includes(`sync ${path.dirname(r.to)}`));
    expect(unsynced).toEqual([]);
  });

  it('takeBackCopies empties each value the record holds as copied while it is still the copy, as an untick leaves it, and leaves a value the worker set itself', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const project = path.join(mac.homedir, 'code/app');
    editJson(mac.claudeJson, (j) => { j.projects[project].mcpServers.db.env = { DB_PASSWORD: 'db_pass_1234567890' }; });
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    const consent = new Set([
      'claude:mcp:linear#env.LINEAR_API_KEY', `claude:mcp:db@${project}#env.DB_PASSWORD`, 'claude:settings#env.ANTHROPIC_API_KEY', 'codex:mcp:github#env.GITHUB_TOKEN',
      'codex:config#model_providers.acme.http_headers.X-Key', 'opencode:config#provider.openai.options.apiKey',
    ]);
    await packMirror(mirrorPlan(mac, consent), path.join(scratch, 'mirror.tar'));
    await unpack(path.join(scratch, 'mirror.tar'), path.join(scratch, 'blob'));
    await applyMirror(path.join(scratch, 'blob'), o);
    editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = 'worker-own'; });
    const toml = path.join(worker.codexDir, 'config.toml');
    const settings = path.join(worker.claudeDir, 'settings.json');
    const jsonc = path.join(worker.opencodeDir, 'opencode.jsonc');
    expect(takeBackCopies(o).sort()).toEqual([
      `took 1 key the mirror copied out of ${jsonc}`, `took 1 key the mirror copied out of ${settings}`, `took 1 key the mirror copied out of ${worker.claudeJson}`,
      `took 2 keys the mirror copied out of ${toml}`, `left 1 key the mirror copied in ${worker.claudeJson}, which changed there since`,
    ].sort());
    const claude = json(worker.claudeJson);
    expect(claude.mcpServers.linear.env.LINEAR_API_KEY).toBe('worker-own');
    expect(Object.values(claude.projects).map((p: any) => p.mcpServers.db.env)).toEqual([{ DB_PASSWORD: '${DB_PASSWORD}' }]);
    expect(json(settings).env).toEqual({ HTTPS_PROXY: 'http://proxy:3128' });
    const codex = parseToml(read(toml)) as any;
    expect([codex.mcp_servers.github.env, codex.mcp_servers.github.env_vars, codex.model_providers.acme.http_headers]).toEqual([{}, ['GITHUB_TOKEN'], { 'X-Key': '' }]);
    expect(json(jsonc).provider.openai.options.apiKey).toBe('');
    expect(takeBackCopies(o)).toEqual([`left 1 key the mirror copied in ${worker.claudeJson}, which changed there since`]);
  });
  it('takeBackCopies removes a server copied whole, a plugin file holding a ticked key while each is still the copy, and a blob left beside the record; it leaves one the worker changed', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    editJson(mac.claudeJson, (j) => {
      j.mcpServers.odd = { command: 'odd', sandbox: { token: 'odd_token_1234567890' } };
      j.mcpServers.mine = { command: 'mine', sandbox: { token: 'mine_token_1234567890' } };
    });
    fs.appendFileSync(path.join(mac.codexDir, 'config.toml'), '\n[mcp_servers.tbl]\ncommand = "tbl"\nenv = { TBL_KEY = "tbl_key_1234567890" }\nlabel = "tbl"\n');
    put(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json'), JSON.stringify({ env: { ACME_KEY: 'acme_1234567890abcd' } }));
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    const consent = new Set([
      'claude:mcp:odd#command', 'claude:mcp:odd#sandbox', 'claude:mcp:mine#command', 'claude:mcp:mine#sandbox',
      'codex:mcp:tbl#command', 'codex:mcp:tbl#env', 'codex:mcp:tbl#label', 'claude:plugin:acme#env', 'claude:plugin:acme:mcp:pdf#env.PDF_KEY',
    ]);
    await packMirror(mirrorPlan(mac, consent), path.join(scratch, 'mirror.tar'));
    await unpack(path.join(scratch, 'mirror.tar'), path.join(scratch, 'blob'));
    await applyMirror(path.join(scratch, 'blob'), o);
    const toml = path.join(worker.codexDir, 'config.toml');
    const mcp = path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json');
    const settings = path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json');
    expect([json(worker.claudeJson).mcpServers.odd, (parseToml(read(toml)) as any).mcp_servers.tbl.label, read(mcp).includes('pdf_key_1234567890'), json(settings).env])
      .toEqual([{ command: 'odd', sandbox: { token: 'odd_token_1234567890' } }, 'tbl', true, { ACME_KEY: 'acme_1234567890abcd' }]);
    editJson(worker.claudeJson, (j) => { j.mcpServers.mine.command = 'mine-here'; });
    put(path.join(scratch, 'mirror-left/claude/.claude.json'), '{}');
    expect(takeBackCopies(o).sort()).toEqual([
      `removed 1 mirror blob left in ${scratch}`,
      `removed ${mcp}, which held keys the mirror copied`, `removed ${settings}, which held keys the mirror copied`,
      `took 1 server the mirror copied whole out of ${toml}`, `took 1 server the mirror copied whole out of ${worker.claudeJson}`,
      `left 1 server the mirror copied whole in ${worker.claudeJson}, which changed there since`,
    ].sort());
    expect(json(worker.claudeJson).mcpServers).not.toHaveProperty('odd');
    expect(json(worker.claudeJson).mcpServers.mine).toEqual({ command: 'mine-here', sandbox: { token: 'mine_token_1234567890' } });
    expect((parseToml(read(toml)) as any).mcp_servers).not.toHaveProperty('tbl');
    expect([fs.existsSync(mcp), fs.existsSync(settings), fs.existsSync(path.join(scratch, 'mirror-left'))]).toEqual([false, false, false]);
    expect(takeBackCopies(o)).toEqual([`left 1 server the mirror copied whole in ${worker.claudeJson}, which changed there since`]);
  });

  it('takeBackCopies leaves each copied value as an untick leaves it, by the kind of leaf its record keeps: a url, arg and header keep the rest, an env key its reference, in a server named env too', async () => {
    const mac = macHome();
    editJson(mac.claudeJson, (j) => {
      j.mcpServers.env = { type: 'http', url: 'https://x.test/mcp?token=tk_fake_1234567890&mode=a', headers: { 'X-Key': 'hk_fake_1234567890' } };
      j.mcpServers.cli = { command: 'cli', args: ['--api-key=ak_fake_1234567890', '--verbose'] };
    });
    fs.appendFileSync(path.join(mac.codexDir, 'config.toml'), '\n[mcp_servers.env]\nurl = "https://c.test/mcp?key=ck_fake_1234567890&v=1"\n');
    const consent = new Set([
      'claude:mcp:env#url.token', 'claude:mcp:env#headers.X-Key', 'claude:mcp:cli#args[--api-key]', 'claude:mcp:linear#env.LINEAR_API_KEY', 'codex:mcp:env#url.key',
      'codex:mcp:github#env.GITHUB_TOKEN', 'claude:settings#env.ANTHROPIC_API_KEY',
    ]);
    const scratch = makeHome();
    const blob = async (name: string, c: Set<string>) => {
      await packMirror(mirrorPlan(mac, c), path.join(scratch, `${name}.tar`));
      await unpack(path.join(scratch, `${name}.tar`), path.join(scratch, name));
      return path.join(scratch, name);
    };
    const [ticked, unticked] = [await blob('ticked', consent), await blob('unticked', new Set())];
    const taken = farHome();
    const untick = farHome();
    const at = (h: ReturnType<typeof farHome>) => ({ ...h, stateFile: path.join(h.homedir, 'state.json'), varsFile: path.join(h.homedir, 'vars.json') });
    await applyMirror(ticked, at(taken)); takeBackCopies(at(taken));
    await applyMirror(ticked, at(untick)); await applyMirror(unticked, at(untick));
    const docs = (h: ReturnType<typeof farHome>) => JSON.stringify([
      json(h.claudeJson).mcpServers, (parseToml(read(path.join(h.codexDir, 'config.toml'))) as any).mcp_servers, json(path.join(h.claudeDir, 'settings.json')).env,
    ]).replaceAll(h.homedir, '~');
    expect(docs(taken)).toEqual(docs(untick));
    expect(json(taken.claudeJson).mcpServers.env).toEqual({ type: 'http', url: 'https://x.test/mcp?token=&mode=', headers: { 'X-Key': '' } });
    expect((parseToml(read(path.join(taken.codexDir, 'config.toml'))) as any).mcp_servers.env).toEqual({ url: 'https://c.test/mcp?key=&v=' });
  });

  it('takeBackCopies empties a ticked key in place in a file the agent needs, where it lies there: a marketplace list the worker moved and updated keeps its marketplaces, a subagent its servers and prompt', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const source = { source: 'url', url: 'https://x.test/m.json', headers: { Authorization: 'Bearer mh_fake_1234567890' } };
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.extraKnownMarketplaces = { x: { source } }; });
    editJson(path.join(mac.claudeDir, 'plugins/known_marketplaces.json'), (j) => { j.x = { source, installLocation: path.join(mac.claudeDir, 'plugins/marketplaces/x') }; });
    put(path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json'), JSON.stringify({
      name: 'mp', plugins: [{ name: 'acme', source: './acme' }, { name: 'zip', source: { source: 'url', url: 'https://z.test/z.zip' }, headers: { Authorization: 'Bearer mk_fake_1234567890' } }],
    }));
    put(path.join(mac.claudeDir, 'agents/db.md'), ['---', 'name: db', 'mcpServers:', '  - github', '  - pg:', '      command: npx', '      env:', '        PG_PASSWORD: pg_fake_1234567890', '---', 'the agent', ''].join('\n'));
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    const consent = new Set(['claude:settings#extraKnownMarketplaces.x.source.headers.Authorization', 'claude:marketplace:mp#plugins.zip', 'claude:agent:db.md#mcpServers.pg']);
    await packMirror(mirrorPlan(mac, consent), path.join(scratch, 'mirror.tar'));
    await unpack(path.join(scratch, 'mirror.tar'), path.join(scratch, 'blob'));
    await applyMirror(path.join(scratch, 'blob'), o);
    const list = path.join(worker.claudeDir, 'plugins/known_marketplaces.json');
    const market = path.join(worker.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json');
    const agent = path.join(worker.claudeDir, 'agents/db.md');
    expect([read(list), read(market), read(agent)].map((t) => /mh_fake|mk_fake|pg_fake/.test(t))).toEqual([true, true, true]);
    // Claude on the worker updates its list itself
    editJson(list, (j) => { j.x.lastUpdated = '2026-10-27T00:00:00.000Z'; });
    expect(takeBackCopies(o).filter((l) => [list, market, agent].some((f) => l.endsWith(f))).sort()).toEqual([agent, list, market].map((f) => `took 1 key the mirror copied out of ${f}`).sort());
    expect(json(list)).toEqual({
      mp: expect.objectContaining({ installLocation: path.join(worker.claudeDir, 'plugins/marketplaces/mp') }),
      x: { source: { ...source, headers: { Authorization: '' } }, installLocation: path.join(worker.claudeDir, 'plugins/marketplaces/x'), lastUpdated: '2026-10-27T00:00:00.000Z' },
    });
    expect(json(market).plugins[1].headers).toEqual({ Authorization: '' });
    expect([agentServers(read(agent)), read(agent).startsWith('---\nname: db\n'), read(agent).endsWith('---\nthe agent\n')])
      .toEqual([[['pg', { command: 'npx', env: { PG_PASSWORD: '${PG_PASSWORD}' } }]], true, true]);
    expect(takeBackCopies(o).filter((l) => [list, market, agent].some((f) => l.includes(f)))).toEqual([]);
  });

  it('takeBackCopies takes a ticked key back where it alone lies now when an item added above moved it, and warns where the copy lies twice', async () => {
    const mac = macHome();
    const scratch = makeHome();
    const md = (...servers: string[]) => ['---', 'name: db', 'mcpServers:', '  - github', ...servers, '---', 'the agent', ''].join('\n');
    const pg = (name: string) => [`  - ${name}:`, '      command: npx', '      env:', '        PG_PASSWORD: pg_fake_1234567890'];
    const entries = (...extra: object[]) => JSON.stringify({ name: 'mp', plugins: [...extra, { name: 'zip', source: { source: 'url', url: 'https://z.test/z.zip' }, headers: { Authorization: 'Bearer mk_fake_1234567890' } }] });
    put(path.join(mac.claudeDir, 'agents/db.md'), md(...pg('pg')));
    put(path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json'), entries());
    await packMirror(mirrorPlan(mac, new Set(['claude:agent:db.md#mcpServers.pg', 'claude:marketplace:mp#plugins.zip'])), path.join(scratch, 'mirror.tar'));
    await unpack(path.join(scratch, 'mirror.tar'), path.join(scratch, 'blob'));
    const worker = async (twin: boolean) => {
      const h = farHome();
      const o = { ...h, stateFile: path.join(h.homedir, 'state.json'), varsFile: path.join(h.homedir, 'vars.json') };
      await applyMirror(path.join(scratch, 'blob'), o);
      const files = { agent: path.join(h.claudeDir, 'agents/db.md'), market: path.join(h.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json') };
      put(files.agent, md(...(twin ? pg('twin') : ['  - other:', '      command: x']), ...pg('pg')));
      put(files.market, entries({ name: 'new', source: './new' }));
      return { o, ...files };
    };
    const moved = await worker(false);
    expect(takeBackCopies(moved.o).filter((l) => [moved.agent, moved.market].some((f) => l.includes(f))).sort())
      .toEqual([moved.agent, moved.market].map((f) => `took 1 key the mirror copied out of ${f}`).sort());
    expect([/pg_fake/.test(read(moved.agent)), json(moved.market).plugins[1].headers]).toEqual([false, { Authorization: '' }]);
    const twins = await worker(true);
    expect(takeBackCopies(twins.o).filter((l) => l.includes(twins.agent))).toEqual([`left ${twins.agent}, which holds keys the mirror copied and changed there since`]);
    expect(read(twins.agent)).toContain('pg_fake');
  });

  it('takeBackCopies takes a ticked key back at its place and still names the file where the worker copied it below; a place left bare, empty or with references only says nothing', async () => {
    const mac = macHome();
    const scratch = makeHome();
    const md = (...servers: string[]) => ['---', 'name: db', 'mcpServers:', ...servers, '---', 'the agent', ''].join('\n');
    const pg = (name: string, v = 'pg_fake_1234567890') => [`  - ${name}:`, '      command: npx', '      env:', `        PG_PASSWORD: ${v}`];
    const source = { source: 'url', url: 'https://x.test/m.json', headers: { Authorization: 'Bearer mh_fake_1234567890' } };
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.extraKnownMarketplaces = { x: { source } }; });
    editJson(path.join(mac.claudeDir, 'plugins/known_marketplaces.json'), (j) => { j.x = { source, installLocation: path.join(mac.claudeDir, 'plugins/marketplaces/x') }; });
    put(path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json'), JSON.stringify({
      name: 'mp', plugins: [{ name: 'zip', source: { source: 'url', url: 'https://z.test/z.zip' }, headers: { Authorization: 'Bearer mk_fake_1234567890' } }],
    }));
    put(path.join(mac.claudeDir, 'agents/db.md'), md(...pg('pg')));
    const consent = new Set(['claude:settings#extraKnownMarketplaces.x.source.headers.Authorization', 'claude:marketplace:mp#plugins.zip', 'claude:agent:db.md#mcpServers.pg']);
    await packMirror(mirrorPlan(mac, consent), path.join(scratch, 'mirror.tar'));
    await unpack(path.join(scratch, 'mirror.tar'), path.join(scratch, 'blob'));
    const worker = async () => {
      const h = farHome();
      const o = { ...h, stateFile: path.join(h.homedir, 'state.json'), varsFile: path.join(h.homedir, 'vars.json') };
      await applyMirror(path.join(scratch, 'blob'), o);
      const files = {
        list: path.join(h.claudeDir, 'plugins/known_marketplaces.json'), market: path.join(h.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json'),
        agent: path.join(h.claudeDir, 'agents/db.md'),
      };
      return { o, ...files, lines: () => takeBackCopies(o).filter((l) => Object.values(files).some((f) => l.includes(f))) };
    };
    const below = await worker();
    put(below.agent, md(...pg('pg'), ...pg('twin')));
    expect(below.lines().sort()).toEqual([
      `left ${below.agent}, which holds keys the mirror copied and changed there since`, ...[below.agent, below.list, below.market].map((f) => `took 1 key the mirror copied out of ${f}`),
    ].sort());
    expect(agentServers(read(below.agent))).toEqual([['pg', { command: 'npx', env: { PG_PASSWORD: '${PG_PASSWORD}' } }], ['twin', { command: 'npx', env: { PG_PASSWORD: 'pg_fake_1234567890' } }]]);
    const bare = await worker();
    put(bare.agent, md(...pg('pg', '${PG_PASSWORD}')));
    editJson(bare.market, (j) => { j.plugins[0].headers.Authorization = ''; });
    editJson(bare.list, (j) => { j.x.source.headers.Authorization = 'Bearer ${MK_TOKEN}'; });
    expect(bare.lines()).toEqual([]);
  });

  it('takeBackCopies says nothing of a key the worker set itself where the user unticked the copy, nor of a record without the bare form of its value', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    const apply = async (name: string, consent: Set<string>) => {
      await packMirror(mirrorPlan(mac, consent), path.join(scratch, `${name}.tar`));
      await unpack(path.join(scratch, `${name}.tar`), path.join(scratch, name));
      await applyMirror(path.join(scratch, name), o);
    };
    await apply('ticked', new Set(['claude:mcp:linear#env.LINEAR_API_KEY']));
    editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = 'worker-own'; });
    await apply('unticked', new Set());
    expect(json(worker.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('worker-own');
    expect(takeBackCopies(o)).toEqual([]);
    editJson(worker.claudeJson, (j) => { j.mcpServers.cli = { command: 'cli', args: ['--api-key='] }; });
    put(o.stateFile, JSON.stringify({ files: {}, docs: {}, servers: {}, secrets: { [JSON.stringify(['.claude.json', 'mcpServers', 'cli', 'args', 0])]: sha256Hex('--api-key=ak_fake_1234567890') } }));
    expect(takeBackCopies(o)).toEqual([]);
  });
});
