import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handoff, handoffTarget } from '../src/handoff.js';

describe('handoffTarget', () => {
  it('sends a Svall Dev home to svall-dev from the release CLI', () => {
    expect(handoffTarget({ SVALL_HOME: '/u/.svall-dev-work' }, '/u/.local/bin')).toBe('/u/.local/bin/svall-dev');
  });
  it('keeps its own homes, ad-hoc homes and no home at all', () => {
    for (const env of [{ SVALL_HOME: '/u/.svall' }, { SVALL_HOME: '/u/.svall-work' }, { SVALL_HOME: '/tmp/x' }, {}]) {
      expect(handoffTarget(env, '/u/.local/bin')).toBeUndefined();
    }
  });
});

describe('handoff', () => {
  // a HOME of its own, whose stand-in svall-dev notes its arguments and exits 3
  let home = '';
  const shim = () => path.join(home, '.local/bin/svall-dev');
  const install = () => {
    fs.mkdirSync(path.dirname(shim()), { recursive: true });
    fs.writeFileSync(shim(), `#!/bin/sh\nprintf '%s\\n' "$@" > '${shim()}.args'\nexit 3\n`, { mode: 0o755 });
  };
  const exit = () => vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SVALL_HOME', '/u/.svall-dev-work');
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

  it('runs the other build with the arguments and exits with its status', () => {
    install();
    const exited = exit();
    handoff(['node', 'svall', 'agent', 'x']);
    expect(exited).toHaveBeenCalledWith(3);
    expect(fs.readFileSync(`${shim()}.args`, 'utf8')).toBe('agent\nx\n');
  });
  it('hands off a run whose -p comes after --, where it is text', () => {
    install();
    const exited = exit();
    handoff(['node', 'svall', 'char', 'run', 'c1', '--', 'claude', '-p', 'hi']);
    expect(exited).toHaveBeenCalledWith(3);
    expect(fs.readFileSync(`${shim()}.args`, 'utf8')).toBe('char\nrun\nc1\n--\nclaude\n-p\nhi\n');
  });
  it('leaves a run that names its fleet to this build', () => {
    install();
    const exited = exit();
    for (const flags of [['-p', 'work'], ['-pwork'], ['--profile', 'work'], ['--profile=work']]) handoff(['node', 'svall', ...flags, 'setup']);
    expect(exited).not.toHaveBeenCalled();
    expect(fs.existsSync(`${shim()}.args`)).toBe(false);
  });
  it('refuses when the other build is missing or hands the run back', () => {
    expect(() => handoff(['node', 'svall'])).toThrow('/u/.svall-dev-work belongs to the other Svall build, which is not installed');
    install();
    vi.stubEnv('SVALL_HANDOFF', '1');
    expect(() => handoff(['node', 'svall'])).toThrow('which is not installed');
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('lets Svall Dev answer to svall until a release takes the name', async () => {
  vi.resetModules();
  vi.stubEnv('SVALL_VARIANT', 'dev');
  const { shimNames, shimText } = await import('@svall/svalld/setup');
  const { bundleRuntime } = await import('@svall/svalld/runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
  expect(shimNames(dir)).toEqual(['svall-dev', 'svall']);
  fs.writeFileSync(path.join(dir, 'svall'), shimText(bundleRuntime('/Applications/Svall.app')));
  expect(shimNames(dir)).toEqual(['svall-dev']);
});
