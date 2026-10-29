import QRCode from 'qrcode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppShow } from '@svall/protocol';
import type { Client } from '../src/client.js';
import { appCommands } from '../src/commands/app.js';

const PAIR = 'https://mac.tail1234ab.ts.net:8443/#p4ssw0rdp4ssw0rdp4ssw0rd';

function fake(apps = 1, pair = PAIR) {
  const asked: AppShow[] = [];
  const out: string[] = [];
  const client = {
    call: (method: string, p: AppShow) => {
      if (method === 'state.get') return Promise.resolve({ robots: { c_1: { id: 'c_1', name: 'flaky e2e' } } });
      if (method === 'mobile.get') return Promise.resolve({ serving: pair !== '', url: PAIR.split('#')[0], pair: PAIR });
      asked.push(p);
      return Promise.resolve({ apps });
    },
    close: () => {},
  } as unknown as Client;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  const run = (...args: string[]) => appCommands(() => Promise.resolve(client), () => false).parseAsync(['show', ...args], { from: 'user' });
  return { asked, out, run };
}

afterEach(() => vi.restoreAllMocks());

describe('svall app show', () => {
  it('asks the app for the robot by its name, and only for the flags given', async () => {
    const f = fake();
    await f.run('flaky e2e', '--left', 'terminal', '--right', 'files', '--file', 'README.md', '--preview', '--tree', 'hide', '--ratio', '0.4', '--size', '1280,820');
    expect(f.asked).toEqual([{ id: 'c_1', left: 'terminal', right: 'files', file: 'README.md', preview: true, tree: false, ratio: 0.4, size: { w: 1280, h: 820 } }]);
    expect(f.out.join('')).toBe('shown\n');
  });

  it('opens the sides and a panel with no robot named', async () => {
    const f = fake();
    await f.run('--card', 'closed', '--sidebar', 'show', '--side-card', 'hide', '--panel', 'phone', '--view', 'map');
    expect(f.asked).toEqual([{ card: 'closed', sidebar: true, sideCard: false, panel: 'phone', view: 'map' }]);
  });

  it('refuses a robot\'s pane, file or card with no robot, and two of one pane', async () => {
    const f = fake();
    await expect(f.run('--right', 'files')).rejects.toThrow('--right needs a robot');
    await expect(f.run('--card', 'half')).rejects.toThrow('--card half needs a robot');
    await expect(f.run('c_1', '--left', 'files', '--right', 'files')).rejects.toThrow('--left and --right both ask for files');
    await expect(f.run('c_1', '--preview')).rejects.toThrow('--preview goes with --file');
    await expect(f.run('c_1', '--ratio', '0.9')).rejects.toThrow('bad --ratio');
    expect(f.asked).toEqual([]);
  });

  it("hands the phone panel a QR for the url with modules the size of the fleet's", async () => {
    const f = fake();
    await f.run('--panel', 'phone', '--redact', 'https://svall.dev');
    const margin = 1 + (QRCode.create(PAIR, {}).modules.size - QRCode.create('https://svall.dev', {}).modules.size) / 2;
    expect(f.asked).toEqual([{ panel: 'phone', redact: { qr: await QRCode.toDataURL('https://svall.dev', { margin, width: 320 }) } }]);
    await expect(f.run('--redact', 'https://svall.dev')).rejects.toThrow('--redact goes with --panel phone');
    await expect(fake(1, '').run('--panel', 'phone', '--redact', 'https://svall.dev')).rejects.toThrow('--redact needs the phone link on');
  });

  it('fails when no app window has the fleet open', async () => {
    await expect(fake(0).run('c_1')).rejects.toThrow('no app window has this fleet open');
  });
});
