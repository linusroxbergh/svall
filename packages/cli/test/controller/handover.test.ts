import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { AUTHORITY_SCHEMA_VERSION, FleetId, MachineId, PROTOCOL_VERSION, type Blocker, type HandoverEvent, type OwnerRecord } from '@svall/protocol';
import { AuthorityClient } from '@svall/svalld/gateway/client';
import { startAuthorityServer } from '@svall/svalld/gateway/server';
import { manifestDigest, spaceNeed } from '@svall/svalld/handover/manifest';
import { replicaRoots } from '@svall/svalld/handover/replicas';
import { resolvePaths } from '@svall/svalld/paths';
import { Handover, Refused } from '../../src/controller/handover.js';
import { authorityOp, connectHandover, gatewayOf, Masters, reconnecting } from '../../src/controller/reach.js';
import { remoteOwner } from '../../src/controller/authority.js';
import { fileStore, type FrozenManifest } from '../../src/controller/recovery.js';
import { FleetMismatch, MachineMismatch, resolveOwner } from '../../src/controller/connection.js';
import { readRoute } from '../../src/controller/route.js';
import { SshError, SshMaster } from '../../src/controller/ssh.js';
import { installFakeSsh } from './fake-ssh.js';
import { MachineRegistry } from '../../src/controller/registry.js';
import { ApiError, Client } from '../../src/client.js';
import type { RootEntry, SessionEntry } from '../../src/controller/transfer.js';
import { cleanHomes, makeHome } from '../../../svalld/test/helpers.js';
import {
  CODEX, FLEET_HOME, G, HOME, SID, TOKEN, World, at, controller, file, fleetId, info, keptCommit, mac, manifestFor, opIndex, phases, recover, settledOn, trift,
  type Probe,
} from './world.js';


describe('the controller transaction', () => {
  it('moves the fleet through every step in the spec\'s order, checking each answer, and leaves nothing open', async () => {
    const w = new World();
    const out = await controller(w).start(trift, {});

    expect(out).toEqual({
      status: 'complete', transactionId: 'tx-1', generation: G + 1,
      characters: [{ id: 'c_ada', ok: true }, { id: 'c_bo', ok: false, error: expect.stringContaining('SessionStart') }],
    });
    const order = ['gateway:begin', 'mac:handover.freeze', 'trift:handover.claim', 'transfer:run', 'trift:handover.prepare', 'gateway:ready', 'gateway:commit',
      'trift:handover.activate', 'trift:handover.complete', 'mac:handover.complete', 'gateway:complete'].map((op) => opIndex(w, op));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(phases(w)).toEqual(['begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit', 'activate', 'complete']);
    // rows for the sheet: each root and session file as it lands, each character as it comes up
    const entity = (id: string) => w.events.find((e) => e.event === 'handover.entity' && e.data.id === id);
    expect(entity('r_app')).toEqual({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'root', id: 'r_app', phase: 'verify', done: 2, total: 2, bytes: 64, totalBytes: 64 } });
    expect(entity('s0')).toMatchObject({ data: { kind: 'session', phase: 'verify' } });
    expect(entity('c_bo')).toEqual({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id: 'c_bo', phase: 'activate', error: expect.stringContaining('SessionStart') } });
    expect(w.events[0]).toMatchObject({ event: 'handover.preflight', data: { blockers: [], summary: { roots: 2 } } });
    expect(settledOn(w)).toBe('destination');
    expect(w.events.at(-1)).toEqual({ event: 'handover.result', data: out });
  });

  it('carries what a character that came up still waits on in its terminal into its row and the result', async () => {
    const w = new World();
    const notice = 'codex waits at its "Trust this folder?" prompt in bo\'s terminal; answer it there';
    const activate = w.destination.answers['handover.activate'] as (p: unknown) => object;
    w.destination.answers['handover.activate'] = ((p: unknown) => {
      activate(p);
      return { characters: [{ id: 'c_ada', ok: true }, { id: 'c_bo', ok: true, notice }] };
    }) as never;
    const out = await controller(w).start(trift, {});

    expect(out).toMatchObject({ status: 'complete', characters: [{ id: 'c_ada', ok: true }, { id: 'c_bo', ok: true, notice }] });
    const row = w.events.find((e) => e.event === 'handover.entity' && e.data.id === 'c_bo');
    expect(row).toEqual({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id: 'c_bo', phase: 'activate', notice } });
  });

  it('writes each root only where its claim says, under the excludes and Git keep rules it was proven with, and each session into its stage as one entry', async () => {
    const w = new World();
    // a second pass found a.txt changed since the freeze, so what the transfer verified is not the manifest's list
    const scanned = (files: SessionEntry['files']) => files.map((f) => (f.type === 'file' && f.path === 'a.txt' ? { ...f, sha256: 'b'.repeat(64) } : f));
    w.transferResult = (o) => ({ status: 'verified', blockers: [], entries: o.entries.map((e) => ({ id: e.id, status: 'verified' as const, passes: 2, files: scanned(e.files) })) });
    await controller(w).start(trift, {});
    const [run] = w.transfers;
    expect(run.roles).toEqual({ source: 'local', destination: 'remote' });
    expect(run.master).toBe(w.masters.trift);
    expect(run.transactionId).toBe('tx-1');
    const roots = run.entries.filter((e): e is RootEntry => e.kind === 'root');
    // a folded worktree travels inside the repository that holds it
    expect(roots.map((r) => [r.id, r.rootKind, r.claim.check.path, r.claim.excludes])).toEqual([
      ['r_app', 'repo', '/real/Users/ada/app', ['node_modules/', 'logs/']],
      ['r_git', 'gitdir', '/real/Users/ada/app.git', ['node_modules/', 'logs/']],
    ]);
    const stage = (i: number) => resolvePaths(FLEET_HOME).sessionStage('tx-1', i);
    expect(run.entries.filter((e) => e.kind === 'session').map((e) => [e.id, e.sourceHome, e.stage, e.files.map((f) => f.path)])).toEqual([
      ['s0', '/Users/ada/.claude', stage(0), [`projects/-app/${SID}.jsonl`, `projects/-app/${SID}/subagents/a.jsonl`]],
      ['s1', '/Users/ada/.codex', stage(1), [`sessions/rollout-${CODEX}.jsonl`]],
    ]);
    // prepare and the source's seal take what the transfer verified, not the frozen manifest's lists
    expect(scanned(roots[0].files)).not.toEqual(roots[0].files);
    expect(w.destination.landedSeen).toEqual([{ id: 'r_app', files: scanned(roots[0].files) }, { id: 'r_git', files: roots[1].files }]);
    expect(w.source.sealed).toEqual(w.destination.landedSeen);
  });

  it('keeps a journal of routes and progress, and never a token, not even in what a failure said', async () => {
    const w = new World();
    const prepare = w.destination.answers['handover.prepare'];
    let failures = 0;
    w.destination.answers['handover.prepare'] = ((p: never) => {
      if (failures++ < 1) throw new Error(`ws://127.0.0.1:52011 closed; the handshake sent ${TOKEN}`);
      return prepare(p);
    }) as never;
    await controller(w, { secrets: () => [TOKEN] }).start(trift, {});
    expect(w.transfers[0].secrets).toEqual([TOKEN]);
    expect(JSON.stringify(w.events)).toContain('[redacted]');

    // an interrupted run keeps what went wrong, scrubbed
    const down = new World();
    down.destination.answers['handover.prepare'] = (() => { throw new Error(`ws://127.0.0.1:52011 closed; the handshake sent ${TOKEN}`); }) as never;
    const out = await controller(down, { secrets: () => [TOKEN] }).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'prepare', error: expect.stringContaining('[redacted]') });
    expect(JSON.stringify([out, down.events, down.store.written])).not.toContain(TOKEN);

    const written = w.store.written;
    expect(written.length).toBeGreaterThan(5);
    expect(written.at(-1)).toMatchObject({
      transactionId: 'tx-1', generation: G, phase: 'complete', source: { machineId: mac, name: 'mac' }, destination: { machineId: trift, name: 'trift', ssh: 'trift' },
    });
    expect(JSON.stringify(written)).not.toContain(TOKEN);
    expect(written.every((j) => Object.keys(j).every((k) => !/token|secret/i.test(k)))).toBe(true);
  });

  it('pulls a fleet from the far machine to this one over that machine\'s master', async () => {
    const w = new World({ pull: true });
    const out = await controller(w).start(mac, {});
    expect(out.status).toBe('complete');
    expect(w.transfers[0].roles).toEqual({ source: 'remote', destination: 'local' });
    expect(w.transfers[0].master).toBe(w.masters.trift);
    expect(settledOn(w)).toBe('destination');
  });

  it('refuses an answer that names another transaction, generation, machine or manifest, and goes no further', async () => {
    type Tamper = { name: string; set(w: World): void; stopsBefore: string };
    const tampers: Tamper[] = [
      {
        name: 'a Begin for other machines', stopsBefore: 'mac:handover.freeze',
        set: (w) => { const begin = w.gateway.begin; w.gateway.begin = async (p) => ({ ...(await begin(p)), transaction: { ...w.record.transaction!, toMachineId: mac } }); },
      },
      {
        name: 'a manifest for another generation', stopsBefore: 'trift:handover.claim',
        set: (w) => { const f = w.source.answers['handover.freeze']; w.source.answers['handover.freeze'] = (async (p: never) => { const r = await (f(p) as Promise<{ manifest: FrozenManifest }>); return { manifest: { ...r.manifest, generation: 3 } }; }) as never; },
      },
      {
        name: 'a manifest for another transaction', stopsBefore: 'trift:handover.claim',
        set: (w) => { const f = w.source.answers['handover.freeze']; w.source.answers['handover.freeze'] = (async (p: never) => { const r = await (f(p) as Promise<{ manifest: FrozenManifest }>); return { manifest: { ...r.manifest, transactionId: 'tx-9' } }; }) as never; },
      },
      {
        name: 'a claim that leaves a root out', stopsBefore: 'transfer:run',
        set: (w) => { const c = w.destination.answers['handover.claim']; w.destination.answers['handover.claim'] = ((p: never) => { const r = c(p) as { roots: unknown[] }; return { roots: r.roots.slice(1) }; }) as never; },
      },
      {
        name: 'a claim that names a root the manifest does not carry', stopsBefore: 'transfer:run',
        set: (w) => { const c = w.destination.answers['handover.claim']; w.destination.answers['handover.claim'] = ((p: never) => { const r = c(p) as { roots: { id: string }[] }; return { roots: [...r.roots, { ...r.roots[0], id: 'r_elsewhere' }] }; }) as never; },
      },
      {
        name: 'a transfer that verified a root no entry named', stopsBefore: 'trift:handover.prepare',
        set: (w) => { w.transferResult = (o) => ({ status: 'verified', blockers: [], entries: o.entries.map((e) => ({ id: `${e.id}-x`, status: 'verified' as const, passes: 1, files: [] })) }); },
      },
      {
        name: 'a Ready granted on another prepared state', stopsBefore: 'gateway:commit',
        set: (w) => { const ready = w.gateway.ready; w.gateway.ready = async (p) => ready({ ...p, preparedDigest: 'e'.repeat(64) }); },
      },
      {
        name: 'a Commit that hands the fleet to another machine', stopsBefore: 'trift:handover.activate',
        set: (w) => { const commit = w.gateway.commit; w.gateway.commit = async (p) => ({ ...(await commit(p)), ownerMachineId: mac }); w.gateway.get = async () => ({ ...structuredClone(w.record), ownerMachineId: mac }); },
      },
    ];
    for (const t of tampers) {
      const w = new World();
      t.set(w);
      const out = await controller(w).start(trift, {});
      expect(out.status, t.name).not.toBe('complete');
      expect(opIndex(w, t.stopsBefore), t.name).toBe(-1);
      expect(w.violations, t.name).toEqual([]);
      expect(w.destination.activated, t.name).toBe(false);
    }
  });
});

