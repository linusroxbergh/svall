import { Command } from 'commander';
import QRCode from 'qrcode';
import { SHIM } from '@svall/svalld/profile';
import type { Client } from '../client.js';
import { printResult } from '../format.js';

export function mobileCommand(connect: () => Promise<Client>, json: () => boolean): Command {
  const cmd = new Command('mobile').description('serve the fleet to your phone over Tailscale');

  // the daemon answers an environment it cannot serve in with a reason rather than a failed call; its
  // base64 data url is for the app, so no command here carries it
  const set = async (enabled: boolean) => {
    const c = await connect();
    const { qr: _qr, ...status } = await c.call('mobile.set', { enabled });
    c.close();
    if (status.error) throw new Error(status.error);
    return status;
  };

  cmd.command('on', { isDefault: true }).description('have the daemon start tailscale serve, and print a QR code')
    .action(async () => {
      const status = await set(true);
      // a caller reading json wants no terminal drawing either
      if (json()) { printResult(status, true); return; }
      const qr = await QRCode.toString(status.url, { type: 'terminal', small: true });
      printResult(status, false, () => [
        qr,
        status.url,
        status.logins.length ? `only ${status.logins.join(', ')} may drive the fleet; to let others in, list them and yourself in mobile.logins in config.json and restart the daemon` : 'no login may drive the fleet until mobile.logins in config.json names one and the daemon restarts',
        ...(status.pageMissing ? ['the phone page is missing: pnpm --filter @svall/desktop-web build:mobile'] : []),
        'On the phone: open the link, then Share → Add to Home Screen.',
      ].join('\n'));
    });

  cmd.command('off').description('stop serving; the daemon stays up')
    .action(async () => {
      printResult(await set(false), json(), () => `tailscale serve stopped\nafter the next \`${SHIM} mobile on\`, each phone has to turn notifications on again (⚙ → Notify this phone)`);
    });

  return cmd;
}
