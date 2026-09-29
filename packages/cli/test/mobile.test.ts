import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MobileStatus } from '@svall/protocol';
import type { Client } from '../src/client.js';
import { mobileCommand } from '../src/commands/mobile.js';

const SERVING: MobileStatus = { serving: true, url: 'https://mac.tailnet.ts.net:8443/', port: 8443, logins: [], phones: [] };

function fake(status: MobileStatus, json = false) {
  const asked: boolean[] = [];
  const out: string[] = [];
  const client = {
    call: (_method: string, p: { enabled: boolean }) => { asked.push(p.enabled); return Promise.resolve(status); },
    close: () => {},
  } as unknown as Client;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  const run = (...args: string[]) => mobileCommand(() => Promise.resolve(client), () => json).parseAsync(args, { from: 'user' });
  return { asked, out, run };
}

afterEach(() => vi.restoreAllMocks());

describe('svall mobile', () => {
  it('asks the daemon to serve, and prints the QR and the link it answers with', async () => {
    const f = fake({ ...SERVING, logins: ['you@example.com'] });
    await f.run('on');
    expect(f.asked).toEqual([true]);
    expect(f.out.join('')).toContain('https://mac.tailnet.ts.net:8443/');
    expect(f.out.join('')).toContain('█');
    expect(f.out.join('')).toContain('only you@example.com may drive the fleet; to let others in, list them and yourself in mobile.logins');
  });

  it('leaves the QR out of the json, drawn or as the daemon sent it', async () => {
    const f = fake({ ...SERVING, qr: 'data:image/png;base64,AAAA' }, true);
    await f.run('on');
    const printed = JSON.parse(f.out.join('')) as MobileStatus;
    expect(printed.qr).toBeUndefined();
    expect(printed.url).toBe(SERVING.url);
    expect(f.out.join('')).not.toContain('█');

    const g = fake({ ...SERVING, serving: false, qr: 'data:image/png;base64,AAAA' }, true);
    await g.run('off');
    expect((JSON.parse(g.out.join('')) as MobileStatus).qr).toBeUndefined();
  });

  it('says how to build the phone page when the daemon reports none', async () => {
    const f = fake({ ...SERVING, pageMissing: true });
    await f.run('on');
    expect(f.out.join('')).toContain('pnpm --filter @svall/desktop-web build:mobile');
  });

  it('fails with the reason the daemon could not make the link', async () => {
    const f = fake({ serving: false, url: '', port: 443, logins: [], phones: [], error: 'tailscale not found' });
    await expect(f.run('on')).rejects.toThrow('tailscale not found');
  });

  it('takes the serving down again', async () => {
    const f = fake({ ...SERVING, serving: false });
    await f.run('off');
    expect(f.asked).toEqual([false]);
    expect(f.out.join('')).toContain('tailscale serve stopped');
    expect(f.out.join('')).toContain('turn notifications on again');
  });
});
