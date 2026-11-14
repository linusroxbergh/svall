import QRCode from 'qrcode';
import { SHIM } from '@svall/svalld/profile';
import { isRelease } from '@svall/svalld/release';
import type { Client } from '../client.js';
import { printResult } from '../format.js';
import { withClient } from '../client.js';

export function mobileActions(connect: () => Promise<Client>, json: () => boolean) {
  // the daemon answers an environment it cannot serve in with a reason rather than a failed call; its
  // base64 data url is for the app, so no command here carries it
  const set = async (enabled: boolean) => {
    const { qr: _qr, ...status } = await withClient(connect, (c) => c.call('mobile.set', { enabled }));
    if (status.error) throw new Error(status.error);
    return status;
  };

  return {
    on: async () => {
      const status = await set(true);
      // a caller reading json wants no terminal drawing either
      if (json()) { printResult(status, true); return; }
      // the link with the pass is the one a phone pairs by
      const link = status.pair ?? status.url;
      const qr = await QRCode.toString(link, { type: 'terminal', small: true });
      printResult(status, false, () => [
        qr,
        link,
        status.logins.length ? `only ${status.logins.join(', ')} may drive the fleet; to let others in, list them and yourself in mobile.logins in fleet.json and restart the daemon` : 'no login may drive the fleet until mobile.logins in fleet.json names one and the daemon restarts',
        ...(status.pageMissing ? [isRelease() ? 'this release carries no phone page' : 'the phone page is missing: pnpm --filter @svall/desktop-web build:mobile'] : []),
        'On the phone: open the link, then Share → Add to Home Screen.',
      ].join('\n'));
    },

    off: async () => {
      printResult(await set(false), json(), () => `tailscale serve stopped\nafter the next \`${SHIM} mobile on\`, each phone has to turn notifications on again (⚙ → Notify this phone)`);
    },
  };
}
