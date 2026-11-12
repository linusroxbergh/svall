import { describe, expect, it } from 'vitest';
import { agentsInUse, FleetConfig, FleetId, MachineId, MachineRecord, NodeConfig, tierOf, type FleetAgents } from '../src/index.js';

const UUID_A = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
const UUID_B = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';

describe('identities', () => {
  it('takes uuids only', () => {
    expect(MachineId.parse(UUID_B)).toBe(UUID_B);
    expect(FleetId.parse(UUID_A)).toBe(UUID_A);
    expect(() => MachineId.parse('trift')).toThrow();
    expect(() => FleetId.parse('')).toThrow();
  });
});

describe('machine records', () => {
  const record = {
    name: 'trift', ssh: 'trift', platform: 'linux', arch: 'arm64',
    home: '/home/linus', svallBase: '/home/linus/.local/share/svall',
  };
  it('reads a machine record as the registry writes it', () => {
    expect(MachineRecord.parse(record)).toEqual(record);
  });
  it('reads a record an earlier build wrote with named path roots, and leaves them out', () => {
    expect(MachineRecord.parse({ ...record, pathRoots: { home: '/home/linus', work: '/srv/work' } })).toEqual(record);
  });
  it('reads what an older release wrote, a fleet.json with gatewayMachineId and handover and a machine with gateway, and leaves the old keys out', () => {
    expect(FleetConfig.parse({ id: UUID_A, gatewayMachineId: UUID_B, handover: { enabled: true } })).toEqual(FleetConfig.parse({ id: UUID_A }));
    expect(MachineRecord.parse({ ...record, gateway: true })).toEqual(MachineRecord.parse(record));
  });
  it('takes a local machine with no ssh route', () => {
    const { ssh: _ssh, ...local } = record;
    expect(MachineRecord.parse(local).ssh).toBeUndefined();
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

describe('tierOf', () => {
  // a fleet whose mission control runs Claude Code, whose scribe is off on Codex, and one of whose robots runs OpenCode in its second terminal
  const fleet = { mainAgent: 'claude', scribeAgent: 'codex', scribeOff: true, robots: { r: { second: { agent: { kind: 'opencode' } } } } } as unknown as FleetAgents;
  const tier = (step: string, status: string, flow?: boolean) => tierOf({ step, status }, fleet, flow);

  it('the agents a fleet runs are mission control\'s, a robot\'s in either terminal, and the scribe\'s only while it is on', () => {
    expect([...agentsInUse(fleet)].sort()).toEqual(['claude', 'opencode']);
    expect([...agentsInUse({ ...fleet, scribeOff: undefined })].sort()).toEqual(['claude', 'codex', 'opencode']);
  });

  it('a row that went well or was skipped is fine, and every failure is to do', () => {
    expect([tier('ssh', 'ok'), tier('claude', 'skip'), tier('tmux', 'fail'), tier('gh', 'fail')]).toEqual(['fine', 'fine', 'todo', 'todo']);
  });

  it('of a machine\'s checks, a warning needs a person only on what a robot there cannot do without', () => {
    for (const step of ['linger', 'release', 'worker', 'service', 'systemd', 'versions', 'hooks', 'codex hooks', 'opencode plugin']) expect(tier(step, 'warn')).toBe('todo');
    for (const step of ['tmux', 'space', 'path', 'gh', 'os', 'daemon env', 'launchd plist', 'shims', 'codex sandbox', 'machine id']) expect(tier(step, 'warn')).toBe('note');
  });

  it('an agent\'s warning is to do where the fleet runs it, a note where it does not, and to do while the fleet is unknown', () => {
    expect([tier('claude', 'warn'), tier('opencode', 'warn'), tier('codex', 'warn')]).toEqual(['todo', 'todo', 'note']);
    expect(tierOf({ step: 'codex', status: 'warn' }, undefined)).toBe('todo');
  });

  it('in a step flow every warning is to do but the join\'s offer to copy the agent setup and an Ubuntu that is not LTS', () => {
    expect([tier('rollback', 'warn', true), tier('os', 'warn', true), tier('crew', 'warn', true), tier('seed', 'warn', true)]).toEqual(['todo', 'note', 'todo', 'note']);
    expect(tier('os', 'warn')).toBe('note');
  });

  it('the agent setup\'s rows are never a thing to do', () => {
    expect([tier('mirror:claude:mcp:linear', 'warn'), tier('mirror:claude:mcp:linear', 'warn', true), tier('mirror:phone', 'ok')]).toEqual(['note', 'note', 'fine']);
  });
});