describe('one home on both machines', () => {
  it('carries every path as the source recorded it, both ways, and tells the source both machines share the home', async () => {
    for (const pull of [false, true]) {
      const w = new World({ pull });
      const out = await controller(w).start(w.destination.id, {});
      expect(out.status, `pull ${pull}`).toBe('complete');
      expect(w.sent.map((x) => x.method)).toEqual(['handover.preflight', 'handover.freeze']);
      for (const x of w.sent) expect(x).toMatchObject({ source: { home: HOME }, destination: { home: HOME, fleetHome: FLEET_HOME } });
      const m = w.source.kept!;
      const [run] = w.transfers;
      const roots = run.entries.filter((e): e is RootEntry => e.kind === 'root');
      expect(roots.map((r) => r.path)).toEqual(replicaRoots(m).map((r) => r.path));
      expect(roots.map((r) => r.path)).toEqual([at('app'), at('app.git')]);
      expect(run.entries.flatMap((e) => (e.kind === 'session' ? [e.sourceHome] : []))).toEqual([at('.claude'), at('.codex')]);
      expect(run.entries.flatMap((e) => (e.kind === 'session' ? [e.files] : []))).toEqual(m.sessions.map((x) => x.files));
      expect(settledOn(w)).toBe('destination');
    }
  });

  it('stops before any root is claimed when the source froze over a home other than the one it was sent', async () => {
    const w = new World();
    const freeze = w.source.answers['handover.freeze'];
    w.source.answers['handover.freeze'] = (async (p: never) => {
      const r = await (freeze as (x: never) => Promise<{ manifest: FrozenManifest }>)(p);
      const manifest = { ...r.manifest, home: '/home/ada' };
      w.source.kept = manifest;
      w.source.journal!.digest = manifestDigest(manifest);
      return { manifest };
    }) as never;
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'freeze', error: expect.stringContaining('a home other than the one it was sent') });
    expect(w.ops).not.toContain('trift:handover.claim');
  });
});

