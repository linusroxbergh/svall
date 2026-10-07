import { describe, expect, it } from 'vitest';
import { Blocker, emptyState, type HandoverEvent, FleetConfig, FleetId, GitGraph, HANDOVER_PHASES, HandoverChoices, HandoverEntity, HandoverError, HandoverPhase, handoverError, MachineId, MachineRecord, ManifestSummary, NodeConfig, OwnerRecord, ReceivedGraph, TRANSFER_SCHEMA_VERSION, TransactionRecord, TransferFile, TransferManifestV1, Warning } from '../src/index.js';

const UUID_A = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
const UUID_B = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
const DIGEST = 'a'.repeat(64);

const FILE = { type: 'file', path: 'README.md', mode: 0o644, size: 2000, mtimeMs: 1_700_000_000_000, sha256: DIGEST } as const;
const MANIFEST = {
  version: TRANSFER_SCHEMA_VERSION,
  transactionId: 't1',
  generation: 4,
  fromMachineId: UUID_B,
  toMachineId: UUID_A,
  home: '/Users/linus',
  fleet: FleetConfig.parse({ id: UUID_A }),
  snapshot: emptyState(),
  excludes: ['node_modules/'],
  roots: [
    { id: 'r_1', kind: 'repo', entry: 'dir', path: '/Users/linus/p', files: [FILE, { type: 'symlink', path: 'docs', target: 'README.md' }] },
    { id: 'r_2', kind: 'worktree', entry: 'dir', path: '/Users/linus/p/.claude/worktrees/w', foldedInto: 'r_1', files: [] },
  ],
  sessions: [
    { characterId: 'c_1', agent: 'claude', sessionId: 's1', sourcePath: '/Users/linus/.claude/projects/p/s1.jsonl', files: [{ ...FILE, path: 's1.jsonl' }] },
    { characterId: 'c_2', agent: 'opencode', sessionId: 'ses_eeda388f0ffeOB6E6MBZswShKL', sourcePath: '/Users/linus/.svall/transcripts/opencode/ses_eeda388f0ffeOB6E6MBZswShKL.jsonl',
      files: [{ ...FILE, path: 'ses_eeda388f0ffeOB6E6MBZswShKL.json' }] },
  ],
};

describe('identities', () => {
  it('takes uuids only', () => {
    expect(MachineId.parse(UUID_B)).toBe(UUID_B);
    expect(FleetId.parse(UUID_A)).toBe(UUID_A);
    expect(() => MachineId.parse('trift')).toThrow();
    expect(() => FleetId.parse('')).toThrow();
  });
});

describe('ownership records', () => {
  it('reads a record without a transaction', () => {
    expect(OwnerRecord.parse({ fleetId: UUID_A, generation: 0, ownerMachineId: UUID_B }))
      .toEqual({ fleetId: UUID_A, generation: 0, ownerMachineId: UUID_B });
  });
  it('reads a record mid-transaction', () => {
    const transaction = { id: 't1', fromMachineId: UUID_B, toMachineId: UUID_A, phase: 'ready-to-commit', startedAt: 17 };
    expect(OwnerRecord.parse({ fleetId: UUID_A, generation: 3, ownerMachineId: UUID_B, transaction }).transaction).toEqual(transaction);
    expect(TransactionRecord.parse(transaction).phase).toBe('ready-to-commit');
  });
  it('carries the freeze and the prepared digest a ready transaction was granted on', () => {
    const transaction = { id: 't1', fromMachineId: UUID_B, toMachineId: UUID_A, phase: 'ready-to-commit', startedAt: 17, sourceFrozenAt: 19, preparedDigest: DIGEST };
    expect(TransactionRecord.parse(transaction)).toEqual(transaction);
    expect(() => TransactionRecord.parse({ ...transaction, preparedDigest: 'not-a-digest' })).toThrow();
  });
  it('refuses a negative generation, a fractional one and an unknown phase', () => {
    const base = { fleetId: UUID_A, ownerMachineId: UUID_B };
    expect(() => OwnerRecord.parse({ ...base, generation: -1 })).toThrow();
    expect(() => OwnerRecord.parse({ ...base, generation: 1.5 })).toThrow();
    expect(() => TransactionRecord.parse({ id: 't1', fromMachineId: UUID_B, toMachineId: UUID_A, phase: 'done', startedAt: 17 })).toThrow();
  });
});

