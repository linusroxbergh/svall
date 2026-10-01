import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function names(v: 'release' | 'dev') {
  vi.resetModules();
  vi.stubEnv('SVALL_VARIANT', v);
  return import('../src/profile.js');
}

describe('variant names', () => {
  it('gives Svall Dev its own ids, homes, shim, ports and mission control folder', async () => {
    const p = await names('dev');
    expect(p.BUNDLE_ID).toBe('io.github.linusroxbergh.svall.dev');
    expect(p.LAUNCHD_LABEL).toBe('io.github.linusroxbergh.svall.dev.svalld');
    expect(p.profileHome(p.PRIVATE, '/u')).toBe('/u/.svall-dev');
    expect(p.profileHome('work', '/u')).toBe('/u/.svall-dev-work');
    expect(p.profileLabel('work')).toBe('io.github.linusroxbergh.svall.dev.svalld.work');
    expect(p.profileOf('/u/.svall-dev', '/u')).toBe(p.PRIVATE);
    expect(p.profileOf('/u/.svall-dev-work', '/u')).toBe('work');
    expect([p.SHIM, p.OTHER_SHIM]).toEqual(['svall-dev', 'svall']);
    expect([p.DEFAULT_PORT, p.PRIVATE_HTTPS_PORT, p.HOME_CWD]).toEqual([47900, 10000, '~/.svall-dev/home']);
  });

  it('keeps the release on its own names', async () => {
    const p = await names('release');
    expect(p.BUNDLE_ID).toBe('io.github.linusroxbergh.svall');
    expect(p.profileHome(p.PRIVATE, '/u')).toBe('/u/.svall');
    expect(p.profileHome('work', '/u')).toBe('/u/.svall-work');
    expect([p.SHIM, p.OTHER_SHIM]).toEqual(['svall', 'svall-dev']);
    expect([p.DEFAULT_PORT, p.PRIVATE_HTTPS_PORT, p.HOME_CWD]).toEqual([47800, 443, '~/.svall/home']);
  });

  it("hands a checkout's Svall Dev.app helper to Svall Dev only", async () => {
    vi.stubEnv('SVALL_VARIANT', 'dev');
    expect((await import('../src/runtime.js')).hookHelperSource()).toMatch(/\/build\/Svall Dev\.app\/Contents\/Helpers\/svall-hook$/);
    vi.resetModules();
    vi.stubEnv('SVALL_VARIANT', 'release');
    expect((await import('../src/runtime.js')).hookHelperSource()).toBeUndefined();
  });

  it("tells a home's variant by its folder name, and claims no other home", async () => {
    const { variantOf } = await names('release');
    expect(variantOf('/u/.svall')).toBe('release');
    expect(variantOf('/u/.svall-work')).toBe('release');
    expect(variantOf('/u/.svall-devops')).toBe('release');
    expect(variantOf('/u/.svall-dev')).toBe('dev');
    expect(variantOf('/u/.svall-dev-work/')).toBe('dev');
    expect(variantOf('/tmp/svall-e2e-1a2b3c')).toBeUndefined();
  });

  it("refuses to start a daemon on the other variant's home", async () => {
    const { startDaemon } = await import('../src/main.js');
    await expect(startDaemon({ home: '/tmp/sv-guard/.svall-dev' })).rejects.toThrow(/Svall Dev/);
  });
});