describe('preflight', () => {
  it('stops before Begin with the source\'s blockers, and touches nothing', async () => {
    const w = new World();
    w.source.preflightBlockers = [{ code: 'shell_busy', message: 'ada\'s terminal is running npm run dev', entity: { kind: 'character', id: 'c_ada' } }];
    const out = await controller(w).start(trift, {});
    expect(out).toEqual({ status: 'blocked', phase: 'begin', blockers: w.source.preflightBlockers });
    expect(w.ops.filter((op) => !/^(gateway:get|mac:|trift:)(system\.info|ownership\.get|handover\.(preflight|inspect|status)|get)?/.test(op))).toEqual([]);
    expect(w.store.j).toBeUndefined();
    expect(w.record).toEqual({ fleetId, generation: G, ownerMachineId: mac });
  });

  it('adds the destination\'s roots and room, the destination\'s git, and what differs between the machines', async () => {
    const w = new World();
    w.destination.diverged.add('r_git');
    w.destination.probe = { exists: true, writable: true, caseInsensitive: true, freeBytes: 10 };
    w.infos[trift] = { agentAdapters: [...info(trift).agentAdapters.map((a) => (a.kind === 'claude' ? { ...a, version: '2.1.290' } : a))] };
    const r = await controller(w).preflight(trift, {});
    const codes = (list: Blocker[]) => list.map((b) => [b.code, b.entity?.id]);
    expect(codes(r.blockers)).toEqual(expect.arrayContaining([
      ['destination_diverged', 'r_git'],
      ['destination_no_space', undefined],
      ['path_collision', 'r_app'],
    ]));
    expect(r.blockers.find((b) => b.code === 'path_collision')!.message).toMatch(/README\.md.*Readme\.md|Readme\.md.*README\.md/);
    expect(codes(r.warnings)).toEqual(expect.arrayContaining([['codex_trust', 'c_bo'], ['config_difference', undefined]]));
    expect(r.warnings.find((x) => x.code === 'config_difference')!.message).toMatch(/2\.1\.280.*2\.1\.290/);
    // the source is told where the destination keeps its fleet
    expect(w.sent[0].destination.fleetHome).toBe(FLEET_HOME);
    expect(w.store.j).toBeUndefined();
  });

  it('names a few of a root\'s names that differ only by case, each with the names it clashes with, and counts the rest, however many there are', async () => {
    const w = new World();
    w.destination.probe = { exists: true, writable: true, caseInsensitive: true, freeBytes: 1e12 };
    const preflight = w.source.answers['handover.preflight'] as (p: unknown) => { manifest: FrozenManifest };
    w.source.answers['handover.preflight'] = ((p: unknown) => {
      const r = preflight(p);
      r.manifest.roots.find((x) => x.id === 'r_app')!.files.push(...Array.from({ length: 10_000 }, (_, i) => [file(`data/f${i}.csv`), file(`data/F${i}.csv`)]).flat());
      return r;
    }) as never;
    const r = await controller(w).preflight(trift, {});
    const message = r.blockers.find((b) => b.code === 'path_collision')!.message;
    expect(message).toMatch(/; and 9998 more$/);
    expect(message.length).toBeLessThan(1000);
    const shown = message.slice(message.indexOf(': ') + 2).split('; ').slice(0, -1);
    expect(shown).toHaveLength(3);
    for (const group of shown) {
      const names = group.split(' and ');
      expect(names).toHaveLength(2);
      expect(names[0].toLowerCase()).toBe(names[1].toLowerCase());
    }
  });

  it('asks the destination nothing about roots once the source refused a manifest too large to answer with its file lists', async () => {
    for (const code of ['too_many_files', 'manifest_too_large'] as const) {
      const w = new World();
      const preflight = w.source.answers['handover.preflight'] as (p: unknown) => { manifest: FrozenManifest; blockers: Blocker[] };
      w.source.answers['handover.preflight'] = ((p: unknown) => {
        const r = preflight(p);
        for (const root of r.manifest.roots) root.files = [];
        r.blockers.push({ code, message: `refused: ${code}` });
        return r;
      }) as never;
      let inspected = 0;
      const inspect = w.destination.answers['handover.inspect'] as (p: unknown) => object;
      w.destination.answers['handover.inspect'] = ((p: unknown) => { inspected++; return inspect(p); }) as never;
      const r = await controller(w).preflight(trift, {});
      expect(r.blockers).toEqual([{ code, message: `refused: ${code}` }]);
      expect(inspected).toBe(0);
    }
  });

  it('warns that Codex asks to trust a carried folder only where the destination does not trust it yet', async () => {
    const w = new World();
    // bo's Codex works in a worktree of app, which Codex trusts through app itself
    const preflight = w.source.answers['handover.preflight'] as (p: unknown) => { manifest: FrozenManifest };
    w.source.answers['handover.preflight'] = ((p: unknown) => {
      const r = preflight(p);
      r.manifest.snapshot.characters.c_bo.cwd = '/Users/ada/app/.claude/worktrees/x';
      r.manifest.snapshot.characters.c_bo.repo = { root: '/Users/ada/app/.claude/worktrees/x', mainRoot: '/Users/ada/app', branch: 'x', isWorktree: true };
      return r;
    }) as never;
    let asked: unknown;
    const inspect = w.destination.answers['handover.inspect'] as (p: unknown) => object;
    w.destination.answers['handover.inspect'] = ((p: { resumes?: unknown }) => { asked = p.resumes; return inspect(p); }) as never;
    const trust = async () => (await controller(w).preflight(trift, {})).warnings.filter((x) => x.code === 'codex_trust');

    expect(await trust()).toEqual([expect.objectContaining({ entity: { kind: 'character', id: 'c_bo' }, message: expect.stringContaining('bo resumes on trift') })]);
    expect(asked).toEqual([
      { kind: 'claude', cwd: '/Users/ada/app' },
      { kind: 'codex', cwd: '/Users/ada/app/.claude/worktrees/x', repo: '/Users/ada/app', root: '/Users/ada/app/.claude/worktrees/x' },
    ]);
    w.destination.trusted.add('codex /Users/ada/app/.claude/worktrees/x');
    expect(await trust()).toEqual([]);
  });

  it('warns that Claude asks to trust a carried folder with "No, exit" preselected, only where the destination\'s Claude does not trust it, apart from Codex in the same folder', async () => {
    const w = new World();
    const preflight = w.source.answers['handover.preflight'] as (p: unknown) => { manifest: FrozenManifest };
    w.source.answers['handover.preflight'] = ((p: unknown) => {
      const r = preflight(p);
      r.manifest.snapshot.characters.c_ada.repo = { root: '/Users/ada/app', mainRoot: '/Users/ada/app', branch: 'main', isWorktree: false };
      return r;
    }) as never;
    let asked: unknown;
    const inspect = w.destination.answers['handover.inspect'] as (p: unknown) => object;
    w.destination.answers['handover.inspect'] = ((p: { resumes?: unknown }) => { asked = p.resumes; return inspect(p); }) as never;
    const trust = async () => (await controller(w).preflight(trift, {})).warnings.filter((x) => x.code === 'claude_trust' || x.code === 'codex_trust');

    expect(await trust()).toEqual([
      {
        code: 'claude_trust', entity: { kind: 'character', id: 'c_ada' },
        message: 'Claude asks whether to trust its folder the first time ada resumes on trift, with "No, exit" preselected; choose "Yes, I trust this folder" in that terminal',
      },
      expect.objectContaining({ code: 'codex_trust', entity: { kind: 'character', id: 'c_bo' } }),
    ]);
    expect(asked).toEqual(expect.arrayContaining([{ kind: 'claude', cwd: '/Users/ada/app', repo: '/Users/ada/app', root: '/Users/ada/app' }]));
    w.destination.trusted.add('claude /Users/ada/app');
    expect((await trust()).map((x) => x.code)).toEqual(['codex_trust']);
  });

  it('warns that Claude warns about bypass mode with "No, exit" preselected where a carried resume asks for it and the destination\'s Claude has not accepted it', async () => {
    const w = new World();
    const preflight = w.source.answers['handover.preflight'] as (p: unknown) => { manifest: FrozenManifest };
    w.source.answers['handover.preflight'] = ((p: unknown) => {
      const r = preflight(p);
      r.manifest.snapshot.characters.c_ada.revive = { command: `claude --dangerously-skip-permissions --resume ${SID}` };
      return r;
    }) as never;
    let asked: unknown;
    const inspect = w.destination.answers['handover.inspect'] as (p: unknown) => object;
    w.destination.answers['handover.inspect'] = ((p: { resumes?: unknown }) => { asked = p.resumes; return inspect(p); }) as never;
    const bypass = async () => (await controller(w).preflight(trift, {})).warnings.filter((x) => x.code === 'claude_bypass');

    expect(await bypass()).toEqual([{
      code: 'claude_bypass', entity: { kind: 'character', id: 'c_ada' },
      message: 'Claude warns that ada resumes in Bypass Permissions mode on trift, with "No, exit" preselected; choose "Yes, I accept" in that terminal',
    }]);
    expect(asked).toEqual(expect.arrayContaining([{ kind: 'claude', cwd: '/Users/ada/app', bypass: true }, expect.not.objectContaining({ bypass: true })]));
    w.destination.accepted.add('claude /Users/ada/app');
    expect(await bypass()).toEqual([]);
  });

  it('blocks a destination that holds a handover journal of its own, before anything is rested', async () => {
    const w = new World();
    w.destination.answers['ownership.get'] = (() => ({
      fleetId, generation: G, ownerMachineId: mac, frozen: true, journal: { role: 'destination', transactionId: 'tx-9', generation: G + 1, phase: 'prepare' },
    })) as never;
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'blocked', phase: 'begin', blockers: [expect.objectContaining({ code: 'transaction_open', message: expect.stringContaining('tx-9') })] });
    expect(w.ops).not.toContain('gateway:begin');
  });

  it('warns of each carried link that will point at nothing on the destination, asking it of the targets no carried root holds', async () => {
    const w = new World();
    const preflight = w.source.answers['handover.preflight'];
    w.source.answers['handover.preflight'] = ((p: never) => {
      const r = (preflight as (x: never) => { manifest: FrozenManifest })(p);
      const app = r.manifest.roots.find((x) => x.id === 'r_app')!;
      app.files.push(
        { type: 'symlink', path: 'current', target: 'Readme.md' },
        { type: 'symlink', path: 'lib/gone', target: '../missing.txt' },
        { type: 'symlink', path: 'shared', target: '/Users/ada/shared/x' },
        { type: 'symlink', path: 'out', target: '../../elsewhere' },
      );
      return r;
    }) as never;
    let asked: string[] | undefined;
    const inspect = w.destination.answers['handover.inspect'];
    w.destination.answers['handover.inspect'] = ((p: { links?: string[] }) => ({ ...(inspect as (x: unknown) => object)(p), missing: (asked = p.links ?? []).filter((l) => l !== '/Users/elsewhere') })) as never;
    const pre = await controller(w).preflight(trift, {});
    expect(asked).toEqual(['/Users/ada/shared/x', '/Users/elsewhere']);
    expect(pre.blockers).toEqual([]);
    expect(pre.warnings).toContainEqual({
      code: 'symlink_dangling', entity: { kind: 'root', id: 'r_app' },
      message: expect.stringMatching(/^2 links in \/Users\/ada\/app will point at nothing on trift: lib\/gone, shared/),
    });
  });

  it('reads a root\'s file list a few times over to judge its links, however many links it holds', async () => {
    const [FILES, LINKS] = [5000, 500];
    const w = new World();
    const preflight = w.source.answers['handover.preflight'];
    let reads = 0;
    w.source.answers['handover.preflight'] = ((p: never) => {
      const r = (preflight as (x: never) => { manifest: FrozenManifest })(p);
      const app = r.manifest.roots.find((x) => x.id === 'r_app')!;
      const files = [...app.files];
      for (let i = 0; i < FILES; i++) files.push({ type: 'file', path: `src/f${i}.ts`, mode: 0o644, size: 1, mtimeMs: 0, sha256: '0'.repeat(64) });
      for (let i = 0; i < LINKS; i++) files.push({ type: 'symlink', path: `links/l${i}`, target: `../src/f${FILES - 1 - i}.ts` });
      app.files = new Proxy(files, { get: (t, k, rcv) => { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return Reflect.get(t, k, rcv); } });
      return r;
    }) as never;
    const pre = await controller(w).preflight(trift, {});
    expect(pre.warnings.filter((x) => x.code === 'symlink_dangling')).toEqual([]);
    // each check reads the list once or twice; looking each link's target up in it would read it once per link
    expect(reads).toBeLessThan(20 * (FILES + LINKS));
  });

  it('blocks, before anything is rested, on an rsync either end cannot drive and an ssh that would have to ask for a password', async () => {
    const local = new World();
    const noRsync = await controller(local, { rsync: async () => { throw new Error('/opt/svall/bin/rsync could not run: ENOENT'); } }).start(trift, {});
    expect(noRsync).toMatchObject({ status: 'blocked', phase: 'begin', blockers: [expect.objectContaining({ code: 'rsync_unsupported', message: expect.stringContaining('ENOENT') })] });

    const far = new World();
    far.farRsync = 'rsync  version 3.1.3  protocol version 31\n';
    const old = await controller(far).start(trift, {});
    expect(old).toMatchObject({ status: 'blocked', blockers: [expect.objectContaining({ code: 'rsync_unsupported', message: expect.stringContaining('3.1.3') })] });

    const prompt = new World();
    prompt.masterFails = new SshError('auth', 'ssh could not reach trift: linus@trift: Permission denied (publickey,password).');
    const asks = await controller(prompt).start(trift, {});
    expect(asks).toMatchObject({ status: 'blocked', blockers: [expect.objectContaining({ code: 'ssh_interactive', message: expect.stringContaining('Permission denied') })] });

    // the far daemon itself is reached over that master: a login it would ask for is the same blocker, asked once
    const daemon = new World();
    daemon.destination.answers['system.info'] = (() => { throw new SshError('auth', 'ssh could not reach trift: Permission denied (publickey).'); }) as never;
    const once = await controller(daemon).start(trift, {});
    expect(once).toMatchObject({ status: 'blocked', blockers: [expect.objectContaining({ code: 'ssh_interactive' })] });
    expect(daemon.ops.filter((op) => op === 'trift:system.info')).toHaveLength(1);
    for (const w of [local, far, prompt, daemon]) expect(w.ops).not.toContain('gateway:begin');
  });

  it('blocks at once, naming host enable, on a destination whose companion runs another fleet, and asks it only once', async () => {
    const w = new World();
    const said = 'trift answered with fleetId 47a74455-7dbc-46c0-8076-30d830cf4f72, not ours: `svall host enable trift --fleet private` gives it a copy of this fleet';
    w.destination.answers['system.info'] = (() => { throw new FleetMismatch(said); }) as never;
    const out = await controller(w).start(trift, {});
    expect(out).toEqual({ status: 'blocked', phase: 'begin', blockers: [{ code: 'identity_mismatch', message: said }] });
    expect(w.ops.filter((op) => op === 'trift:system.info')).toHaveLength(1);
    expect(w.events.filter((e) => e.event === 'handover.retry')).toEqual([]);
    expect(w.ops).not.toContain('gateway:begin');
  });

  it('blocks at once, naming the upgrade, on a destination whose companion speaks another protocol, and asks it only once', async () => {
    const w = new World();
    const said = `trift answered with protocol ${PROTOCOL_VERSION - 1}, not ${PROTOCOL_VERSION}`;
    w.destination.answers['system.info'] = (() => { throw new SshError('version', said); }) as never;
    const out = await controller(w).start(trift, {});
    expect(out).toEqual({ status: 'blocked', phase: 'begin', blockers: [{ code: 'incompatible_protocol', message: said }] });
    expect(w.ops.filter((op) => op === 'trift:system.info')).toHaveLength(1);
    expect(w.events.filter((e) => e.event === 'handover.retry')).toEqual([]);
  });

  it('asks again only after an ssh failure a transport comes back from, as a reconnect does', async () => {
    for (const [kind, asked] of [['unreachable', 3], ['daemon_down', 3], ['other', 1]] as const) {
      const w = new World();
      w.destination.answers['system.info'] = (() => { throw new SshError(kind, `trift: ${kind}`); }) as never;
      await controller(w).start(trift, {});
      expect([kind, w.ops.filter((op) => op === 'trift:system.info').length]).toEqual([kind, asked]);
    }
  });

  it('reaches a far machine again after an ssh failure a transport comes back from, and goes on, but tries it once after any other', async () => {
    for (const [kind, reached, status] of [['unreachable', 2, 'complete'], ['other', 1, 'interrupted']] as const) {
      const w = new World();
      let asked = 0;
      const side = async (id: MachineId) => {
        if (id === trift && asked++ === 0) throw new SshError(kind, `ssh could not reach trift: ${kind}`);
        return w.side(id);
      };
      const out = await controller(w, { side }).start(trift, {});
      expect([kind, asked, out.status]).toEqual([kind, reached, status]);
    }
  });

  it('asks a far gateway nothing once its ssh destination answers as another machine', async () => {
    const ssh = installFakeSsh();
    const masters = new Masters();
    const other = crypto.randomUUID();
    try {
      ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: 'dev', protocol: PROTOCOL_VERSION, machineId: other }, null, 2) });
      ssh.reply(['gateway', 'owner', 'get'], { stdout: `${JSON.stringify({ result: { record: { fleetId, generation: 0, ownerMachineId: mac } } })}\n` });
      const gateway = {
        id: trift,
        record: { name: 'trift', ssh: 'trift.test', platform: 'linux' as const, arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall', gateway: true },
      };
      await expect(authorityOp(gateway, mac, masters)('get', fleetId)).rejects.toThrow(`trift.test now reaches machine ${other}, not trift (${trift})`);
      expect(ssh.remoteCalls().filter((w) => w.includes('owner'))).toEqual([]);
    } finally {
      await masters.close();
      ssh.clean();
    }
  });

  it('blocks a handover to the machine that runs the fleet as soon as the gateway names it, and asks nothing more', async () => {
    const w = new World();
    const out = await controller(w).start(mac, {});
    expect(out).toEqual({ status: 'blocked', phase: 'begin', blockers: [{ code: 'identity_mismatch', message: `mac already runs this fleet, at generation ${G}; there is nothing to hand it` }] });
    expect(w.ops).toEqual(['gateway:get']);
  });

  it('asks a far gateway nothing for a handover once it answers on another authority schema, and says so as a version fault naming it', async () => {
    const ssh = installFakeSsh();
    const masters = new Masters();
    try {
      ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: 'dev', protocol: PROTOCOL_VERSION, machineId: trift, authoritySchema: AUTHORITY_SCHEMA_VERSION + 1 }, null, 2) });
      ssh.reply(['gateway', 'owner', 'get'], { stdout: `${JSON.stringify({ result: { record: { fleetId, generation: 0, ownerMachineId: mac } } })}\n` });
      const gateway = {
        id: trift,
        record: { name: 'trift', ssh: 'trift.test', platform: 'linux' as const, arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall', gateway: true },
      };
      const err = await authorityOp(gateway, mac, masters, { schema: true })('get', fleetId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SshError);
      expect(err).toMatchObject({ kind: 'version', message: expect.stringContaining(`trift runs gateway authority schema ${AUTHORITY_SCHEMA_VERSION + 1}`) });
      expect(ssh.remoteCalls().filter((w) => w.includes('owner'))).toEqual([]);
      // a recovery reads it all the same
      expect(await authorityOp(gateway, mac, masters)('get', fleetId)).toMatchObject({ record: { generation: 0 } });
    } finally {
      await masters.close();
      ssh.clean();
    }
  });

  it('blocks as incompatible_protocol, naming it, on a gateway that answers on another authority schema', async () => {
    const w = new World();
    const said = `trift runs gateway authority schema ${AUTHORITY_SCHEMA_VERSION + 1}, and this release ${AUTHORITY_SCHEMA_VERSION}; upgrade trift`;
    w.gateway.get = () => Promise.reject(new SshError('version', said));
    const out = await controller(w).start(trift, {});
    expect(out).toEqual({ status: 'blocked', phase: 'begin', blockers: [{ code: 'incompatible_protocol', message: said }] });
  });

  it('blocks at once on a gateway whose ssh destination now reaches another machine', async () => {
    const w = new World();
    const said = `gate.test now reaches machine ${crypto.randomUUID()}, not gate (${trift})`;
    w.gateway.get = () => Promise.reject(new MachineMismatch(said));
    const out = await controller(w).start(trift, {});
    expect(out).toEqual({ status: 'blocked', phase: 'begin', blockers: [{ code: 'identity_mismatch', message: said }] });
    expect(w.ops).not.toContain('gateway:begin');
  });

  it('tells the destination what each root brings, so a root that already holds that is no blocker', async () => {
    const w = new World();
    let asked: { id: string; files?: unknown[] }[] = [];
    const inspect = w.destination.answers['handover.inspect'];
    w.destination.answers['handover.inspect'] = ((p: { roots: { id: string; files?: unknown[] }[] }) => { asked = p.roots; return (inspect as (x: unknown) => object)(p); }) as never;
    const pre = await controller(w).preflight(trift, {});
    const m = pre.manifest!;
    expect(asked.map((r) => [r.id, r.files])).toEqual(replicaRoots(m).map((r) => [r.id, m.roots.find((x) => x.id === r.id)!.files]));
  });

  it('asks the source about a kept commit the destination cannot prove comes back, and blocks only on one the source cannot reach', async () => {
    const lost = keptCommit({ reached: false, at: 'inspect' });
    const out = await controller(lost.w).start(trift, {});
    expect(lost.asked.git).toEqual([{ id: 'g_app', commonDir: '/Users/ada/app/.git', carried: [], tips: ['e'.repeat(40), 'c'.repeat(40)] }]);
    expect(lost.asked.reaches).toEqual([{ commits: [{ commonDir: '/Users/ada/app/.git', commit: lost.commit }] }]);
    expect(out).toEqual({
      status: 'blocked', phase: 'begin',
      blockers: [{ code: 'worktree_unused', entity: { kind: 'git', id: 'g_app' }, message: expect.stringMatching(/^\/Users\/ada\/stay is a worktree no character uses that stays on trift, at ffffffffffff, which nothing mac sends back reaches/) }],
    });
    expect(lost.w.ops).not.toContain('gateway:begin');

    const moved = keptCommit({ reached: true, at: 'inspect' });
    expect((await controller(moved.w).preflight(trift, {})).blockers).toEqual([]);
  });

  it('asks the source again about a kept commit the claim cannot prove comes back, before anything is copied', async () => {
    const lost = keptCommit({ reached: false, at: 'claim' });
    const decided: Blocker[][] = [];
    const out = await controller(lost.w, { decide: async (b) => { decided.push(b); return 'cancel'; } }).start(trift, {});
    expect(decided).toEqual([[expect.objectContaining({ code: 'worktree_unused', message: expect.stringContaining('/Users/ada/stay') })]]);
    expect(out).toMatchObject({ status: 'blocked', phase: 'transfer' });
    expect(lost.w.transfers).toEqual([]);
    expect(settledOn(lost.w)).toBe('source');

    const moved = keptCommit({ reached: true, at: 'claim' });
    expect(await controller(moved.w).start(trift, {})).toMatchObject({ status: 'complete' });
  });

  it('asked while the claim waits on the source about a kept commit, stops waiting at once, whether in a backoff or in the call', async () => {
    for (const how of ['backoff', 'call'] as const) {
      const { w } = keptCommit({ reached: true, at: 'claim' });
      let sent = 0;
      w.source.answers['handover.reaches'] = (() => {
        sent++;
        if (how === 'backoff') throw new Error('mac: connection reset');
        return new Promise(() => undefined);
      }) as never;
      // a backoff that would last for ever unless the cancel ends it
      const c = controller(w, { clock: { now: () => w.now, sleep: () => new Promise<void>(() => undefined) } });
      const run = c.start(trift, {});
      while (!w.ops.includes('mac:handover.reaches') || (how === 'backoff' && !w.events.some((e) => e.event === 'handover.retry'))) await new Promise((r) => setImmediate(r));
      c.cancel();
      const out = await Promise.race([run, new Promise<'hung'>((r) => { setTimeout(() => r('hung'), 1000); })]);
      expect(out, how).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
      expect(sent, how).toBe(1);
      expect(w.transfers, how).toEqual([]);
    }
  });

  it('hands the transfer the folders each claim keeps as they are', async () => {
    const w = new World();
    const claim = w.destination.answers['handover.claim'];
    w.destination.answers['handover.claim'] = ((p: never) => {
      const r = (claim as (x: never) => { roots: { id: string }[] })(p);
      return { roots: r.roots.map((x) => (x.id === 'r_app' ? { ...x, keep: ['.git/worktrees/stay'] } : x)) };
    }) as never;
    expect((await controller(w).start(trift, {})).status).toBe('complete');
    const entries = w.transfers[0].entries as RootEntry[];
    expect(entries.find((e) => e.id === 'r_app')!.claim.keep).toEqual(['.git/worktrees/stay']);
    expect(entries.find((e) => e.id === 'r_git')!.claim.keep).toBeUndefined();
  });

  it('names each character and where each root lands, so what a blocker points at can be read', async () => {
    const w = new World();
    await controller(w).preflight(trift, {});
    const pre = w.events.find((e) => e.event === 'handover.preflight');
    expect(pre?.data).toMatchObject({
      names: {
        characters: { c_ada: 'ada', c_bo: 'bo' },
        roots: { r_app: '/Users/ada/app', r_wt: '/Users/ada/app/.claude/worktrees/x', r_git: '/Users/ada/app.git' },
        // a session row is named by the character whose session it carries
        sessions: { s0: 'ada', s1: 'bo' },
      },
    });
  });

  it('takes a root the user chose to archive as a notice, counting all it brings against the room, and archives it at claim', async () => {
    const w = new World();
    w.destination.diverged.add('r_app');
    const plain = await controller(w).preflight(trift, {});
    // room for everything but the root that stays blocked
    const m = plain.manifest!;
    w.destination.probe = { ...w.destination.probe, freeBytes: spaceNeed({ ...m, roots: m.roots.filter((r) => r.id !== 'r_app') })[HOME] };
    expect((await controller(w).preflight(trift, {})).blockers.map((b) => b.code)).toEqual(['destination_diverged']);

    const pre = await controller(w).preflight(trift, { archiveRoots: ['r_app'] });
    expect(pre.blockers.map((b) => b.code)).toEqual(['destination_no_space']);
    expect(pre.warnings).toContainEqual({
      code: 'destination_diverged', entity: { kind: 'root', id: 'r_app' }, message: expect.stringMatching(/^\/Users\/ada\/app is archived when the handover claims it: /),
    });

    w.destination.probe = { ...w.destination.probe, freeBytes: 1e12 };
    expect(await controller(w).start(trift, { archiveRoots: ['r_app'] })).toMatchObject({ status: 'complete' });
    expect(w.destination.archived).toEqual(['r_app']);
  });

  it('blocks a root outside the home whose folder the destination lacks, naming that folder, and takes one whose folder is there', async () => {
    const w = new World();
    const preflight = w.source.answers['handover.preflight'] as (p: unknown) => { manifest: FrozenManifest };
    w.source.answers['handover.preflight'] = ((p: unknown) => {
      const r = preflight(p);
      r.manifest.roots.push({ id: 'r_tool', kind: 'cwd', entry: 'dir', path: '/Volumes/work/tool', files: [file('tool.txt')] });
      return r;
    }) as never;
    let asked: string[] = [];
    const inspect = w.destination.answers['handover.inspect'] as (p: { folders: string[] }) => object;
    w.destination.answers['handover.inspect'] = ((p: { folders: string[] }) => { asked = p.folders; return inspect(p); }) as never;
    w.destination.folders['/Volumes/work'] = { exists: false, writable: false, caseInsensitive: false, freeBytes: 0 };
    const missing = await controller(w).preflight(trift, {});
    expect(asked).toEqual([HOME, '/Volumes/work', at('app'), at('app.git'), '/Volumes/work/tool']);
    expect(missing.blockers).toEqual([{
      code: 'parent_missing', entity: { kind: 'root', id: 'r_tool' },
      message: 'trift has no /Volumes/work, which /Volumes/work/tool lands in; a folder outside the home arrives at the same path there, so make /Volumes/work on trift first',
    }]);
    delete w.destination.folders['/Volumes/work'];
    expect((await controller(w).preflight(trift, {})).blockers).toEqual([]);
  });

  it('asks the folder above a root to be writable only when the handover makes that root, so a root holding its replica comes back under a folder no one may write', async () => {
    // the Mac takes back a folder that went out, straight under its /Volumes, which only root may write
    const w = new World({ pull: true });
    const preflight = w.source.answers['handover.preflight'] as (p: unknown) => { manifest: FrozenManifest };
    w.source.answers['handover.preflight'] = ((p: unknown) => {
      const r = preflight(p);
      r.manifest.roots.push({ id: 'r_work', kind: 'cwd', entry: 'dir', path: '/Volumes/work', files: [file('a.txt'), file('A.txt')] });
      return r;
    }) as never;
    const blockers = async () => (await controller(w).preflight(mac, {})).blockers;
    const probe = (o: Partial<Probe>): Probe => ({ exists: true, writable: true, caseInsensitive: false, freeBytes: 1e12, ...o });
    w.destination.folders['/Volumes'] = probe({ writable: false });
    w.destination.replicas.add('r_work');
    expect(await blockers()).toEqual([]);

    // the root itself takes what changed, and folds case as it does
    w.destination.folders['/Volumes/work'] = probe({ writable: false });
    expect(await blockers()).toEqual([{ code: 'path_unsupported', message: '/Volumes/work on mac cannot be written' }]);
    w.destination.folders['/Volumes/work'] = probe({ caseInsensitive: true });
    expect(await blockers()).toEqual([{
      code: 'path_collision', entity: { kind: 'root', id: 'r_work' }, message: '/Volumes/work would hold names that differ only by case or Unicode normalization, which mac does not tell apart: A.txt and a.txt',
    }]);

    // a first copy is made in /Volumes
    w.destination.replicas.delete('r_work');
    w.destination.folders['/Volumes/work'] = probe({ exists: false, writable: false, freeBytes: 0 });
    expect(await blockers()).toEqual([{ code: 'path_unsupported', message: '/Volumes on mac cannot be written' }]);
  });

  it('asks the folder above a file root to be writable even when the file holds its replica, since rsync writes the new copy beside it', async () => {
    const w = new World({ pull: true });
    const preflight = w.source.answers['handover.preflight'] as (p: unknown) => { manifest: FrozenManifest };
    w.source.answers['handover.preflight'] = ((p: unknown) => {
      const r = preflight(p);
      r.manifest.roots.push({ id: 'r_note', kind: 'context', entry: 'file', path: '/Volumes/work/notes.md', files: [file('')] });
      return r;
    }) as never;
    w.destination.folders['/Volumes/work'] = { exists: true, writable: false, caseInsensitive: false, freeBytes: 1e12 };
    w.destination.replicas.add('r_note');
    expect((await controller(w).preflight(mac, {})).blockers).toEqual([{ code: 'path_unsupported', message: '/Volumes/work on mac cannot be written' }]);
  });

  it('blocks a missing destination home, a fleet already in a handover, and a destination that is the owner', async () => {
    const missing = new World();
    missing.destination.probe = { ...missing.destination.probe, exists: false };
    expect((await controller(missing).preflight(trift, {})).blockers.map((b) => b.code)).toContain('parent_missing');

    const open = new World();
    open.record.transaction = { id: 'tx-0', fromMachineId: mac, toMachineId: trift, phase: 'preparing', startedAt: 1 };
    expect((await controller(open).preflight(trift, {})).blockers.map((b) => b.code)).toContain('transaction_open');

    const self = new World();
    expect((await controller(self).preflight(mac, {})).blockers.map((b) => b.code)).toContain('identity_mismatch');
  });
});