describe('machine records', () => {
  const record = {
    name: 'trift', ssh: 'trift', platform: 'linux', arch: 'arm64',
    home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: true,
  };
  it('reads the registry shape from the spec', () => {
    expect(MachineRecord.parse(record)).toEqual(record);
  });
  it('reads a record an earlier build wrote with named path roots, and leaves them out', () => {
    expect(MachineRecord.parse({ ...record, pathRoots: { home: '/home/linus', work: '/srv/work' } })).toEqual(record);
  });
  it('takes a local machine with no ssh route', () => {
    const { ssh: _ssh, ...local } = record;
    expect(MachineRecord.parse({ ...local, gateway: false }).ssh).toBeUndefined();
  });
  it('holds names to the registry pattern', () => {
    for (const name of ['1trift', 'Trift', 'trift_two', 'a'.repeat(33), '']) {
      expect(() => MachineRecord.parse({ ...record, name })).toThrow();
    }
    expect(MachineRecord.parse({ ...record, name: 'a'.repeat(32) }).name).toHaveLength(32);
  });
  it('refuses an ssh destination a command would read as an option', () => {
    for (const ssh of ['-oProxyCommand=touch /tmp/pwned', '--', 'trift host', 'trift\nhost', '']) {
      expect(() => MachineRecord.parse({ ...record, ssh })).toThrow();
    }
    expect(MachineRecord.parse({ ...record, ssh: 'linus@trift.tailnet.ts.net:22' }).ssh).toContain('trift');
  });
  it('refuses a user or host name a ProxyCommand\'s %r or %h would hand a shell to expand', () => {
    for (const ssh of ['$(touch x)@trift', '`id`@trift', 'linus@trift;id', 'linus@trift|id', "linus@'trift'", 'linus@trift&', 'linus@%h', 'linus@trift\\x']) {
      expect(() => MachineRecord.parse({ ...record, ssh }), ssh).toThrow();
    }
  });
  it('holds a path to an absolute one that climbs nowhere, and takes whatever else a disk holds', () => {
    for (const bad of ['~/.local/share/svall', 'relative/path', '/home/linus/../../etc', '/home/linus\nrm -rf /', '/home/\0linus']) {
      expect(() => MachineRecord.parse({ ...record, svallBase: bad })).toThrow();
      expect(() => MachineRecord.parse({ ...record, home: bad })).toThrow();
    }
    for (const held of ['/Users/José Núñez/Library/Application Support', "/home/linus/it's here/svall; touch x", '/home/$USER']) {
      expect(MachineRecord.parse({ ...record, svallBase: held, home: held }).svallBase).toBe(held);
    }
  });
});

describe('split configuration', () => {
  it('defaults every portable setting around the fleet id', () => {
    const fleet = FleetConfig.parse({ id: UUID_A });
    expect(fleet.defaultCwd).toBe('~');
    expect(fleet.home.cwd).toBe('~/.svall/home');
    // the main agent, the crew's command and the scribe's agent fall back to what each machine finds installed
    expect([fleet.mainAgent, fleet.home.command, fleet.scribe.agent]).toEqual([undefined, undefined, undefined]);
    expect(fleet.mobile).toEqual({ logins: [], origins: [] });
    expect(fleet.handover).toEqual({ enabled: false, exclude: [], excludeDefaults: true, transferFleetEnv: false });
    expect(fleet.gatewayMachineId).toBeUndefined();
    expect(() => FleetConfig.parse({})).toThrow();
  });
  it('keeps machine settings out of the portable file', () => {
    expect(NodeConfig.parse({})).toEqual({ host: '127.0.0.1', port: 47800, mobile: {} });
    expect(NodeConfig.parse({ shell: '/bin/zsh', mobile: { httpsPort: 10000 } }).mobile.httpsPort).toBe(10000);
    expect(NodeConfig.parse({ mobile: { httpsPort: 8080 } }).mobile.httpsPort).toBe(8080);
    expect(() => NodeConfig.parse({ mobile: { httpsPort: 70000 } })).toThrow();
  });
  it('ignores keys it does not know', () => {
    expect(FleetConfig.parse({ id: UUID_A, port: 1234 })).not.toHaveProperty('port');
    expect(NodeConfig.parse({ defaultCwd: '/x' })).not.toHaveProperty('defaultCwd');
    expect(NodeConfig.parse({ mainAgent: 'codex' })).not.toHaveProperty('mainAgent');
    expect(FleetConfig.parse({ id: UUID_A, mainAgent: 'codex' }).mainAgent).toBe('codex');
  });
});

