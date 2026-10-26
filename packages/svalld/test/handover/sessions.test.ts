import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, FleetConfig, TRANSFER_SCHEMA_VERSION, type AgentKind, type Robot, type MachineId, type TransferSession } from '@svall/protocol';
import { applyHook } from '../../src/agent/reducer.js';
import { buildInventory, type MachineMaps } from '../../src/handover/inventory.js';
import { realStages } from '../../src/durable.js';
import { buildManifest } from '../../src/handover/manifest.js';
import { importState } from '../../src/handover/validate.js';
import { opencodeAdapter } from '../../src/sessions/opencode.js';
import { agentBlockers, cliRunner, installSession, placeTranscripts, realInstallFs, type AgentProbe, type InstallFs } from '../../src/sessions/registry.js';
import type { CliRun } from '../../src/sessions/types.js';
import { fakeEnv, held, hold, type Exported } from '../sessions/fake-opencode.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/handover');
const made: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync('/tmp/svall-s-')); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const lines = (data: Buffer | string): string[] => data.toString().split('\n').filter(Boolean);
const rows = (data: Buffer | string): Record<string, any>[] => lines(data).map((l) => JSON.parse(l));
const sha = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

// the real sessions each release wrote, sanitized
const CLAUDE = [
  { version: '2.1.280', id: 'bf480ea6-5572-4554-8016-2dc5590f5bba', slug: '-Users-source-work-demo', agent: 'agent-a4906877eb9919cf5' },
  { version: '2.1.251', id: '1fb0d1a7-29a9-4159-a932-5ffd2da8faba', slug: '-home-source-work-demo', agent: 'agent-aec6de8cd1d2df280' },
  { version: '2.1.306', id: 'e6b13e68-3d40-4759-91a3-5c1cde740f9d', slug: '-Users-source-work-demo', agent: 'agent-a1774cad8a601f106' },
] as const;
const CODEX = [
  // written before the oldest Codex Svall runs, so the CLI that carries it has been updated since
  { version: '0.155.1', cli: '0.156.0', file: 'sessions/2026/09/23/rollout-2026-09-23T08-44-38-01a0cd02-5930-73f0-ad55-add2b1effa04.jsonl', id: '01a0cd02-5930-73f0-ad55-add2b1effa04' },
  { version: '0.156.1', file: 'sessions/2026/09/23/rollout-2026-09-23T08-44-52-01a0cd02-8ea0-75c1-89b3-89718ecbd91f.jsonl', id: '01a0cd02-8ea0-75c1-89b3-89718ecbd91f' },
  { version: '0.162.1', file: 'sessions/2026/10/21/rollout-2026-10-21T20-28-35-01a15fb8-ddb3-7720-9bbc-6558d68e05f4.jsonl', id: '01a15fb8-ddb3-7720-9bbc-6558d68e05f4' },
] as const;

const MAC = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const FLEET = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' });

function robot(id: string, o: Partial<Robot>): Robot {
  return {
    id, islandId: 'i1', cell: { x: 0, y: 0 }, name: id, note: '', portrait: 'fox', instructions: '', cwd: '/',
    context: [], shell: { lastOutputAt: 0 }, unread: false, ...o,
  };
}

/**
 * A source machine whose home is a temp folder: one robot running the real 2.1.280 Claude session in its
 * first terminal and the real 0.155.1 Codex rollout in its second, both made under a home of `/Users/source`.
 */
function machines(homes?: MachineMaps['destination']['agentHomes']) {
  const base = tmp();
  const mac = path.join(base, 'Users/source');
  const work = path.join(mac, 'work/demo');
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'claude/2.1.280'), path.join(mac, '.claude'), { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'codex/0.155.1'), path.join(mac, '.codex'), { recursive: true });
  const agentHomes = homes ?? { claude: path.join(mac, '.claude'), codex: path.join(mac, '.codex') };
  const maps: MachineMaps = {
    source: { machineId: MAC, home: mac, fleetHome: path.join(mac, '.svall') },
    destination: { machineId: TRIFT, home: mac, fleetHome: path.join(mac, '.svall'), agentHomes },
  };
  const state = emptyState();
  state.robots.c1 = robot('c1', {
    cwd: work,
    agent: { kind: 'claude', sessionId: CLAUDE[0].id, transcriptPath: path.join(mac, '.claude/projects', CLAUDE[0].slug, `${CLAUDE[0].id}.jsonl`), status: 'idle', lastActivityAt: 0 },
    second: { cwd: work, unread: false, agent: { kind: 'codex', sessionId: CODEX[0].id, transcriptPath: path.join(mac, '.codex', CODEX[0].file), status: 'idle', lastActivityAt: 0 } },
  });
  return { base, mac, work, maps, state };
}