describe('rest choices and blockers after Begin', () => {
  it('freezes again under the same handover with the user\'s new choices, instead of aborting', async () => {
    const w = new World();
    w.source.blockedAgent = true;
    const decided: Blocker[][] = [];
    const out = await controller(w, { decide: async (blockers) => { decided.push(blockers); return { interruptAfterMs: 0 }; } }).start(trift, { terminateShells: true });
    expect(out.status).toBe('complete');
    expect(decided).toEqual([[expect.objectContaining({ code: 'agent_blocked' })]]);
    expect(w.source.freezes).toEqual([{ terminateShells: true }, { interruptAfterMs: 0 }]);
    expect(w.ops).not.toContain('gateway:abort');
    // the choices the run holds ride along, for whoever answers from elsewhere to build on
    expect(w.events).toContainEqual({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: decided[0], choices: { terminateShells: true } } });
  });

  it('takes a refusal whose blockers are not blockers as one blocker saying what the daemon said', async () => {
    const w = new World();
    let asked = 0;
    const freeze = w.source.answers['handover.freeze'];
    w.source.answers['handover.freeze'] = ((p: never) => {
      if (asked++ === 0) throw new Refused('blocked', 'bo is waiting on an answer', { blockers: [{ code: 'agent_blocked', entity: { kind: 'character', id: 'c_bo' } }] });
      return (freeze as (x: never) => unknown)(p);
    }) as never;
    const decided: Blocker[][] = [];
    await controller(w, { decide: async (blockers) => { decided.push(blockers); return {}; } }).start(trift, {});
    expect(decided).toEqual([[{ code: 'path_unsupported', message: 'bo is waiting on an answer' }]]);
  });

  it('says where it stands again once a decision is answered, so a replayed stream never shows it still pending', async () => {
    const rest = new World();
    rest.source.blockedAgent = true;
    await controller(rest, { decide: async () => ({ interruptAfterMs: 0 }) }).start(trift, {});
    const asked = rest.events.findIndex((e) => e.event === 'handover.blocked');
    expect(rest.events[asked + 1]).toEqual({ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'freeze' } });

    const claim = new World();
    const claimed0 = claim.destination.answers['handover.claim'];
    claim.destination.answers['handover.claim'] = ((p: never) => { if (!claim.destination.archived.length) claim.destination.diverged.add('r_app'); return claimed0(p); }) as never;
    expect((await controller(claim, { decide: async () => ({ archiveRoots: ['r_app'] }) }).start(trift, {})).status).toBe('complete');
    const claimed = claim.events.findIndex((e) => e.event === 'handover.blocked');
    expect(claim.events[claimed + 1]).toEqual({ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'transfer' } });

    const prep = new World();
    const prepared0 = prep.destination.answers['handover.prepare'];
    let refused = 0;
    prep.destination.answers['handover.prepare'] = ((p: never) => {
      if (refused++ < 1) {
        throw new Refused('blocked', '/home/ada/app changed since it was copied', { blockers: [{ code: 'destination_diverged', message: '/home/ada/app changed since it was copied', entity: { kind: 'root', id: 'r_app' } }] });
      }
      return prepared0(p);
    }) as never;
    expect((await controller(prep, { decide: async () => ({}) }).start(trift, {})).status).toBe('complete');
    const asked2 = prep.events.findIndex((e) => e.event === 'handover.blocked');
    expect(prep.events[asked2]).toMatchObject({ data: { phase: 'prepare' } });
    expect(prep.events[asked2 + 1]).toEqual({ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'prepare' } });
  });

  it('takes Interrupt and carry chosen while the rest still waits, by asking the source to freeze again', async () => {
    const w = new World();
    let release!: () => void;
    w.source.working = { waiting: new Promise<void>((r) => { release = r; }), release: () => release() };
    const c = controller(w);
    const run = c.start(trift, {});
    while (!w.ops.includes('mac:handover.freeze')) await new Promise((r) => setImmediate(r));
    c.choose({ interruptAfterMs: 0 });
    const out = await run;
    w.source.working.release();
    expect(out.status).toBe('complete');
    expect(w.source.freezes).toEqual([{}, { interruptAfterMs: 0 }]);
    expect(w.ops.filter((op) => op === 'gateway:begin')).toHaveLength(1);
  });

  it('takes a decision\'s answer as the whole of the choices, so a choice the user turned off is dropped', async () => {
    const w = new World();
    w.source.blockedAgent = true;
    const out = await controller(w, { decide: async () => ({ interruptAfterMs: 0 }) }).start(trift, { terminateShells: true });
    expect(out.status).toBe('complete');
    expect(w.source.freezes).toEqual([{ terminateShells: true }, { interruptAfterMs: 0 }]);
  });

  it('lets a freeze asked with older choices go once new ones are chosen, so its retry never asks again with them', async () => {
    const w = new World();
    let wake!: () => void;
    const freeze = w.source.answers['handover.freeze'];
    let sent = 0;
    // the first Freeze's answer is lost, and its retry waits while the user chooses again
    w.source.answers['handover.freeze'] = ((p: never) => { if (sent++ === 0) throw new Error('trift: connection reset'); return freeze(p); }) as never;
    const c = controller(w, { clock: { now: () => w.now, sleep: () => new Promise<void>((r) => { wake = r; }) } });
    const run = c.start(trift, {});
    while (!w.events.some((e) => e.event === 'handover.retry' && e.data.phase === 'freeze')) await new Promise((r) => setImmediate(r));
    c.choose({ interruptAfterMs: 0 });
    expect((await run).status).toBe('complete');
    wake();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(w.source.freezes).toEqual([{ interruptAfterMs: 0 }]);
    expect(sent).toBe(2);
  });

  it('aborts, gateway first, when the user cancels at a blocker, and the fleet is the source\'s again', async () => {
    const w = new World();
    w.destination.diverged.add('r_app');
    let asked = 0;
    const out = await controller(w, { decide: async () => { asked++; return 'cancel'; } }).start(trift, {});
    expect(asked).toBe(0);
    expect(out.status).toBe('blocked');
    // preflight found the diverged root before anything began
    expect(w.ops).not.toContain('gateway:begin');

    const later = new World();
    const c = controller(later, { decide: async () => 'cancel' });
    // the root diverges only after preflight
    const claim = later.destination.answers['handover.claim'];
    later.destination.answers['handover.claim'] = ((p: never) => { later.destination.diverged.add('r_app'); return claim(p); }) as never;
    const out2 = await c.start(trift, {});
    expect(out2).toMatchObject({ status: 'blocked', phase: 'transfer', blockers: [expect.objectContaining({ code: 'destination_diverged' })] });
    expect(opIndex(later, 'gateway:abort')).toBeLessThan(opIndex(later, 'mac:handover.abort'));
    expect(settledOn(later)).toBe('source');
  });

  it('archives a diverged root the user names, and carries on', async () => {
    const w = new World();
    const claim = w.destination.answers['handover.claim'];
    w.destination.answers['handover.claim'] = ((p: never) => { if (!w.destination.archived.length) w.destination.diverged.add('r_app'); return claim(p); }) as never;
    const out = await controller(w, { decide: async () => ({ archiveRoots: ['r_app'] }) }).start(trift, {});
    expect(out.status).toBe('complete');
    expect(w.destination.archived).toEqual(['r_app']);
    // where the replica went stays on the root's row through every line of its copy, as no failure
    const rows = w.events.flatMap((e) => (e.event === 'handover.entity' && e.data.id === 'r_app' ? [e.data] : []));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.archivedTo === '/Users/ada/app.archived-1' && r.error === undefined)).toBe(true);
  });

  it('says why a transfer that failed before its first entry stopped', async () => {
    const w = new World();
    w.transferResult = (o) => ({
      status: 'failed', blockers: [], entries: o.entries.map((e) => ({ id: e.id, status: 'pending' as const })),
      failure: { reason: 'disconnected', code: 255, error: 'the far machine did not answer rsync --version: Connection reset' },
    });
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'transfer', error: 'the far machine did not answer rsync --version: Connection reset', safe: ['resume', 'abort'] });
  });

  it('stops without preparing when the transfer refuses an entry, and leaves the choice to resume or abort', async () => {
    const w = new World();
    w.transferResult = (o) => ({
      status: 'failed', blockers: [],
      entries: o.entries.map((e, i) => (i === 0 ? { id: e.id, status: 'failed' as const, reason: 'refused' as const, code: null, error: 'ENOSPC: no space left on device' } : { id: e.id, status: 'verified' as const, passes: 1, files: [] })),
    });
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'transfer', error: expect.stringContaining('ENOSPC'), safe: ['resume', 'abort'] });
    expect(w.ops).not.toContain('trift:handover.prepare');
    expect(w.ops).not.toContain('gateway:abort');
    w.transferResult = undefined;
    await recover(w, 'abort');
    expect(settledOn(w)).toBe('source');
  });

  it('says on a refused entry\'s row why it failed', async () => {
    const w = new World();
    const error = 'ENOSPC: no space left on device';
    w.transferResult = (o) => {
      const [e] = o.entries;
      o.onProgress?.({ id: e.id, kind: e.kind, state: 'failed', pass: 1, done: 0, total: 2, bytes: 0, totalBytes: 64, items: 0, error, updatedAt: 0 });
      return { status: 'failed', blockers: [], entries: [{ id: e.id, status: 'failed', reason: 'refused', code: null, error }] };
    };
    await controller(w).start(trift, {});
    const row = w.events.find((x) => x.event === 'handover.entity' && x.data.id === 'r_app');
    expect(row).toMatchObject({ data: { kind: 'root', phase: 'transfer', error } });
  });
});