describe('handover vocabulary', () => {
  it('names every phase of the state machine, and abortion', () => {
    expect(HANDOVER_PHASES).toEqual(['begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit', 'activate', 'complete', 'aborted']);
    expect(HandoverPhase.parse('ready')).toBe('ready');
    expect(() => HandoverPhase.parse('resting')).toThrow();
  });
  it('points a blocker or a warning at the entity it is about', () => {
    const blocker = { code: 'shell_busy', message: 'vite is still running', entity: { kind: 'character', id: 'c_1' } };
    expect(Blocker.parse(blocker)).toEqual(blocker);
    expect(Warning.parse({ code: 'platform_heuristic', message: 'an Xcode project' }).entity).toBeUndefined();
    expect(() => Blocker.parse({ code: 'shells_are_busy', message: 'x' })).toThrow();
    expect(() => Blocker.parse({ code: 'shell_busy', message: 'x', entity: { kind: 'island', id: 'i_1' } })).toThrow();
    expect(HandoverEntity.parse({ kind: 'git', id: 'r_1' }).kind).toBe('git');
  });
  it('keeps a blocker code for each way preflight refuses', () => {
    for (const code of ['identity_mismatch', 'generation_mismatch', 'transaction_open', 'incompatible_release', 'incompatible_protocol', 'incompatible_schema', 'incompatible_adapter', 'agent_cli_missing', 'agent_logged_out', 'agent_hooks_missing', 'home_mismatch', 'parent_missing', 'character_pinned', 'shell_busy', 'worktree_unresolved', 'destination_diverged', 'destination_occupied', 'destination_no_space', 'path_collision', 'path_symlinked', 'mission_control_shared', 'transcript_missing', 'ssh_interactive', 'external_writer', 'rsync_unsupported']) {
      expect(Blocker.parse({ code, message: code }).code).toBe(code);
    }
  });
  it('counts a manifest without carrying it', () => {
    const summary = { digest: DIGEST, roots: 2, files: 10, bytes: 2048, sessions: 1 };
    expect(ManifestSummary.parse(summary)).toEqual(summary);
    expect(() => ManifestSummary.parse({ ...summary, digest: 'abc' })).toThrow();
    expect(() => ManifestSummary.parse({ ...summary, files: 1.5 })).toThrow();
  });
  it('takes the choices the sheet and the CLI offer', () => {
    expect(HandoverChoices.parse({})).toEqual({});
    expect(HandoverChoices.parse({ interruptAfterMs: 30_000, terminateShells: true, archiveRoots: ['r_1'] }).terminateShells).toBe(true);
    expect(HandoverChoices.parse({ terminateShells: ['c_1', 'c_2'] }).terminateShells).toEqual(['c_1', 'c_2']);
    expect(() => HandoverChoices.parse({ interruptAfterMs: -1 })).toThrow();
  });
});

