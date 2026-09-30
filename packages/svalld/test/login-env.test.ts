import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loginEnv } from '../src/login-env.js';

const shellScript = (body: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lp-')), 'sh');
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
};

describe('loginEnv', () => {
  it('reads PATH and where the agents keep their files between the markers, whatever the rc files print', async () => {
    const sh = shellScript('echo "welcome back"; PATH=/opt/x/bin:/usr/bin; CODEX_HOME=/c; export PATH CODEX_HOME; eval "$4"; echo "bye"');
    expect(await loginEnv({ shell: sh, timeoutMs: 5000 })).toEqual({ PATH: '/opt/x/bin:/usr/bin', CODEX_HOME: '/c' });
  });
  it('says nothing when the shell hangs', async () => {
    const sh = shellScript('sleep 30');
    const t = Date.now();
    expect(await loginEnv({ shell: sh, timeoutMs: 300 })).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(3000);
  });
  it('says nothing when the shell fails', async () => {
    expect(await loginEnv({ shell: '/nonexistent/shell', timeoutMs: 1000 })).toBeUndefined();
  });
});