describe('resuming after the destination prepared', () => {
  it('never copies into a prepared root again, even when what the transfer verified is lost', async () => {
    const probe = new World();
    await controller(probe).start(trift, {});
    // the controller dies once the destination has prepared, before it has written down the proof
    const w = new World();
    w.fault = { at: opIndex(probe, 'trift:handover.prepare'), kind: 'death' };
    await controller(w).start(trift, {});
    expect(w.destination.journal?.preparedDigest).toBeDefined();
    expect(w.store.j).toMatchObject({ phase: 'prepare' });
    expect(w.store.j?.preparedDigest).toBeUndefined();
    w.store.files.delete('tx-1/landed');
    const transfers = w.transfers.length;
    const [out] = await recover(w);
    expect(out.status).toBe('complete');
    expect(w.transfers.length).toBe(transfers);
    expect(settledOn(w)).toBe('destination');
  });

  it('resumed or aborted from a machine that is neither source nor destination, stops naming both, before anything is copied or let go', async () => {
    const probe = new World();
    await controller(probe).start(trift, {});
    const w = new World();
    w.fault = { at: opIndex(probe, 'mac:handover.freeze'), kind: 'death' };
    await controller(w).start(trift, {});
    w.store.j = undefined;
    w.store.files.clear();
    await w.heal();
    // a third machine reaches both parties over ssh, as a Mac does a handover between two Linux machines
    const elsewhere = { local: MachineId.parse(crypto.randomUUID()), side: async (id: typeof mac) => ({ ...w.side(id), master: async () => w.masters.trift }) };
    const ops = w.ops.length;
    for (const run of [(c: Handover) => c.resume(), (c: Handover) => c.abort()]) {
      const out = await run(controller(w, elsewhere));
      expect(out).toMatchObject({ status: 'interrupted', safe: [], error: expect.stringMatching(/neither the source mac nor the destination trift.*on mac or trift/) });
    }
    expect(w.transfers).toEqual([]);
    expect(w.ops.slice(ops).filter((op) => !/status|ownership\.get|gateway:get/.test(op))).toEqual([]);
    expect(w.store.j).toBeUndefined();
  });

  it('never runs a transfer whose parties are both reached over ssh, whatever its journal says', async () => {
    const w = new World();
    const out = await controller(w, { side: async (id) => ({ ...w.side(id), master: async () => w.masters.trift }) }).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'transfer', error: expect.stringContaining('both reached over ssh') });
    expect(w.transfers).toEqual([]);
  });

  it('goes on from the prepared state when its journal is rebuilt from the daemons\', without copying again', async () => {
    const probe = new World();
    await controller(probe).start(trift, {});
    const w = new World();
    w.fault = { at: opIndex(probe, 'trift:handover.prepare'), kind: 'death' };
    await controller(w).start(trift, {});
    // this controller's journal is gone, as for a controller on another machine
    w.store.j = undefined;
    w.store.files.clear();
    const transfers = w.transfers.length;
    const [out] = await recover(w);
    expect(out.status).toBe('complete');
    expect(w.transfers.length).toBe(transfers);
    expect(phases(w).slice(phases(w).lastIndexOf('prepare'))).toEqual(['prepare', 'ready', 'commit', 'activate', 'complete']);
    expect(settledOn(w)).toBe('destination');
  });
});