describe('handover errors', () => {
  it('names why the daemon refused', () => {
    expect(HandoverError.parse({ code: 'not_owner', message: 'trift owns this fleet', ownerMachineId: UUID_B, generation: 4 }).code).toBe('not_owner');
    expect(HandoverError.parse({ code: 'frozen', message: 'handover in flight', transactionId: 't1' }).code).toBe('frozen');
    const committed = HandoverError.parse({ code: 'handover_committed', message: 'committed', transactionId: 't1', generation: 5 });
    expect(committed.code === 'handover_committed' && committed.generation).toBe(5);
    expect(HandoverError.parse({ code: 'not_ready', message: 'not implemented' }).code).toBe('not_ready');
    const stale = HandoverError.parse({ code: 'generation_mismatch', message: 'stale', expected: 4, actual: 5 });
    expect(stale.code === 'generation_mismatch' && stale.expected).toBe(4);
    const other = HandoverError.parse({ code: 'transaction_mismatch', message: 'other transaction', actual: 't2' });
    expect(other.code === 'transaction_mismatch' && other.actual).toBe('t2');
    const blocked = HandoverError.parse({ code: 'blocked', message: 'one blocker', blockers: [{ code: 'shell_busy', message: 'vite' }] });
    expect(blocked.code === 'blocked' && blocked.blockers).toHaveLength(1);
    expect(HandoverError.parse({ code: 'authority_unreachable', message: 'the gateway did not answer' }).code).toBe('authority_unreachable');
  });
  it('refuses an unknown code and a malformed generation', () => {
    expect(() => HandoverError.parse({ code: 'unlucky', message: 'x' })).toThrow();
    expect(() => HandoverError.parse({ code: 'generation_mismatch', message: 'x', expected: -1, actual: 5 })).toThrow();
    expect(() => HandoverError.parse({ code: 'generation_mismatch', message: 'x', expected: 1.5, actual: 5 })).toThrow();
    expect(() => HandoverError.parse({ code: 'not_owner', message: 'x', ownerMachineId: 'trift', generation: 4 })).toThrow();
  });
});

describe('transfer manifest', () => {
  it('carries every root and session with the content of each file, and the home both machines share', () => {
    expect(TransferManifestV1.parse(MANIFEST)).toEqual(MANIFEST);
    expect(() => TransferManifestV1.parse({ ...MANIFEST, home: '~' })).toThrow();
    expect(() => TransferManifestV1.parse({ ...MANIFEST, version: 99 })).toThrow();
    expect(() => TransferManifestV1.parse({ ...MANIFEST, generation: -1 })).toThrow();
    expect(() => TransferManifestV1.parse({ ...MANIFEST, fromMachineId: 'trift' })).toThrow();
  });

  it('names no transaction when a preflight built it', () => {
    const { transactionId: _, ...preflight } = MANIFEST;
    expect(TransferManifestV1.parse(preflight).transactionId).toBeUndefined();
  });

  it('describes each repository graph it carries, and a Git directory carried on its own', () => {
    const checkout = { path: '/Users/linus/p', gitDir: '/Users/linus/p/.git', head: 'b'.repeat(40), branch: 'refs/heads/main', status: ['1 .M N... 100644 100644 100644 a a a.txt'], index: DIGEST, characters: [] };
    const graph = {
      id: 'g_1', commonDir: '/Users/linus/p/.git', main: checkout,
      worktrees: [{ ...checkout, path: '/Users/linus/w', gitDir: '/Users/linus/p/.git/worktrees/w', branch: null, locked: 'on a disk', characters: ['c_1'] }],
      unused: [{ path: '/Users/linus/old', head: null, branch: 'refs/heads/old', prunable: true }],
      stash: ['c'.repeat(40)],
    };
    const bare = { id: 'g_2', commonDir: '/Users/linus/b.git', worktrees: [], unused: [], stash: [] };
    const withGit = {
      ...MANIFEST,
      roots: [...MANIFEST.roots, { id: 'r_3', kind: 'gitdir', entry: 'dir', path: '/Users/linus/b.git', files: [] }],
      git: [graph, bare],
    };
    expect(TransferManifestV1.parse(withGit)).toEqual(withGit);
    expect(TransferManifestV1.parse(MANIFEST).git).toBeUndefined();
    expect(() => TransferManifestV1.parse({ ...withGit, git: [{ ...graph, main: { ...checkout, index: 'x' } }] })).toThrow();
  });

  it('names the commits a graph\'s refs reach by full object names, which git can never read as an option', () => {
    const graph = { id: 'g_1', commonDir: '/Users/linus/p/.git', worktrees: [], unused: [], stash: [] };
    for (const tips of [['a'.repeat(40)], ['b'.repeat(64)]]) expect(GitGraph.parse({ ...graph, tips }).tips).toEqual(tips);
    const checkout = { path: '/Users/linus/p', gitDir: '/Users/linus/p/.git', head: 'b'.repeat(40), branch: 'refs/heads/main', status: [], index: 'd'.repeat(64), characters: [] };
    expect(GitGraph.parse({ ...graph, main: { ...checkout, head: null }, stash: ['c'.repeat(64)] }).main?.head).toBeNull();
    for (const tip of ['--all', '--output=/tmp/x', '-n', 'HEAD', 'a'.repeat(39), 'A'.repeat(40), `${'a'.repeat(40)} `, 'a'.repeat(41)]) {
      expect(() => GitGraph.parse({ ...graph, tips: [tip] }), tip).toThrow();
      expect(() => ReceivedGraph.parse({ id: 'g_1', commonDir: '/home/linus/p/.git', carried: [], tips: [tip] }), tip).toThrow();
      // a checkout's head and the stash join the tips a destination asks git about
      expect(() => GitGraph.parse({ ...graph, main: { ...checkout, head: tip } }), tip).toThrow();
      expect(() => GitGraph.parse({ ...graph, worktrees: [{ ...checkout, head: tip }] }), tip).toThrow();
      expect(() => GitGraph.parse({ ...graph, stash: [tip] }), tip).toThrow();
    }
  });

  it('holds a Git index by its staged entries as well as its bytes', () => {
    const index = { ...FILE, path: '.git/index', gitIndex: DIGEST };
    expect(TransferFile.parse(index)).toEqual(index);
    expect(() => TransferFile.parse({ ...index, gitIndex: 'x' })).toThrow();
  });

  it('names the ways a repository graph can fail to arrive', () => {
    for (const code of ['git_mismatch', 'worktree_unused', 'remote_local']) expect(Blocker.parse({ code, message: code }).code).toBe(code);
  });

  it('holds a file by its hash and a link by its text', () => {
    expect(() => TransferFile.parse({ ...FILE, sha256: 'x' })).toThrow();
    expect(() => TransferFile.parse({ ...FILE, size: -1 })).toThrow();
    expect(() => TransferFile.parse({ type: 'symlink', path: 'a' })).toThrow();
    expect(() => TransferFile.parse({ ...FILE, type: 'fifo' })).toThrow();
  });
});

