import { describe, expect, it } from 'vitest';
import { AGENTS, compareVersions, findAgents, mainAgent, onPath, parseVersion, versionOk } from '../src/agents.js';
import { sessionAdapter } from '../src/handover/sessions/registry.js';

const exec = (files: string[]) => (f: string) => files.includes(f);

describe('findAgents', () => {
  it('finds each CLI on PATH, in adapter order', () => {
    const isExec = exec(['/opt/homebrew/bin/codex', '/u/.local/bin/claude']);
    expect(findAgents('/opt/homebrew/bin:/u/.local/bin', isExec)).toEqual(['claude', 'codex']);
    expect(findAgents('/opt/homebrew/bin', isExec)).toEqual(['codex']);
    expect(findAgents('', isExec)).toEqual([]);
  });
  it('skips relative PATH entries', () => {
    expect(onPath('claude', 'bin:/usr/bin', exec(['bin/claude']))).toBeUndefined();
  });
  it('finds opencode and holds it to 2.0.22', () => {
    expect(findAgents('/b', exec(['/b/opencode']))).toEqual(['opencode']);
    expect(versionOk(AGENTS.opencode, 'opencode v2.0.22')).toBe(true);
    expect(versionOk(AGENTS.opencode, '1.18.34')).toBe(false);
  });
});

describe('versions', () => {
  it('reads the first x.y.z in a --version line', () => {
    expect(parseVersion('codex-cli 0.156.1')).toEqual([0, 156, 1]);
    expect(parseVersion('codex-cli 0.142.0-alpha.6')).toEqual([0, 142, 0]);
    expect(parseVersion('2.1.283 (Claude Code)')).toEqual([2, 1, 283]);
    expect(parseVersion('nonsense')).toBeUndefined();
  });
  it('orders two version lines as semver does, a release after its prereleases', () => {
    expect(compareVersions('2.1.280', '2.1.280 (Claude Code)')).toBe(0);
    expect(compareVersions('codex-cli 0.157.0-alpha.2', '0.157.0-alpha.2')).toBe(0);
    expect(compareVersions('0.157.0', '0.157.0-alpha.2')).toBe(1);
    expect(compareVersions('0.157.0-alpha.10', '0.157.0-alpha.2')).toBe(1);
    expect(compareVersions('0.157.0-beta', '0.157.0-alpha.2')).toBe(1);
    expect(compareVersions('0.157.0-alpha', '0.157.0-alpha.1')).toBe(-1);
    expect(compareVersions('0.157.0-alpha.1', '0.157.0-alpha.beta')).toBe(-1);
    expect(compareVersions('0.156.9', '0.157.0-alpha.1')).toBe(-1);
    expect(compareVersions('0.157.0-rc.1+build.5', '0.157.0-rc.1')).toBe(0);
    expect(compareVersions('nonsense', '0.157.0')).toBeUndefined();
  });
  it('holds codex to 0.156, and claude to 2.1.251, the oldest release whose sessions a handover carries', () => {
    expect(versionOk(AGENTS.codex, 'codex-cli 0.156.0')).toBe(true);
    expect(versionOk(AGENTS.codex, 'codex-cli 0.155.2')).toBe(false);
    expect(versionOk(AGENTS.codex, 'codex-cli 0.142.0-alpha.6')).toBe(false);
    expect(versionOk(AGENTS.codex, 'codex-cli 0.156.0-alpha.3')).toBe(false);
    expect(versionOk(AGENTS.codex, 'codex-cli 0.157.0-alpha.1')).toBe(true);
    expect(versionOk(AGENTS.codex, 'unparseable')).toBe(true);
    expect(versionOk(AGENTS.claude, '2.1.250 (Claude Code)')).toBe(false);
    expect(versionOk(AGENTS.claude, '2.1.251 (Claude Code)')).toBe(true);
    expect(sessionAdapter('claude').min).toEqual(AGENTS.claude.minVersion);
  });
});

describe('login probes', () => {
  it('reads claude auth status --json', () => {
    expect(AGENTS.claude.loggedIn('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe(true);
    expect(AGENTS.claude.loggedIn('{"loggedIn":true,"authMethod":"api_key"}')).toBe(true);
    expect(AGENTS.claude.loggedIn('{"loggedIn":false}')).toBe(false);
    expect(AGENTS.claude.loggedIn('not json')).toBe(false);
  });
  it('takes codex login status at its exit code', () => {
    expect(AGENTS.codex.loggedIn('Logged in using ChatGPT')).toBe(true);
  });
});

describe('crewCommand', () => {
  it("names the command mission control's crew starts, on a model when one is given", () => {
    expect(AGENTS.claude.crewCommand(AGENTS.claude.crewModel)).toBe('claude --model opus');
    expect(AGENTS.claude.crewCommand('sonnet')).toBe('claude --model sonnet');
    expect(AGENTS.codex.crewCommand(AGENTS.codex.crewModel)).toBe('codex');
    expect(AGENTS.codex.crewCommand('gpt-6-astra')).toBe('codex -m gpt-6-astra');
    expect(AGENTS.opencode.crewCommand('opencode/big-pickle')).toBe('opencode');
    expect(AGENTS.claude.crewCommand('opus[1m]')).toBe("claude --model 'opus[1m]'");
    expect(AGENTS.codex.crewCommand('x; rm -rf ~')).toBe("codex -m 'x; rm -rf ~'");
  });
});

describe('mainAgent', () => {
  it('is the configured one, else the only one found, else claude', () => {
    expect(mainAgent('codex', ['claude', 'codex'])).toBe('codex');
    expect(mainAgent(undefined, ['codex'])).toBe('codex');
    expect(mainAgent(undefined, ['claude', 'codex'])).toBe('claude');
    expect(mainAgent(undefined, [])).toBe('claude');
    // a configured CLI that is gone stays the choice; doctor says so
    expect(mainAgent('claude', ['codex'])).toBe('claude');
  });
  it('is the first one found when claude is not among several', () => {
    expect(mainAgent(undefined, ['codex', 'opencode'])).toBe('codex');
  });
});
