import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvisionRefused } from '@svall/svalld/linux/provision';
import { provisionCommand } from '../src/commands/fleet-provision.js';
import { REFUSED } from '../src/controller/host.js';

const FLEET = '11111111-2222-3333-4444-555555555555';
const GATEWAY = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const run = (args: string[], platform: NodeJS.Platform = 'linux') =>
  provisionCommand(() => ({ name: 'private', home: '/nowhere/.svall', managed: true }), () => true, platform).parseAsync(args, { from: 'user' });

afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

describe('svall fleet provision', () => {
  it('exits with its own code on a refusal, saying why, so the controller tells it from any other failure', async () => {
    const said: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { said.push(String(chunk)); return true; });
    const why = '/home/linus/.svall holds fleet 47a74455-7dbc-46c0-8076-30d830cf4f72, and it holds 3 characters, so it is not this fleet\'s to replace';
    const refused = provisionCommand(() => ({ name: 'private', home: '/home/linus/.svall', managed: true }), () => true, 'linux', async () => { throw new ProvisionRefused(why); });
    await refused.parseAsync(['--id', FLEET, '--gateway', GATEWAY], { from: 'user' });
    expect(process.exitCode).toBe(REFUSED);
    expect(said.join('')).toBe(`svall: ${why}\n`);

    const broken = provisionCommand(() => ({ name: 'private', home: '/home/linus/.svall', managed: true }), () => true, 'linux', async () => { throw new Error('systemctl --user enable --now svall-svalld@private.service: failed'); });
    await expect(broken.parseAsync(['--id', FLEET, '--gateway', GATEWAY], { from: 'user' })).rejects.toThrow(/systemctl/);
  });

  it('refuses ids that are not a fleet\'s and a machine\'s before it looks at anything', async () => {
    await expect(run(['--id', 'nope', '--gateway', GATEWAY])).rejects.toThrow(/nope is not a fleet id/);
    await expect(run(['--id', FLEET, '--gateway', '../x'])).rejects.toThrow(/\.\.\/x is not a machine id/);
  });

  it('runs only on a Linux companion, whose systemd runs the fleet', async () => {
    await expect(run(['--id', FLEET, '--gateway', GATEWAY], 'darwin')).rejects.toThrow(/Linux/);
  });

  it('refuses a home that is not a profile\'s own, which no unit runs', async () => {
    const cmd = provisionCommand(() => ({ name: 'dev', home: '/tmp/dev', managed: false }), () => true, 'linux');
    await expect(cmd.parseAsync(['--id', FLEET, '--gateway', GATEWAY], { from: 'user' })).rejects.toThrow(/\/tmp\/dev is not a profile's home/);
  });
});