describe('sessions in the transfer manifest', () => {
  it('lists every file of each session apart from the roots, and lands each transcript where it was', async () => {
    const m = machines();
    const { manifest, blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([]);
    const [claude, codex] = manifest.sessions;
    const { id, slug, agent } = CLAUDE[0];
    expect(claude).toMatchObject({
      robotId: 'c1', agent: 'claude', sessionId: id, adapter: 1,
      sourceHome: path.join(m.mac, '.claude'), destinationHome: path.join(m.mac, '.claude'), destinationPath: claude.sourcePath,
    });
    expect(claude.files.map((f) => f.path)).toEqual([
      `projects/${slug}/${id}.jsonl`, `projects/${slug}/${id}/subagents/${agent}.jsonl`, `projects/${slug}/${id}/subagents/${agent}.meta.json`,
    ]);
    const transcript = fs.readFileSync(claude.sourcePath);
    expect(claude.files[0]).toMatchObject({ type: 'file', size: transcript.length, sha256: sha(transcript) });
    expect(codex).toMatchObject({
      robotId: 'c1', term: 2, agent: 'codex', adapter: 1, sourceHome: path.join(m.mac, '.codex'),
      destinationPath: path.join(m.mac, '.codex', CODEX[0].file), files: [expect.objectContaining({ path: CODEX[0].file })],
    });
    // no session file becomes a root, and nothing under an agent home is mirrored
    expect(manifest.roots.map((r) => r.path)).toEqual([m.work]);
  });

  it('carries a session a CLI newer than every fixture wrote, whatever its records hold', async () => {
    const m = machines();
    const transcript = m.state.robots.c1.agent!.transcriptPath!;
    const rollout = m.state.robots.c1.second!.agent!.transcriptPath!;
    fs.writeFileSync(transcript, `${fs.readFileSync(transcript, 'utf8').replaceAll('"version":"2.1.280"', '"version":"2.9.0"')}{"type":"holodeck","version":"2.9.0","attachment":{"type":"telepathy"},"scratchDir":"/Users/source/w"}\n`);
    fs.writeFileSync(rollout, `${fs.readFileSync(rollout, 'utf8').replaceAll('"cli_version":"0.155.1"', '"cli_version":"0.170.0"')}{"timestamp":"t","type":"hologram","payload":{"scratch_root":"/Users/source/w/.x"}}\n`);
    const { manifest, blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([]);
    expect(manifest.sessions.map((s) => s.files[0])).toEqual([transcript, rollout].map((f) => expect.objectContaining({ sha256: sha(fs.readFileSync(f)) })));
  });

  it('blocks a session the destination has no agent home for', async () => {
    const m = machines({ codex: '/Users/target/.codex' });
    const { manifest, blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([expect.objectContaining({ code: 'agent_cli_missing', entity: { kind: 'robot', id: 'c1' } })]);
    expect(manifest.sessions.find((s) => s.agent === 'claude')?.destinationPath).toBeUndefined();
  });

  it('blocks a transcript that is gone', async () => {
    const m = machines();
    fs.rmSync(m.state.robots.c1.second!.agent!.transcriptPath!);
    const { blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([expect.objectContaining({ code: 'transcript_missing', entity: { kind: 'robot', id: 'c1' } })]);
  });
});

// each fixture session, where its CLI keeps it under the agent home
const FIXTURE_SESSIONS = [
  ...CLAUDE.map((c) => ({ kind: 'claude' as AgentKind, version: c.version, cli: c.version as string, id: c.id, agentHome: '.claude', transcript: `projects/${c.slug}/${c.id}.jsonl`, newer: '2.2.0' })),
  ...CODEX.map((c) => ({ kind: 'codex' as AgentKind, version: c.version, cli: 'cli' in c ? c.cli : c.version, id: c.id, agentHome: '.codex', transcript: c.file, newer: '0.163.0' })),
];

describe.each(FIXTURE_SESSIONS)('a $kind session as $version wrote it', ({ kind, version, cli, id, agentHome, transcript, newer }) => {
  it('arrives byte for byte at the transcript path its terminal recorded, for a newer CLI there to resume', async () => {
    const base = tmp();
    const mac = path.join(base, 'Users/source');
    const agents = path.join(mac, agentHome);
    fs.cpSync(path.join(FIXTURES, kind, version), agents, { recursive: true });
    const transcriptPath = path.join(agents, transcript);
    const state = emptyState();
    state.robots.c1 = robot('c1', { cwd: mac, agent: { kind, sessionId: id, transcriptPath, status: 'idle', lastActivityAt: 0 } });
    const at = { home: mac, fleetHome: path.join(mac, '.svall') };
    const { manifest, blockers } = await buildManifest(buildInventory(state, { fleet: FLEET }, {
      source: { machineId: MAC, ...at }, destination: { machineId: TRIFT, ...at, agentHomes: { [kind]: agents } },
    }), { generation: 1 });
    expect(blockers).toEqual([]);
    const probe = (v: string): AgentProbe => ({ kind, version: v, home: agents, loggedIn: true, hooks: true });
    expect(agentBlockers({ kinds: [kind], source: [probe(cli)], destination: [probe(newer)] })).toEqual([]);

    // the source's tree set aside, as the other machine never had it, and its session staged as rsync stages it
    const parked = path.join(base, 'parked');
    fs.renameSync(mac, parked);
    const staged = path.join(parked, agentHome);
    const [session] = manifest.sessions;
    expect(installSession(session, staged)).toEqual({ transcriptPath });
    for (const f of session.files) expect(fs.readFileSync(path.join(agents, f.path)), f.path).toEqual(fs.readFileSync(path.join(staged, f.path)));
    expect(placeTranscripts(manifest.snapshot, manifest.sessions).robots.c1.agent!.transcriptPath).toBe(transcriptPath);
  });
});

describe('a session arriving on the destination', () => {
  // the manifest the source built, the source's bytes staged at their manifest paths, and a destination home
  async function arrival(before?: (m: ReturnType<typeof machines>) => void) {
    const m = machines({ claude: path.join(tmp(), 'dest/.claude'), codex: path.join(tmp(), 'dest/.codex') });
    before?.(m);
    const { manifest } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    const stage = (s: TransferSession): string => {
      const dir = path.join(tmp(), 'staged');
      for (const f of s.files) fs.cpSync(path.join(s.sourceHome!, f.path), path.join(dir, f.path));
      return dir;
    };
    return { m, manifest, stage, claude: manifest.sessions[0], codex: manifest.sessions[1] };
  }

  it('lands under the destination agent home at the place it had under the source\'s, byte for byte', async () => {
    const { m, claude, codex, stage } = await arrival((source) => {
      // a record naming a folder under the source's agent home, which the destination keeps elsewhere
      const t = source.state.robots.c1.agent!.transcriptPath!;
      fs.appendFileSync(t, `${JSON.stringify({ type: 'user', cwd: path.join(source.mac, '.claude/plans'), version: '2.1.280', message: {} })}\n`);
    });
    const { id, slug } = CLAUDE[0];
    const staged = stage(claude);
    expect(installSession(claude, staged)).toEqual({ transcriptPath: claude.destinationPath });
    const project = path.join(claude.destinationHome!, 'projects', slug);
    expect(claude.destinationPath).toBe(path.join(project, `${id}.jsonl`));
    for (const f of claude.files) expect(fs.readFileSync(path.join(claude.destinationHome!, f.path)), f.path).toEqual(fs.readFileSync(path.join(staged, f.path)));
    expect(rows(fs.readFileSync(claude.destinationPath!)).at(-1)!.cwd).toBe(path.join(m.mac, '.claude/plans'));
    expect(fs.statSync(path.join(project, `${id}.jsonl`)).mode & 0o777).toBe(0o600);
    expect(installSession(codex, stage(codex))).toEqual({ transcriptPath: `${codex.destinationHome}/${CODEX[0].file}` });
    expect(fs.readFileSync(codex.destinationPath!)).toEqual(fs.readFileSync(codex.sourcePath));
  });

  it('carries a file of a kind no release so far wrote in the session\'s folder, byte for byte', async () => {
    const { id, slug } = CLAUDE[0];
    const stray = `projects/${slug}/${id}/auto-mode-classifier-error.txt`;
    const { claude, stage } = await arrival((m) => { fs.writeFileSync(path.join(m.mac, '.claude', stray), 'classifier said no'); });
    expect(claude.files.map((f) => f.path)).toContain(stray);
    installSession(claude, stage(claude));
    expect(fs.readFileSync(path.join(claude.destinationHome!, stray), 'utf8')).toBe('classifier said no');
  });

  it('keeps a copy already there when it is the same, and replaces one the incoming session only adds to', async () => {
    const { claude, stage } = await arrival();
    const staged = stage(claude);
    installSession(claude, staged);
    const placed = claude.destinationPath!;
    const full = fs.readFileSync(placed);
    installSession(claude, staged);
    expect(fs.readFileSync(placed)).toEqual(full);
    // a round trip: the destination still holds the older copy it handed away, which the session has since grown past
    fs.writeFileSync(placed, full.subarray(0, full.indexOf('\n', full.length / 2) + 1));
    installSession(claude, staged);
    expect(fs.readFileSync(placed)).toEqual(full);
  });

  it('refuses a copy the destination continued on its own, and writes nothing', async () => {
    const { claude, stage } = await arrival();
    const staged = stage(claude);
    installSession(claude, staged);
    const placed = claude.destinationPath!;
    fs.appendFileSync(placed, '{"type":"user","version":"2.1.280","message":{"content":"a turn taken here"}}\n');
    const meta = path.join(path.dirname(placed), CLAUDE[0].id, 'subagents', `${CLAUDE[0].agent}.meta.json`);
    fs.rmSync(meta);
    const before = fs.readFileSync(placed);
    expect(() => installSession(claude, staged)).toThrow(expect.objectContaining({
      code: 'destination_diverged', message: `the destination's Claude Code went on with session ${CLAUDE[0].id} past the copy coming in: ${placed}`,
    }));
    expect(fs.readFileSync(placed)).toEqual(before);
    expect(fs.existsSync(meta)).toBe(false);
  });

  it('refuses staged bytes that are not the ones the manifest names', async () => {
    const { codex, stage } = await arrival();
    const staged = stage(codex);
    fs.appendFileSync(path.join(staged, codex.files[0].path), '\n');
    expect(() => installSession(codex, staged)).toThrow(/manifest/);
    expect(fs.existsSync(codex.destinationPath!)).toBe(false);
  });

  it('refuses a manifest that names a file outside the agent home', async () => {
    const { codex, stage } = await arrival();
    const staged = stage(codex);
    expect(() => installSession({ ...codex, files: [{ ...codex.files[0], path: '../../escape.jsonl' }] }, staged))
      .toThrow(expect.objectContaining({ code: 'path_unsupported' }));
    expect(() => installSession({ ...codex, destinationPath: '/elsewhere/rollout.jsonl' }, staged))
      .toThrow(expect.objectContaining({ code: 'path_unsupported' }));
    expect(fs.existsSync(codex.destinationPath!)).toBe(false);
  });

  it("writes nothing when a manifest names a file outside its session's own layout", async () => {
    const { claude, codex, stage } = await arrival();
    const { id, slug } = CLAUDE[0];
    // a file of the manifest's choosing, staged with the bytes its entry names
    const naming = (s: TransferSession, staged: string, rel: string): TransferSession => {
      const data = Buffer.from('{"note":"not a session file"}\n');
      fs.mkdirSync(path.dirname(path.join(staged, rel)), { recursive: true });
      fs.writeFileSync(path.join(staged, rel), data);
      return { ...s, files: [...s.files, { type: 'file', path: rel, mode: 0o600, size: data.length, mtimeMs: 0, sha256: sha(data) }] };
    };
    const refused = (s: TransferSession, staged: string) => expect(() => installSession(s, staged)).toThrow(expect.objectContaining({ code: 'path_unsupported' }));
    const claudeStaged = stage(claude);
    for (const rel of [
      'CLAUDE.md', 'skills/x/SKILL.md', 'settings.json', `file-history/${id}/abc@v1`, `projects/${slug}/99999999-2222-4333-8444-555555555555.jsonl`,
      `projects/-elsewhere/${id}/tool-results/b1.txt`,
    ]) refused(naming(claude, claudeStaged, rel), claudeStaged);
    refused({ ...claude, destinationPath: path.join(claude.destinationHome!, 'CLAUDE.md') }, claudeStaged);
    refused({ ...claude, destinationPath: path.join(claude.destinationHome!, `projects/${slug}/99999999-2222-4333-8444-555555555555.jsonl`) }, claudeStaged);
    refused({ ...claude, destinationPath: path.join(claude.destinationHome!, `projects/-elsewhere/${id}.jsonl`) }, claudeStaged);
    const codexStaged = stage(codex);
    const another = 'sessions/2026/09/23/rollout-2026-09-23T08-44-38-99999999-2222-4333-8444-555555555555.jsonl';
    for (const rel of ['hooks.json', 'config.toml', another]) refused(naming(codex, codexStaged, rel), codexStaged);
    for (const rel of ['hooks.json', another]) refused({ ...codex, destinationPath: path.join(codex.destinationHome!, rel) }, codexStaged);
    expect(fs.existsSync(claude.destinationHome!)).toBe(false);
    expect(fs.existsSync(codex.destinationHome!)).toBe(false);
  });

  it('places the transcript last, so a retry after its write failed finishes the job', async () => {
    const { claude, stage } = await arrival();
    const staged = stage(claude);
    const placed = claude.destinationPath!;
    const { id, agent } = CLAUDE[0];
    const sidecars = ['jsonl', 'meta.json'].map((ext) => path.join(path.dirname(placed), id, 'subagents', `${agent}.${ext}`));
    const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const failing: InstallFs = {
      ...realInstallFs,
      stages: { open: (file, mode) => { if (file.startsWith(`${placed}.durable-`)) throw full; return realStages.open(file, mode); } },
    };
    expect(() => installSession(claude, staged, failing)).toThrow(full);
    expect(sidecars.every((f) => fs.existsSync(f))).toBe(true);
    expect(fs.readdirSync(path.dirname(placed))).toEqual([id]);

    const written: string[] = [];
    const retry: InstallFs = { ...realInstallFs, stages: { rename: (from, to) => { written.push(to); fs.renameSync(from, to); } } };
    expect(installSession(claude, staged, retry)).toEqual({ transcriptPath: placed });
    // the sidecars already there were the same, so only the transcript was written
    expect(written).toEqual([placed]);
    for (const f of claude.files) expect(fs.readFileSync(path.join(claude.destinationHome!, f.path)), f.path).toEqual(fs.readFileSync(path.join(staged, f.path)));
    expect(fs.readdirSync(path.dirname(placed)).sort()).toEqual([`${id}.jsonl`, id].sort());
  });

  it('points each imported agent at its placed transcript before anything starts', async () => {
    const { m, manifest } = await arrival();
    const placed = placeTranscripts(manifest.snapshot, manifest.sessions);
    expect(placed.robots.c1.agent!.transcriptPath).toBe(manifest.sessions[0].destinationPath);
    expect(placed.robots.c1.second!.agent!.transcriptPath).toBe(manifest.sessions[1].destinationPath);
    expect(manifest.snapshot.robots.c1.agent!.transcriptPath).toBe(m.state.robots.c1.agent!.transcriptPath);
    expect(() => placeTranscripts(manifest.snapshot, manifest.sessions.slice(1))).toThrow(/c1/);
  });
});

describe('OpenCode sessions', () => {
  const ID = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
  const session = (directory: string, texts: string[]): Exported => ({ info: { id: ID, location: { directory } }, messages: texts.map((text, i) => ({ id: `msg_${i}`, text })) });
  const turn = (text: string): string => `${JSON.stringify({ kind: 'user', text })}\n`;
  // as prepare reads a session in: any copy here is kept aside and goes first, then the incoming one is imported
  const readIn = async (file: string, cwd: string, run: CliRun): Promise<void> => {
    const keep = path.join(tmp(), 'kept.json');
    await opencodeAdapter.dropSession!(ID, file, cwd, run, keep);
    await opencodeAdapter.importSession!(ID, file, cwd, run);
  };

  /** One machine: its OpenCode, keeping sessions in a database of its own, and the folder Svall's plugin logs each session in. */
  function side(base: string, name: string): { env: NodeJS.ProcessEnv; run: CliRun; logs: string } {
    const env = fakeEnv(path.join(base, `${name}-opencode`));
    const logs = path.join(base, name, '.svall/transcripts/opencode');
    fs.mkdirSync(logs, { recursive: true });
    return { env, run: cliRunner(env), logs };
  }

  /** The session leaving `from` for `to`: written out of `from`'s OpenCode, read into a manifest and staged as rsync stages it. */
  async function leaving(from: ReturnType<typeof side>, to: ReturnType<typeof side>, work: string, transcriptPath: string) {
    await opencodeAdapter.exportSession!(ID, path.join(from.logs, opencodeAdapter.exportFile!(ID)), from.run, work);
    const state = emptyState();
    state.robots.c1 = robot('c1', { cwd: work, agent: { kind: 'opencode', sessionId: ID, transcriptPath, status: 'idle', lastActivityAt: 0 } });
    const at = { home: work, fleetHome: path.dirname(path.dirname(from.logs)) };
    const { manifest, blockers } = await buildManifest(buildInventory(state, { fleet: FLEET }, {
      source: { machineId: MAC, ...at }, destination: { machineId: TRIFT, ...at, agentHomes: { opencode: to.logs } },
    }), { generation: 1 });
    expect(blockers).toEqual([]);
    const [s] = manifest.sessions;
    const stage = tmp();
    for (const f of s.files) fs.cpSync(path.join(s.sourceHome!, f.path), path.join(stage, f.path));
    return { manifest, session: s, stage, exported: path.join(stage, opencodeAdapter.exportFile!(ID)) };
  }

  it('hands a session to another machine and back, each time in the folder its terminal resumes in, over the stale copy left there', async () => {
    const base = tmp();
    const [mac, linux] = [side(base, 'mac'), side(base, 'linux')];
    const work = path.join(base, 'work');
    fs.mkdirSync(work);
    hold(mac.env, session('/elsewhere', ['remember PELICAN-42']));
    const macLog = path.join(mac.logs, `${ID}.jsonl`);
    fs.writeFileSync(macLog, turn('remember PELICAN-42'));

    const away = await leaving(mac, linux, work, macLog);
    expect(away.session.files.map((f) => f.path)).toEqual([`${ID}.jsonl`, `exports/${ID}.json`]);
    expect(installSession(away.session, away.stage)).toEqual({ transcriptPath: path.join(linux.logs, `${ID}.jsonl`) });
    // the export is read back in, never placed
    expect(fs.readdirSync(linux.logs)).toEqual([`${ID}.jsonl`]);
    await readIn(away.exported, work, linux.run);
    expect(held(linux.env)[ID]).toEqual(session(work, ['remember PELICAN-42']));

    // the session goes on there, and comes back to a Mac that still holds the copy it handed away
    hold(linux.env, session(work, ['remember PELICAN-42', 'what was the codeword?']));
    fs.appendFileSync(path.join(linux.logs, `${ID}.jsonl`), turn('what was the codeword?'));
    const back = await leaving(linux, mac, work, path.join(linux.logs, `${ID}.jsonl`));
    expect(installSession(back.session, back.stage)).toEqual({ transcriptPath: macLog });
    expect(fs.readFileSync(macLog, 'utf8')).toBe(turn('remember PELICAN-42') + turn('what was the codeword?'));
    await readIn(back.exported, work, mac.run);
    expect(held(mac.env)[ID]).toEqual(session(work, ['remember PELICAN-42', 'what was the codeword?']));
    // and again, as a retried prepare would
    await readIn(back.exported, work, mac.run);
    expect(Object.keys(held(mac.env))).toEqual([ID]);
  });

  it('refuses an import OpenCode answers with "Session already exists", which it exits 0 on, and one it cannot make', async () => {
    const base = tmp();
    const [mac, linux] = [side(base, 'mac'), side(base, 'linux')];
    const work = path.join(base, 'work');
    fs.mkdirSync(work);
    hold(mac.env, session(work, ['one', 'two']));
    fs.writeFileSync(path.join(mac.logs, `${ID}.jsonl`), turn('one'));
    const { exported } = await leaving(mac, linux, work, path.join(mac.logs, `${ID}.jsonl`));
    hold(linux.env, session(work, ['one']));
    const keeping: CliRun = (cmd, args, o) => (args[1] === 'delete' ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) : linux.run(cmd, args, o));
    await expect(readIn(exported, work, keeping))
      .rejects.toMatchObject({ code: 'transcript_missing', message: expect.stringContaining('Session already exists') });
    expect(held(linux.env)[ID]).toEqual(session(work, ['one']));
    await expect(opencodeAdapter.importSession!(ID, exported, path.join(base, 'gone'), linux.run)).rejects.toMatchObject({ code: 'transcript_missing' });
  });

  it('refuses to replace a copy this machine went on with outside Svall, and keeps it', async () => {
    const base = tmp();
    const [mac, linux] = [side(base, 'mac'), side(base, 'linux')];
    const work = path.join(base, 'work');
    fs.mkdirSync(work);
    hold(mac.env, session(work, ['one', 'two']));
    fs.writeFileSync(path.join(mac.logs, `${ID}.jsonl`), turn('one'));
    const { exported } = await leaving(mac, linux, work, path.join(mac.logs, `${ID}.jsonl`));
    // resumed there with a plain `opencode -s`, which Svall's log never saw
    const went = { ...session(work, ['one']), messages: [{ id: 'msg_0', text: 'one' }, { id: 'msg_x', text: 'asked by hand' }] };
    hold(linux.env, went);
    const diverged = { code: 'destination_diverged', message: `the destination's OpenCode went on with session ${ID} past the copy coming in` };
    await expect(opencodeAdapter.checkSession!(ID, exported, work, linux.run)).rejects.toMatchObject(diverged);
    await expect(readIn(exported, work, linux.run)).rejects.toMatchObject(diverged);
    expect(held(linux.env)[ID]).toEqual(went);
  });

  it('refuses to replace a copy here that holds every message of the incoming one and more, and keeps it', async () => {
    const base = tmp();
    const [mac, linux] = [side(base, 'mac'), side(base, 'linux')];
    const work = path.join(base, 'work');
    fs.mkdirSync(work);
    hold(mac.env, session(work, ['one', 'two']));
    fs.writeFileSync(path.join(mac.logs, `${ID}.jsonl`), turn('one'));
    const { exported } = await leaving(mac, linux, work, path.join(mac.logs, `${ID}.jsonl`));
    const longer = session(work, ['one', 'two', 'three']);
    hold(linux.env, longer);
    await expect(opencodeAdapter.checkSession!(ID, exported, work, linux.run)).rejects.toMatchObject({ code: 'destination_diverged' });
    await expect(readIn(exported, work, linux.run)).rejects.toMatchObject({ code: 'destination_diverged' });
    expect(held(linux.env)[ID]).toEqual(longer);
  });

  it('refuses a session that came without its export, and writes nothing', async () => {
    const base = tmp();
    const [mac, linux] = [side(base, 'mac'), side(base, 'linux')];
    hold(mac.env, session(base, ['one']));
    fs.writeFileSync(path.join(mac.logs, `${ID}.jsonl`), turn('one'));
    const { session: s, stage } = await leaving(mac, linux, base, path.join(mac.logs, `${ID}.jsonl`));
    expect(() => installSession({ ...s, files: s.files.slice(0, 1) }, stage)).toThrow(expect.objectContaining({ code: 'transcript_missing' }));
    expect(fs.readdirSync(linux.logs)).toEqual([]);
  });
});

describe('the resume a carried terminal keeps', () => {
  const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
  const record = (cwd: string, text: string): string =>
    `${JSON.stringify({ type: 'user', cwd, sessionId: SID, version: '2.1.280', message: { role: 'user', content: text } })}\n`;

  it('keeps the resume a terminal went dormant with, flags and all, in either terminal, whether this handover rested it or not', async () => {
    const home = path.join(tmp(), 'home');
    const claude = path.join(home, '.claude');
    const cwd = path.join(home, 'code/gamma');
    fs.mkdirSync(cwd, { recursive: true });
    const SID2 = '7c1d9e2f-3a4b-4c5d-8e6f-0a1b2c3d4e5f';
    const agent = (sessionId: string): Robot['agent'] => {
      const transcriptPath = path.join(claude, 'projects', '-home-code-gamma', `${sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, record(cwd, 'one'));
      return { kind: 'claude', sessionId, transcriptPath, status: 'idle', lastActivityAt: 0 };
    };
    const closed = (sessionId: string) => `claude --dangerously-skip-permissions --effort high --resume ${sessionId}`;
    const imported = async (restedBy?: string, secondAgent = true) => {
      const state = emptyState();
      state.robots.c1 = robot('c1', {
        cwd, agent: agent(SID), revive: { command: closed(SID) }, restedBy,
        second: { cwd, unread: false, ...(secondAgent && { agent: agent(SID2) }), revive: { command: closed(SID2) }, restedBy },
      });
      const inventory = buildInventory(state, { fleet: FLEET }, {
        source: { machineId: MAC, home, fleetHome: path.join(home, '.svall') },
        destination: { machineId: TRIFT, home, fleetHome: path.join(home, '.svall'), agentHomes: { claude } },
      });
      const { manifest } = await buildManifest(inventory, { generation: 1 });
      const c = importState({ ...manifest, transactionId: 't1' }).state.robots.c1;
      return [c.revive, c.second?.revive];
    };
    expect(await imported()).toEqual([{ command: closed(SID) }, { command: closed(SID2) }]);
    expect(await imported('t1')).toEqual([{ command: closed(SID) }, { command: closed(SID2) }]);
    // a second terminal whose agent is gone carries no session, so it opens as a plain shell
    expect(await imported(undefined, false)).toEqual([{ command: closed(SID) }, { command: '' }]);
  });

  it('takes the new session a resumed agent starts, whatever process on the destination holds the pid its source recorded', async () => {
    const home = path.join(tmp(), 'home');
    const claude = path.join(home, '.claude');
    const cwd = path.join(home, 'code/gamma');
    const transcriptPath = path.join(claude, 'projects', '-home-code-gamma', `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(transcriptPath, record(cwd, 'one'));
    // the source's agents ran as pids that name a live process here, this test's own
    const agent = { kind: 'claude' as const, sessionId: SID, transcriptPath, status: 'idle' as const, lastActivityAt: 0, pid: process.pid };
    const state = emptyState();
    state.robots.c1 = robot('c1', { cwd, agent, revive: { command: `claude --resume ${SID}` }, second: { cwd, unread: false, agent, revive: { command: `claude --resume ${SID}` } } });
    const inventory = buildInventory(state, { fleet: FLEET }, {
      source: { machineId: MAC, home, fleetHome: path.join(home, '.svall') },
      destination: { machineId: TRIFT, home, fleetHome: path.join(home, '.svall'), agentHomes: { claude } },
    });
    const { manifest } = await buildManifest(inventory, { generation: 1 });
    const c = importState({ ...manifest, transactionId: 't1' }).state.robots.c1;
    const NEW = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    for (const [slot, term] of [[c, undefined], [c.second!, 2]] as const) {
      const next = applyHook(slot, { robotId: 'c1', backend: 'claude', name: 'SessionStart', sessionId: NEW, pid: 999_999, ...(term && { term }) }, 5);
      expect(next.agent).toMatchObject({ sessionId: NEW, pid: 999_999 });
    }
  });

  it('leaves behind the codex flags that name the source machine\'s own config: a profile and a local provider', () => {
    const state = emptyState();
    const codex = (command: string): Partial<Robot> => ({
      agent: { kind: 'codex', sessionId: SID, transcriptPath: '/h/.codex/r.jsonl', status: 'idle', lastActivityAt: 0 }, revive: { command },
    });
    state.robots.c1 = robot('c1', { cwd: '/h', ...codex(`codex resume -c tui.resume_cwd=session --yolo -m 'gpt-6-astra' -p 'work' --local-provider 'ollama' -s 'workspace-write' ${SID}`) });
    state.robots.c2 = robot('c2', { cwd: '/h', ...codex(`codex resume -c tui.resume_cwd=session --profile 'work' ${SID}`) });
    state.robots.c3 = robot('c3', { cwd: '/h', agent: { kind: 'claude', sessionId: SID, transcriptPath: '/h/.claude/r.jsonl', status: 'idle', lastActivityAt: 0 }, revive: { command: `claude --effort 'high' --resume ${SID}` } });
    // the flags remembered at a start are read again from the process the destination starts, never carried
    state.robots.c4 = robot('c4', { cwd: '/h', agent: { kind: 'codex', sessionId: SID, transcriptPath: '/h/.codex/r.jsonl', status: 'idle', lastActivityAt: 0, flags: ['--yolo', '-p', "'work'"] } });
    const { robots } = importState({
      version: TRANSFER_SCHEMA_VERSION, transactionId: 't1', generation: 1, fromMachineId: MAC, toMachineId: TRIFT, home: '/h', destinationHome: '/h',
      fleet: FLEET, snapshot: state, excludes: [], roots: [], sessions: [],
    }).state;
    expect(robots.c1.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session --yolo -m 'gpt-6-astra' -s 'workspace-write' ${SID}` });
    expect(robots.c2.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session ${SID}` });
    expect(robots.c3.revive).toEqual({ command: `claude --effort 'high' --resume ${SID}` });
    expect(robots.c4.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session ${SID}` });
    expect(robots.c4.agent?.flags).toBeUndefined();
  });

  it('keeps a resume a crash left interrupted, and marks none the handover rested', () => {
    const state = emptyState();
    const agent = (status: 'idle' | 'working'): Robot['agent'] => ({ kind: 'claude', sessionId: SID, transcriptPath: '/h/.claude/r.jsonl', status, lastActivityAt: 0 });
    state.robots.c1 = robot('c1', { cwd: '/h', agent: agent('idle'), revive: { command: `claude --resume ${SID}`, interrupted: true } });
    state.robots.c2 = robot('c2', { cwd: '/h', agent: agent('working') });
    const { robots } = importState({
      version: TRANSFER_SCHEMA_VERSION, transactionId: 't1', generation: 1, fromMachineId: MAC, toMachineId: TRIFT, home: '/h', destinationHome: '/h',
      fleet: FLEET, snapshot: state, excludes: [], roots: [], sessions: [],
    }).state;
    expect(robots.c1.revive).toEqual({ command: `claude --resume ${SID}`, interrupted: true });
    expect(robots.c2.revive).toEqual({ command: `claude --resume ${SID}` });
  });
});
