import { Command } from 'commander';
import type { Client } from '../client.js';
import { lazy } from './lazy.js';

export function mobileCommand(connect: () => Promise<Client>, json: () => boolean): Command {
  const run = lazy(() => import('../commands/mobile.js').then((m) => m.mobileActions(connect, json)));
  const cmd = new Command('mobile').description('serve the fleet to your phone over Tailscale');

  cmd.command('on', { isDefault: true }).description('have the daemon start tailscale serve, and print a QR code')
    .action(run('on'));

  cmd.command('off').description('stop serving; the daemon stays up')
    .action(run('off'));

  return cmd;
}