describe('throwing a handover error', () => {
  it('keeps the structured half where the frame can carry it', () => {
    const blocked = handoverError({ code: 'blocked', message: 'one blocker', blockers: [{ code: 'shell_busy', message: 'vite' }] });
    expect(blocked).toBeInstanceOf(Error);
    expect(blocked.message).toBe('one blocker');
    expect(blocked.code).toBe('blocked');
    expect(blocked.data).toEqual({ blockers: [{ code: 'shell_busy', message: 'vite' }] });
    expect(handoverError({ code: 'not_owner', message: 'trift owns it', ownerMachineId: MachineId.parse(UUID_B), generation: 4 }).data)
      .toEqual({ ownerMachineId: UUID_B, generation: 4 });
    expect(handoverError({ code: 'frozen', message: 'frozen', transactionId: 't1' }).data).toEqual({ transactionId: 't1' });
    expect(handoverError({ code: 'handover_committed', message: 'committed', transactionId: 't1', generation: 5 }).data)
      .toEqual({ transactionId: 't1', generation: 5 });
    expect(handoverError({ code: 'generation_mismatch', message: 'stale', expected: 4, actual: 5 }).data).toEqual({ expected: 4, actual: 5 });
    expect(handoverError({ code: 'transaction_mismatch', message: 'other', actual: 't2' }).data).toEqual({ actual: 't2' });
    expect(handoverError({ code: 'not_ready', message: 'not wired yet' }).data).toEqual({});
  });
});

describe('the lines the handover helper prints', () => {
  it('are one shared type for the helper that writes them and the app that reads them', () => {
    const lines = [
      { event: 'handover.entity', data: { transactionId: 't1', kind: 'root', id: 'r_1', phase: 'transfer', done: 1, total: 2, bytes: 10, totalBytes: 20 } },
      { event: 'handover.result', data: { status: 'interrupted', phase: 'transfer', error: 'ssh dropped', safe: ['resume', 'abort'] } },
      {
        event: 'handover.status',
        data: { standing: 'open', journals: { source: 'freeze' }, safe: ['abort'], action: 'continue', reason: 'the source is frozen', helper: { pid: 7 } },
      },
      { event: 'handover.detached', data: { pid: 7 } },
    ] satisfies HandoverEvent[];
    expect(lines.map((l) => l.event)).toEqual(['handover.entity', 'handover.result', 'handover.status', 'handover.detached']);
  });
});