describe('cancellation', () => {
  it('asked while Freeze is being readied, sends no Freeze, so nothing is rested', async () => {
    const w = new World();
    const c = controller(w);
    const info = w.destination.answers['system.info'];
    let asked = 0;
    // preflight asks once; the Freeze step asks again just before it sends Freeze
    w.destination.answers['system.info'] = ((p: never) => { if (++asked === 2) c.cancel(); return info(p); }) as never;
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
    expect(w.ops).not.toContain('mac:handover.freeze');
    expect(w.source.freezes).toEqual([]);
    expect(w.source.revived).toBe(0);
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a call waits to be tried again, does not send it again', async () => {
    const w = new World();
    const info = w.destination.answers['system.info'];
    let asked = 0;
    w.destination.answers['system.info'] = ((p: never) => { if (++asked === 2) throw new Error('trift: connection reset'); return info(p); }) as never;
    const c: Handover = controller(w, { clock: { now: () => w.now, sleep: async () => { c.cancel(); } } });
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
    expect(asked).toBe(2);
    expect(w.ops).not.toContain('mac:handover.freeze');
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a Begin whose answer was lost waits to be asked again, closes the handover the gateway opened', async () => {
    const w = new World();
    const c = controller(w);
    const begin = w.gateway.begin;
    let first = true;
    w.gateway.begin = async (p) => {
      const r = await begin(p);
      if (!first) return r;
      first = false;
      c.cancel();
      throw new Error('ssh: the connection to trift closed before the answer');
    };
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1', phase: 'begin' });
    expect(w.ops).not.toContain('mac:handover.freeze');
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a Begin whose answer was lost waits, and the gateway cannot then say whether it opened it, keeps its journal for the abort', async () => {
    const w = new World();
    const c = controller(w);
    const begin = w.gateway.begin;
    w.gateway.begin = async (p) => {
      await begin(p);
      c.cancel();
      w.down.add('gateway');
      throw new Error('ssh: the connection to trift closed before the answer');
    };
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'begin', safe: ['abort'], error: expect.stringContaining('cannot say whether it opened') });
    expect(w.store.j).toMatchObject({ phase: 'begin' });
    expect(w.record.transaction).toMatchObject({ id: 'tx-1', phase: 'preparing' });
    await recover(w, 'abort');
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a Freeze waits out its backoff, stops waiting at once', async () => {
    const w = new World();
    const freeze = w.source.answers['handover.freeze'];
    let sent = 0;
    w.source.answers['handover.freeze'] = ((p: never) => { if (sent++ === 0) throw new Error('mac: connection reset'); return freeze(p); }) as never;
    // a backoff that would last for ever unless the cancel ends it
    const c = controller(w, { clock: { now: () => w.now, sleep: () => new Promise<void>(() => undefined) } });
    const run = c.start(trift, {});
    while (!w.events.some((e) => e.event === 'handover.retry')) await new Promise((r) => setImmediate(r));
    c.cancel();
    const out = await Promise.race([run, new Promise<'hung'>((r) => { setTimeout(() => r('hung'), 1000); })]);
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
    expect(sent).toBe(1);
    expect(settledOn(w)).toBe('source');
  });

  it('asked once Ready is recorded, sends no Commit and aborts, gateway first', async () => {
    const w = new World();
    const c = controller(w);
    const ready = w.gateway.ready;
    w.gateway.ready = async (p) => { const r = await ready(p); c.cancel(); return r; };
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
    expect(w.ops).not.toContain('gateway:commit');
    expect(opIndex(w, 'gateway:abort')).toBeLessThan(opIndex(w, 'mac:handover.abort'));
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a Commit\'s fate is unknown, never sends it again, and stops with the abort on offer while the gateway still holds it ready', async () => {
    const w = new World();
    const c = controller(w);
    // the Commit never reaches the gateway, and its answer never comes back
    w.gateway.commit = async () => { w.ops.push('gateway:commit'); c.cancel(); throw new Error('ssh: the connection to trift closed'); };
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'commit', safe: expect.arrayContaining(['abort']) });
    expect(w.ops.filter((op) => op === 'gateway:commit')).toHaveLength(1);
    expect(w.ops.slice(opIndex(w, 'gateway:commit'))).toContain('gateway:get');
    expect(w.record.transaction?.phase).toBe('ready-to-commit');
    expect(w.ops).not.toContain('mac:handover.abort');
    expect(w.destination.activated).toBe(false);
    await recover(w, 'abort');
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a Commit\'s fate is unknown, goes on to activation when the gateway says it committed', async () => {
    const w = new World();
    const c = controller(w);
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => { await commit(p); c.cancel(); throw new Error('ssh: the connection to trift closed'); };
    const out = await c.start(trift, {});
    expect(out).toEqual({ status: 'detached', transactionId: 'tx-1' });
    expect(await c.finished).toMatchObject({ status: 'complete' });
    expect(w.ops.filter((op) => op === 'gateway:commit')).toHaveLength(1);
    expect(w.ops).not.toContain('gateway:abort');
    expect(settledOn(w)).toBe('destination');
  });

  it('before Freeze, clears the Begin and leaves the source untouched', async () => {
    const w = new World();
    const c = controller(w);
    const begin = w.gateway.begin;
    w.gateway.begin = async (p) => { const r = await begin(p); c.cancel(); return r; };
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'aborted', phase: 'begin' });
    expect(w.ops).not.toContain('mac:handover.freeze');
    expect(w.source.frozen).toBe(false);
    expect(settledOn(w)).toBe('source');
  });

  it('after Freeze, aborts at the gateway first and then gives the source its fleet back', async () => {
    const w = new World();
    let release!: () => void;
    w.transferWait = new Promise((r) => { release = r; });
    const c = controller(w);
    const run = c.start(trift, {});
    while (!w.ops.includes('transfer:run')) await new Promise((r) => setImmediate(r));
    c.cancel();
    release();
    const out = await run;
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
    expect(opIndex(w, 'gateway:abort')).toBeLessThan(opIndex(w, 'mac:handover.abort'));
    expect(w.source.revived).toBe(1);
    expect(settledOn(w)).toBe('source');
  });

  it('after Commit, only stops telling the observer, and the move goes on to completion', async () => {
    const w = new World();
    const c = controller(w);
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => { const r = await commit(p); c.cancel(); return r; };
    const out = await c.start(trift, {});
    expect(out).toEqual({ status: 'detached', transactionId: 'tx-1' });
    const seen = w.events.length;
    expect(await c.finished).toMatchObject({ status: 'complete' });
    expect(w.events.length).toBe(seen);
    expect(w.ops).not.toContain('gateway:abort');
    expect(settledOn(w)).toBe('destination');
  });

  it('hands the gateway\'s record of the moved fleet to whatever routes to it next', async () => {
    const w = new World();
    const moved: OwnerRecord[] = [];
    expect((await controller(w, { moved: (r) => moved.push(r) }).start(trift, {})).status).toBe('complete');
    expect(moved).toEqual([{ fleetId, generation: G + 1, ownerMachineId: trift }]);
  });

  it('after Commit, still hands every event to the record it keeps, the rest of the move and its result included', async () => {
    const w = new World();
    const recorded: HandoverEvent[] = [];
    const c = controller(w, { record: (e) => recorded.push(e) });
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => { const r = await commit(p); c.cancel(); return r; };
    expect(await c.start(trift, {})).toEqual({ status: 'detached', transactionId: 'tx-1' });
    const seen = w.events.length;
    await c.finished;
    expect(w.events.length).toBe(seen);
    expect(recorded.slice(0, seen)).toEqual(w.events);
    expect(recorded).toContainEqual({ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'activate' } });
    expect(recorded.at(-1)).toEqual({ event: 'handover.result', data: expect.objectContaining({ status: 'complete' }) });
  });

  it('relays what a daemon reports of its own rest and activation to the watcher and the record alike', async () => {
    const w = new World();
    const recorded: HandoverEvent[] = [];
    const c = controller(w, { record: (e) => recorded.push(e) });
    const row: HandoverEvent = { event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id: 'c_ada', phase: 'freeze' } };
    c.relay(row);
    expect(w.events).toEqual([row]);
    expect(recorded).toEqual([row]);
  });

  it('while activation runs, lets the watcher go at once and leaves activation to finish', async () => {
    const w = new World();
    let release!: () => void;
    const starting = new Promise<void>((r) => { release = r; });
    const activate = w.destination.answers['handover.activate'];
    w.destination.answers['handover.activate'] = (async (p: never) => { await starting; return activate(p); }) as never;
    const c = controller(w);
    const run = c.start(trift, {});
    while (!w.ops.includes('trift:handover.activate')) await new Promise((r) => setImmediate(r));
    c.cancel();
    expect(await run).toEqual({ status: 'detached', transactionId: 'tx-1' });
    release();
    expect(await c.finished).toMatchObject({ status: 'complete' });
    expect(w.ops).not.toContain('gateway:abort');
    expect(settledOn(w)).toBe('destination');
  });
});

describe('an unknown commit', () => {
  it('asks the gateway, and goes forward when it committed', async () => {
    const w = new World();
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => { await commit(p); throw new Error('ssh: the connection to trift closed'); };
    const out = await controller(w).start(trift, {});
    expect(out.status).toBe('complete');
    expect(w.ops.filter((op) => op === 'gateway:commit')).toHaveLength(1);
    expect(settledOn(w)).toBe('destination');
  });

  it('never aborts the source while the gateway cannot say, and a later resume finds the commit', async () => {
    const w = new World();
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => { await commit(p); w.down.add('gateway'); throw new Error('ssh: the connection to trift closed'); };
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'commit', safe: [] });
    expect(w.ops).not.toContain('mac:handover.abort');
    expect(w.source.frozen).toBe(true);
    w.gateway.commit = commit;
    await recover(w);
    expect(settledOn(w)).toBe('destination');
  });

  it('refuses an abort asked once the gateway has committed, and only goes forward', async () => {
    const w = new World();
    const activate = w.destination.answers['handover.activate'];
    w.destination.answers['handover.activate'] = (() => { throw new Error('trift went to sleep'); }) as never;
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'activate', safe: ['resume'] });
    const abort = await controller(w).abort();
    expect(abort).toMatchObject({ status: 'interrupted', safe: ['resume'] });
    expect(w.ops).not.toContain('gateway:abort');
    w.destination.answers['handover.activate'] = activate;
    await recover(w);
    expect(settledOn(w)).toBe('destination');
  });
});

describe('Complete', () => {
  it('seals and closes the destination first, finishes the source when it can, and a resume finishes it later', async () => {
    const w = new World();
    const complete = w.source.answers['handover.complete'];
    w.source.answers['handover.complete'] = (() => { throw new Error('the Mac\'s daemon is restarting'); }) as never;
    const out = await controller(w).start(trift, {});
    // why the source is still to finish is said, not dropped
    expect(out).toMatchObject({ status: 'complete', pending: ['source'], error: expect.stringContaining('restarting') });
    expect(w.destination.sealed).toBe(true);
    expect(w.record).toEqual({ fleetId, generation: G + 1, ownerMachineId: trift });
    // the source stays fenced by its own journal meanwhile
    expect(w.source.running).toBe(false);
    expect(w.store.j).toMatchObject({ phase: 'complete' });
    w.source.answers['handover.complete'] = complete;
    const [again] = await recover(w);
    expect(again).toMatchObject({ status: 'complete' });
    expect(settledOn(w)).toBe('destination');
  });
});

describe('a far machine that is down', () => {
  // a far side is built only once its daemon answers, as reach.ts builds one
  const eager = (w: World) => ({
    side: async (id: MachineId) => {
      const port = id === mac ? 'mac' : 'trift';
      if (w.down.has(port)) throw new Error(`${port} did not answer: connection refused`);
      return w.side(id);
    },
  });

  it('on an abort once the gateway let go, still gives the source its fleet back, and keeps the journal until the destination lets go', async () => {
    const probe = new World();
    await controller(probe).start(trift, {});
    const w = new World();
    w.fault = { at: opIndex(probe, 'trift:handover.prepare'), kind: 'death' };
    await controller(w).start(trift, {});
    await w.heal();
    w.down.add('trift');
    const out = await controller(w, eager(w)).abort();
    expect(out).toMatchObject({ status: 'interrupted', safe: expect.arrayContaining(['abort']) });
    expect(w.record).toEqual({ fleetId, generation: G, ownerMachineId: mac });
    expect(w.source.running).toBe(true);
    expect(w.destination.journal).toBeDefined();
    expect(w.store.j).toMatchObject({ phase: 'aborted' });
    await recover(w, 'abort');
    expect(settledOn(w)).toBe('source');
  });

  it('after the commit, activates and completes the destination here while the source is down, and a resume finishes the source once it answers', async () => {
    const probe = new World({ pull: true });
    await controller(probe).start(mac, {});
    const w = new World({ pull: true });
    w.fault = { at: opIndex(probe, 'gateway:commit'), kind: 'death' };
    await controller(w).start(mac, {});
    await w.heal();
    w.down.add('trift');
    const out = await controller(w, eager(w)).resume();
    expect(out).toMatchObject({ status: 'complete', pending: ['source'], error: expect.stringContaining('trift did not answer') });
    expect(w.destination.activated).toBe(true);
    expect(w.record).toEqual({ fleetId, generation: G + 1, ownerMachineId: mac });
    await recover(w);
    expect(settledOn(w)).toBe('destination');
  });

  // a push whose controller died at `op` and whose journal is gone, as when it ran on the other machine
  const lostAt = async (op: string): Promise<World> => {
    const probe = new World();
    await controller(probe).start(trift, {});
    const w = new World();
    w.fault = { at: opIndex(probe, op), kind: 'death' };
    await controller(w).start(trift, {});
    w.store.j = undefined;
    w.store.files.clear();
    await w.heal();
    return w;
  };

  it('with no journal here, on an abort from the source, gives the source its fleet back while the destination is down', async () => {
    const w = await lostAt('trift:handover.prepare');
    w.down.add('trift');
    const out = await controller(w, eager(w)).abort();
    expect(out).toMatchObject({ status: 'interrupted', safe: expect.arrayContaining(['abort']) });
    expect(w.record).toEqual({ fleetId, generation: G, ownerMachineId: mac });
    expect(w.source.running).toBe(true);
    expect(w.store.j).toMatchObject({ transactionId: 'tx-1', phase: 'aborted' });
    await recover(w, 'abort');
    expect(settledOn(w)).toBe('source');
  });

  it('with no journal here, after the commit, activates and completes the destination here while the source is down', async () => {
    const w = await lostAt('gateway:commit');
    w.down.add('mac');
    const out = await controller(w, { ...eager(w), local: trift }).resume();
    expect(out).toMatchObject({ status: 'complete', transactionId: 'tx-1', pending: ['source'] });
    expect(w.destination.activated).toBe(true);
    await recover(w);
    expect(settledOn(w)).toBe('destination');
  });

  it('with no journal here, stops an abort while the source is down and nothing says how far it got, and lets nothing go', async () => {
    const w = await lostAt('mac:handover.freeze');
    expect(w.source.frozen).toBe(true);
    w.down.add('mac');
    const ops = w.ops.length;
    const out = await controller(w, { ...eager(w), local: trift }).abort();
    expect(out).toMatchObject({ status: 'interrupted', safe: expect.arrayContaining(['abort']), error: expect.stringContaining('the source did not say how far it got') });
    expect(w.ops.slice(ops).filter((op) => !/status|ownership\.get|gateway:get/.test(op))).toEqual([]);
    expect(w.record.transaction).toMatchObject({ id: 'tx-1', phase: 'preparing' });
    await recover(w, 'abort');
    expect(settledOn(w)).toBe('source');
  });

  it('with no journal here, stops a resume while the source is down and nothing says how far it got, so a later abort still lets the source go', async () => {
    const w = await lostAt('mac:handover.freeze');
    w.down.add('mac');
    const out = await controller(w, { ...eager(w), local: trift }).resume();
    expect(out).toMatchObject({ status: 'interrupted', error: expect.stringContaining('the source did not say how far it got') });
    expect(w.store.j).toBeUndefined();
    await recover(w, 'abort');
    expect(settledOn(w)).toBe('source');
  });

  it('with no journal here, after the destination completed, still finishes a committed handover while the source is down and nothing says how far it got', async () => {
    const w = await lostAt('trift:handover.complete');
    w.down.add('mac');
    const out = await controller(w, { ...eager(w), local: trift }).resume();
    expect(out).toMatchObject({ status: 'complete', transactionId: 'tx-1', pending: ['source'] });
    await recover(w);
    expect(settledOn(w)).toBe('destination');
  });
});

describe('resuming a handover the destination may have finished', () => {
  const committedWorld = (): World => {
    const w = new World();
    w.record = { fleetId, generation: G + 1, ownerMachineId: trift, transaction: { id: 'tx-1', fromMachineId: mac, toMachineId: trift, phase: 'committed', startedAt: 1 } };
    w.source.journal = { tx: 'tx-1', generation: G, phase: 'freeze', digest: 'x' };
    w.source.frozen = true;
    w.source.kept = manifestFor('tx-1');
    w.store.j = {
      version: 1, fleetId, transactionId: 'tx-1', generation: G, choices: {}, phase: 'commit', startedAt: 1, updatedAt: 1,
      source: { machineId: mac, name: 'mac' }, destination: { machineId: trift, name: 'trift', ssh: 'trift' },
    };
    return w;
  };

  it('never completes over a destination journal that could not be read, and offers nothing until it is looked at', async () => {
    const w = committedWorld();
    w.destination.answers['handover.status'] = (() => ({ quarantined: '/home/ada/.svall/handover/journal.json.broken-1' })) as never;
    const out = await controller(w).resume();
    expect(out).toMatchObject({ status: 'interrupted', safe: [], error: expect.stringContaining('journal.json.broken-1') });
    expect(w.ops).not.toContain('gateway:complete');
    expect(w.ops).not.toContain('mac:handover.complete');
    expect(w.record.transaction?.phase).toBe('committed');
  });

  it('counts the destination done only when it owns the fleet at the generation the handover moved it to', async () => {
    const w = committedWorld();
    // the destination holds no journal, and never took the fleet
    w.destination.answers['ownership.get'] = (() => ({ fleetId, generation: G, ownerMachineId: mac, frozen: false })) as never;
    const out = await controller(w).resume();
    expect(out.status).toBe('interrupted');
    expect(w.ops).toContain('trift:handover.activate');
    expect(w.ops).not.toContain('gateway:complete');
    expect(w.record.transaction?.phase).toBe('committed');
  });

  it('finishes a handover the gateway has moved on past without leaving the gateway pending', async () => {
    const w = committedWorld();
    w.destination.journal = { tx: 'tx-1', generation: G + 1, phase: 'activate', preparedDigest: 'p' };
    w.destination.activated = true;
    // a later handover took the fleet on to G + 2 on the destination
    w.record = { fleetId, generation: G + 2, ownerMachineId: trift };
    const out = await controller(w).resume();
    expect(out).toEqual({ status: 'complete', transactionId: 'tx-1', generation: G + 1, characters: [] });
    expect(w.store.j).toBeUndefined();
  });

  it('never reports an aborted handover complete once the fleet moved on without it', async () => {
    const w = committedWorld();
    w.store.j = { ...w.store.j!, phase: 'aborted' };
    w.source.journal = undefined;
    w.source.frozen = false;
    w.record = { fleetId, generation: G + 1, ownerMachineId: trift };
    const c = controller(w);
    expect((await c.status()).verdict).toMatchObject({ standing: 'superseded', safe: [] });
    const out = await c.resume();
    expect(out).toMatchObject({ status: 'interrupted', safe: [] });
    expect(w.ops).not.toContain('trift:handover.complete');
  });
});

describe('reading the controller journal', () => {
  it('only a run that writes the journal sets aside one it cannot read; status never does', async () => {
    const w = new World();
    await controller(w).status();
    expect(w.store.asides).toEqual([false]);
    await controller(w).resume();
    await controller(w).abort();
    await controller(w).start(trift, {});
    expect(w.store.asides.slice(1, 4)).toEqual([true, true, true]);
  });

  it('refuses to start over a journal a run left open here, asks no one anything and keeps it, so only a resume goes on', async () => {
    const probe = new World();
    await controller(probe).start(trift, {});
    const w = new World();
    w.fault = { at: opIndex(probe, 'gateway:begin'), kind: 'death' };
    await controller(w).start(trift, {});
    await w.heal();
    const open = structuredClone(w.store.j);
    expect(open).toMatchObject({ phase: 'begin' });
    const ops = w.ops.length;
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'begin', safe: ['resume'] });
    expect(w.ops.slice(ops)).toEqual([]);
    expect(w.store.j).toEqual(open);
    await recover(w);
    expect(settledOn(w)).toBe('destination');
  });
});

describe('observing the journals', () => {
  it('asks each daemon its status and ownership at once', async () => {
    const w = new World();
    w.store.j = { version: 1, fleetId, transactionId: 'tx-9', generation: G, source: w.side(mac).route, destination: w.side(trift).route, choices: {}, phase: 'freeze', startedAt: 1, updatedAt: 1 };
    // each status answers only once its machine's ownership has been asked, as it would of a caller asking both at once
    for (const d of [w.source, w.destination]) {
      let owned!: () => void;
      const asked = new Promise<void>((r) => { owned = r; });
      const [status, ownership] = [d.answers['handover.status'], d.answers['ownership.get']] as ((p: never) => unknown)[];
      d.answers['handover.status'] = (async (p: never) => { await asked; return status(p); }) as never;
      d.answers['ownership.get'] = ((p: never) => { owned(); return ownership(p); }) as never;
    }
    const seen = await Promise.race([controller(w).status(), new Promise<'stuck'>((r) => { setTimeout(() => r('stuck'), 2000); })]);
    expect(seen).not.toBe('stuck');
  });

  it('asks each machine its status only once when no journal names them', async () => {
    const w = new World();
    w.source.journal = { tx: 'tx-9', generation: G, phase: 'freeze' };
    w.source.frozen = true;
    await controller(w).status();
    expect(w.ops.filter((op) => op.endsWith(':handover.status'))).toEqual(['mac:handover.status', 'trift:handover.status']);
  });
});

describe('the real adapters', () => {
  it('finishes a committed handover and caches the route to its new owner, which owner resolution then reads', async () => {
    const ssh = installFakeSsh();
    const prefix = makeHome();
    const home = makeHome();
    const saved = process.env.SVALL_GATEWAY_PREFIX;
    process.env.SVALL_GATEWAY_PREFIX = prefix;
    const authority = await startAuthorityServer({ prefix });
    const daemons: WebSocketServer[] = [];
    // a daemon that answers what finishing a handover asks of it
    const daemon = async (answers: Record<string, unknown>): Promise<number> => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      daemons.push(wss);
      await new Promise((r) => wss.once('listening', r));
      wss.on('connection', (ws) => {
        let authed = false;
        ws.on('message', (raw) => {
          if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
          const req = JSON.parse(raw.toString()) as { id: number; method: string };
          ws.send(JSON.stringify({ id: req.id, result: answers[req.method] ?? {} }));
        });
      });
      return (wss.address() as { port: number }).port;
    };
    try {
      const registry = MachineRegistry.load(makeHome());
      registry.add({
        name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
        home: '/home/ada', svallBase: '/home/ada/.local/share/svall', gateway: false,
      }, trift);
      const fleet = FleetId.parse(crypto.randomUUID());
      const local = registry.localId;
      // the gateway, here, holds the handover to trift committed at generation 1
      const client = await AuthorityClient.connect(prefix);
      await client.create({ fleetId: fleet, initialOwnerMachineId: local });
      const begun = await client.begin({ fleetId: fleet, expectedGeneration: 0, fromMachineId: local, toMachineId: trift });
      const tx = begun.transaction!.id;
      await client.ready({ fleetId: fleet, transactionId: tx, expectedGeneration: 0, preparedDigest: 'd'.repeat(64), sourceFrozen: true });
      await client.commit({ fleetId: fleet, transactionId: tx, expectedGeneration: 0 });
      client.close();

      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: fleet, gatewayMachineId: local }));
      fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(home, 'port'), String(await daemon({
        'handover.status': {}, 'ownership.get': { fleetId: fleet, generation: 0, ownerMachineId: local, frozen: true },
      })));
      fs.writeFileSync(path.join(home, 'token'), `${TOKEN}\n`);
      ssh.answer({
        fleetId: fleet, machineId: trift, release: 'dev', protocol: PROTOCOL_VERSION, host: '127.0.0.1', token: 'trift-token', generation: 1, fleetHome: '/home/ada/.svall',
        port: await daemon({ 'handover.status': {}, 'ownership.get': { fleetId: fleet, generation: 1, ownerMachineId: trift, frozen: false } }),
      });
      fileStore(path.join(home, 'controller')).write({
        version: 1, fleetId: fleet, transactionId: tx, generation: 0, choices: {}, phase: 'activate', startedAt: 1, updatedAt: 1,
        source: { machineId: local, name: registry.localMachine().name }, destination: { machineId: trift, name: 'trift', ssh: 'trift.test' },
      });

      const c = connectHandover({ fleetHome: home, registry });
      try {
        expect(await c.handover.resume()).toMatchObject({ status: 'complete', transactionId: tx, generation: 1 });
      } finally {
        await c.close();
      }
      expect(readRoute(home)).toMatchObject({ ownerMachineId: trift, generation: 1 });
      // this gateway has no ssh route from here, so the cached route is what leads to the fleet
      const owner = await resolveOwner(home, { deps: { registry, openMaster: (d) => SshMaster.open({ destination: d, socketDir: ssh.socketDir }), now: () => new Date() } });
      expect(owner).toMatchObject({ id: trift });
    } finally {
      process.env.SVALL_GATEWAY_PREFIX = saved;
      if (saved === undefined) delete process.env.SVALL_GATEWAY_PREFIX;
      for (const wss of daemons) await new Promise((r) => wss.close(r));
      await authority.close();
      ssh.clean();
      cleanHomes();
    }
  });

  it('rebuilds a lost journal from the registry, so an abort here lets the source go while the far destination cannot be reached', async () => {
    const ssh = installFakeSsh();
    const prefix = makeHome();
    const home = makeHome();
    const saved = process.env.SVALL_GATEWAY_PREFIX;
    process.env.SVALL_GATEWAY_PREFIX = prefix;
    const authority = await startAuthorityServer({ prefix });
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const asked: string[] = [];
    try {
      await new Promise((r) => wss.once('listening', r));
      const registry = MachineRegistry.load(makeHome());
      // an ssh that would ask for a password never opens, so trift cannot be reached
      registry.add({
        name: 'trift', ssh: 'denied.test', platform: 'linux', arch: 'arm64',
        home: '/home/ada', svallBase: '/home/ada/.local/share/svall', gateway: false,
      }, trift);
      const local = registry.localId;
      const client = await AuthorityClient.connect(prefix);
      await client.create({ fleetId, initialOwnerMachineId: local });
      const tx = (await client.begin({ fleetId, expectedGeneration: 0, fromMachineId: local, toMachineId: trift })).transaction!.id;
      // the source here froze for the handover, and this controller keeps no journal of it
      const answers: Record<string, unknown> = {
        'handover.status': { transaction: { id: tx, fromMachineId: local, toMachineId: trift, phase: 'freeze', startedAt: 1 } },
        'ownership.get': { fleetId, generation: 0, ownerMachineId: local, frozen: true },
      };
      wss.on('connection', (ws) => {
        let authed = false;
        ws.on('message', (raw) => {
          if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
          const req = JSON.parse(raw.toString()) as { id: number; method: string };
          asked.push(req.method);
          ws.send(JSON.stringify({ id: req.id, result: answers[req.method] ?? {} }));
        });
      });
      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: fleetId, gatewayMachineId: local }));
      fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
      fs.writeFileSync(path.join(home, 'token'), `${TOKEN}\n`);

      const c = connectHandover({ fleetHome: home, registry });
      try {
        expect(await c.handover.abort()).toMatchObject({ status: 'interrupted', safe: expect.arrayContaining(['abort']) });
      } finally {
        await c.close();
      }
      expect(asked).toContain('handover.abort');
      expect((await client.get({ fleetId })).transaction).toBeUndefined();
      client.close();
      expect(fileStore(path.join(home, 'controller')).read()).toMatchObject({
        transactionId: tx, phase: 'aborted', destination: { machineId: trift, name: 'trift', ssh: 'denied.test' },
      });
    } finally {
      process.env.SVALL_GATEWAY_PREFIX = saved;
      if (saved === undefined) delete process.env.SVALL_GATEWAY_PREFIX;
      await new Promise((r) => wss.close(r));
      await authority.close();
      ssh.clean();
      cleanHomes();
    }
  });

  it('hands the source the far fleet home its companion reports, not one worked out from its home', async () => {
    const ssh = installFakeSsh();
    const prefix = makeHome();
    const home = makeHome();
    const saved = process.env.SVALL_GATEWAY_PREFIX;
    process.env.SVALL_GATEWAY_PREFIX = prefix;
    const authority = await startAuthorityServer({ prefix });
    const daemons: WebSocketServer[] = [];
    const asked: Record<string, unknown>[] = [];
    const daemon = async (answers: Record<string, (p: Record<string, unknown>) => unknown>): Promise<number> => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      daemons.push(wss);
      await new Promise((r) => wss.once('listening', r));
      wss.on('connection', (ws) => {
        let authed = false;
        ws.on('message', (raw) => {
          if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
          const req = JSON.parse(raw.toString()) as { id: number; method: string; params: Record<string, unknown> };
          ws.send(JSON.stringify({ id: req.id, result: answers[req.method]?.(req.params) ?? {} }));
        });
      });
      return (wss.address() as { port: number }).port;
    };
    try {
      const registry = MachineRegistry.load(makeHome());
      registry.add({
        name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
        home: '/home/ada', svallBase: '/home/ada/.local/share/svall', gateway: false,
      }, trift);
      const local = registry.localId;
      const client = await AuthorityClient.connect(prefix);
      await client.create({ fleetId, initialOwnerMachineId: local });
      client.close();
      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: fleetId, gatewayMachineId: local }));
      fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(home, 'token'), `${TOKEN}\n`);
      fs.writeFileSync(path.join(home, 'port'), String(await daemon({
        'system.info': () => info(local),
        'ownership.get': () => ({ fleetId, generation: 0, ownerMachineId: local, frozen: false }),
        'handover.preflight': (p) => {
          asked.push(p);
          const manifest = manifestFor(undefined, local, trift);
          return { manifestSummary: { digest: manifestDigest(manifest), roots: 2, files: 5, bytes: 100, sessions: 2 }, blockers: [], warnings: [], manifest };
        },
      })));
      ssh.answer({
        fleetId, machineId: trift, release: 'dev', protocol: PROTOCOL_VERSION, host: '127.0.0.1', token: 'trift-token', generation: 0, fleetHome: '/srv/fleets/ada',
        port: await daemon({
          'system.info': () => info(trift),
          'ownership.get': () => ({ fleetId, generation: 0, ownerMachineId: local, frozen: false }),
          'handover.inspect': (p) => ({ roots: (p.roots as { id: string; path: string }[]).map((r) => ({ id: r.id, check: { ok: true, path: r.path, kind: 'absent' } })), folders: {} }),
        }),
      });
      ssh.reply(['rsync', '--version'], { stdout: 'rsync  version 3.2.7  protocol version 31\n' });

      const c = connectHandover({ fleetHome: home, registry });
      try {
        await c.handover.preflight(trift, {});
      } finally {
        await c.close();
      }
      // and each machine's home as the registry records it
      expect(asked).toEqual([expect.objectContaining({
        source: { home: registry.localMachine().home }, destination: expect.objectContaining({ home: '/home/ada', fleetHome: '/srv/fleets/ada' }),
      })]);
    } finally {
      process.env.SVALL_GATEWAY_PREFIX = saved;
      if (saved === undefined) delete process.env.SVALL_GATEWAY_PREFIX;
      for (const wss of daemons) await new Promise((r) => wss.close(r));
      await authority.close();
      ssh.clean();
      cleanHomes();
    }
  });

  it('reads a daemon\'s refusal as its answer, and a call that never answered as a client to open again', async () => {
    const opened: string[] = [];
    let clients = 0;
    let fail: 'refuse' | 'drop' | undefined;
    const daemon = reconnecting(async () => {
      const n = `client ${++clients}`;
      opened.push(n);
      return {
        call: (async () => {
          if (fail === 'refuse') throw new ApiError('blocked', 'bo is waiting on an answer', { blockers: [{ code: 'agent_blocked', message: 'bo' }] });
          if (fail === 'drop') throw new Error('svalld connection closed');
          return { answered: n };
        }) as never,
        close: () => opened.push(`${n} closed`),
        closed: false,
      };
    });
    expect(await daemon.call('state.get', {})).toEqual({ answered: 'client 1' });
    fail = 'refuse';
    const refused = await daemon.call('state.get', {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Refused);
    expect(refused).toMatchObject({ code: 'blocked', data: { blockers: [{ code: 'agent_blocked' }] } });
    fail = 'drop';
    await expect(daemon.call('state.get', {})).rejects.toThrow('connection closed');
    await new Promise((r) => setImmediate(r));
    fail = undefined;
    expect(await daemon.call('state.get', {})).toEqual({ answered: 'client 2' });
    expect(opened).toEqual(['client 1', 'client 1 closed', 'client 2']);
  });

  it('lets go only the client a failed call used, never one a later call has opened since', async () => {
    type Pending = { resolve(v: unknown): void; reject(e: Error): void };
    const clients: { calls: Pending[]; closed: boolean }[] = [];
    const daemon = reconnecting(async () => {
      const c = { calls: [] as Pending[], closed: false };
      clients.push(c);
      return {
        call: (() => new Promise((resolve, reject) => { c.calls.push({ resolve, reject }); })) as never,
        // as a socket's close lands later, the calls still out on it fail only when the test says
        close: () => { c.closed = true; },
        get closed() { return c.closed; },
      };
    });
    const tick = () => new Promise((r) => { setImmediate(r); });
    const a = daemon.call('state.get', {}).catch((e: Error) => e.message);
    const b = daemon.call('state.get', {}).catch((e: Error) => e.message);
    await tick();
    // the first client's link breaks under both calls, and a third call opens a second client between their failures
    clients[0].calls[0].reject(new Error('svalld connection closed'));
    expect(await a).toBe('svalld connection closed');
    const c = daemon.call('state.get', {});
    await tick();
    clients[0].calls[1].reject(new Error('svalld connection closed'));
    expect(await b).toBe('svalld connection closed');
    await tick();

    expect(clients).toHaveLength(2);
    expect(clients[1].closed).toBe(false);
    clients[1].calls[0].resolve({ answered: 2 });
    expect(await c).toEqual({ answered: 2 });
  });

  it('opens another client for a call when the daemon closed the last one between calls, and answers at once', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const sockets: WebSocket[] = [];
    wss.on('connection', (ws) => {
      sockets.push(ws);
      const connection = sockets.length;
      let authed = false;
      ws.on('message', (raw) => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
        ws.send(JSON.stringify({ id: (JSON.parse(raw.toString()) as { id: number }).id, result: { connection } }));
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    let last: Client | undefined;
    const daemon = reconnecting(async () => (last = await Client.connectEndpoint({ url, token: 't' })));
    try {
      expect(await daemon.call('state.get', {})).toEqual({ connection: 1 });
      // the far daemon restarts, or the master under its forward drops, while no call is out
      const closed = new Promise<void>((r) => last!.onClose(r));
      sockets[0].terminate();
      await closed;

      const at = Date.now();
      const answer = await Promise.race([daemon.call('state.get', {}), new Promise((r) => { setTimeout(() => r('no answer within 2 s'), 2000).unref(); })]);
      expect(answer).toEqual({ connection: 2 });
      expect(Date.now() - at).toBeLessThan(1000);
    } finally {
      daemon.close();
      await new Promise((r) => wss.close(r));
    }
  });

  it('stops at a prepare the destination closes on as too large to read, sent once and never again', async () => {
    const w = new World();
    const near = w.daemon('trift');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    let prepares = 0;
    let connections = 0;
    wss.on('connection', (ws) => {
      connections++;
      let authed = false;
      ws.on('message', (raw) => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
        const req = JSON.parse(raw.toString()) as { id: number; method: 'state.get'; params: never };
        if (req.method === ('handover.prepare' as string)) { prepares++; ws.close(1009, 'request too large'); return; }
        near.call(req.method, req.params).then(
          (result) => ws.send(JSON.stringify({ id: req.id, result })),
          (e: Refused) => ws.send(JSON.stringify({ id: req.id, error: { code: e.code, message: e.message, ...(e.data && { data: e.data }) } })),
        );
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    const daemon = reconnecting(() => Client.connectEndpoint({ url, token: 't' }));
    try {
      const out = await controller(w, { side: async (id) => (id === trift ? { ...w.side(id), daemon } : w.side(id)) }).start(trift);
      expect(prepares).toBe(1);
      expect(w.events.filter((e) => e.event === 'handover.retry')).toEqual([]);
      expect(out).toMatchObject({ status: 'interrupted', phase: 'prepare', error: expect.stringContaining('request too large'), safe: ['resume', 'abort'] });
      // the socket it closed is not asked again: the next call opens another
      expect(await daemon.call('system.info', {})).toMatchObject({ machineId: trift });
      expect(connections).toBe(2);
    } finally {
      daemon.close();
      await new Promise((r) => wss.close(r));
    }
  });

  it('asks the gateway over ssh, reads its refusal as an answer, and its silent authority as none', async () => {
    const runs: string[][] = [];
    let frame: unknown = { result: { record: { fleetId, generation: G, ownerMachineId: mac } } };
    const master = { run: async (argv: string[]) => { runs.push(argv); return { code: 0, signal: null, stdout: `${JSON.stringify(frame)}\n`, stderr: '', truncated: false }; } };
    const exe = '/home/ada/.local/share/svall/current/bin/svall';
    const gateway = gatewayOf((op, id, params) => remoteOwner({ master, exe, op, fleetId: id, ...(params && { params }) }), fleetId);
    expect(await gateway.get()).toEqual({ fleetId, generation: G, ownerMachineId: mac });
    await gateway.ready({ transactionId: 'tx-1', expectedGeneration: G, preparedDigest: 'd'.repeat(64) });
    const params = JSON.parse(runs[1][runs[1].indexOf('--params') + 1].slice(1, -1));
    expect(runs[1].slice(1, 3)).toEqual(['gateway', 'owner']);
    expect(params).toEqual({ transactionId: 'tx-1', expectedGeneration: G, preparedDigest: 'd'.repeat(64), sourceFrozen: true });
    frame = { error: { code: 'generation_mismatch', message: 'this fleet is at generation 5, not 4', data: { expected: 4, actual: 5 } } };
    await expect(gateway.commit({ transactionId: 'tx-1', expectedGeneration: G })).rejects.toMatchObject({ name: 'Refused', code: 'generation_mismatch', data: { actual: 5 } });
    frame = { error: { code: 'disconnected', message: 'the gateway authority did not answer on its socket' } };
    const silent = await gateway.get().catch((e: unknown) => e);
    expect(silent).not.toBeInstanceOf(Refused);
  });

  it('relays the daemon\'s own handover rows as they arrive and never its phases, reads the gateway\'s record, and keeps its token to scrub', async () => {
    const prefix = makeHome();
    const home = makeHome();
    const saved = process.env.SVALL_GATEWAY_PREFIX;
    process.env.SVALL_GATEWAY_PREFIX = prefix;
    const authority = await startAuthorityServer({ prefix });
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const row = { transactionId: 'tx-9', kind: 'character', id: 'c_ada', phase: 'freeze' };
    wss.on('connection', (ws) => {
      let authed = false;
      ws.on('message', (raw) => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
        const req = JSON.parse(raw.toString()) as { id: number; method: string };
        ws.send(JSON.stringify({ event: 'state.patch', data: { ops: [] } }));
        // the daemon's journal reports its own step on every write: only the controller says where the handover is
        ws.send(JSON.stringify({ event: 'handover.changed', data: { transactionId: 'tx-9', phase: 'freeze' } }));
        ws.send(JSON.stringify({ event: 'handover.entity', data: row }));
        ws.send(JSON.stringify({ id: req.id, result: {} }));
      });
    });
    try {
      const registry = MachineRegistry.load(path.join(home, 'config'));
      const fleet = FleetId.parse(crypto.randomUUID());
      const client = await AuthorityClient.connect(prefix);
      await client.create({ fleetId: fleet, initialOwnerMachineId: registry.localId });
      client.close();
      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: fleet, gatewayMachineId: registry.localId }));
      fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
      fs.writeFileSync(path.join(home, 'token'), `${TOKEN}\n`);

      const recorded: HandoverEvent[] = [];
      const c = connectHandover({ fleetHome: home, registry, record: (e) => recorded.push(e) });
      try {
        const { observation, verdict } = await c.handover.status();
        expect(observation.gateway).toEqual({ ok: true, value: { fleetId: fleet, generation: 0, ownerMachineId: registry.localId } });
        expect(verdict.standing).toBe('none');
        expect(recorded).toEqual([{ event: 'handover.entity', data: row }]);
        expect(c.secrets()).toContain(TOKEN);
      } finally {
        await c.close();
      }
    } finally {
      process.env.SVALL_GATEWAY_PREFIX = saved;
      if (saved === undefined) delete process.env.SVALL_GATEWAY_PREFIX;
      await new Promise((r) => wss.close(r));
      await authority.close();
      cleanHomes();
    }
  });
});
