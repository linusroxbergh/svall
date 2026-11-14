import type { AppShow, PaneKind } from '@svall/protocol';
import QRCode from 'qrcode';
import type { Client } from '../client.js';
import { printResult } from '../format.js';
import { num, size } from './parse.js';
import { robotId } from './resolve.js';
import { withFleet } from '../client.js';

type Shown = 'show' | 'hide';
type Opts = {
  left?: PaneKind; right?: PaneKind | 'none'; ratio?: string; file?: string; preview?: boolean; tree?: Shown; card?: AppShow['card'];
  sidebar?: Shown; sideCard?: Shown; view?: AppShow['view']; panel?: AppShow['panel']; size?: string; redact?: string;
};

const shown = (v?: Shown): boolean | undefined => (v === undefined ? undefined : v === 'show');

/** What `svall app show` asks of the app, from its robot and flags. */
function showParams(id: string | undefined, o: Opts): AppShow {
  if (id === undefined) {
    const robotOnly = (['left', 'right', 'ratio', 'file', 'preview'] as const).find((k) => o[k] !== undefined);
    if (robotOnly) throw new Error(`--${robotOnly} needs a robot: svall app show <robot> --${robotOnly} …`);
    if (o.card === 'half' || o.card === 'full') throw new Error(`--card ${o.card} needs a robot whose card opens`);
  }
  if (o.left !== undefined && o.left === o.right && o.left !== 'terminal') throw new Error(`--left and --right both ask for ${o.left}`);
  if (o.preview && o.file === undefined) throw new Error('--preview goes with --file');
  if (o.redact !== undefined && o.panel !== 'phone') throw new Error('--redact goes with --panel phone');
  return {
    id, left: o.left, right: o.right, ratio: o.ratio === undefined ? undefined : num(o.ratio, '--ratio', { min: 0.25, max: 0.75 }),
    file: o.file, preview: o.preview, tree: shown(o.tree), card: o.card, sidebar: shown(o.sidebar), sideCard: shown(o.sideCard),
    view: o.view, panel: o.panel, size: size(o.size, '--size'),
  };
}

// a QR for url drawn as svalld's mobile.ts draws the fleet's, so it fills the same square
async function redactQr(c: Client, url: string): Promise<AppShow['redact']> {
  const status = await c.call('mobile.get', {});
  if (!status.serving) throw new Error('--redact needs the phone link on: svall mobile on');
  return { qr: await QRCode.toDataURL(url, { margin: 1, width: 320 }) };
}

export function appActions(connect: () => Promise<Client>, json: () => boolean) {
  return {
    show: (ref: string | undefined, o: Opts) => withFleet(connect, async (c, state) => {
      const p = showParams(ref === undefined ? undefined : robotId(state, ref), o);
      const r = await c.call('app.show', o.redact === undefined ? p : { ...p, redact: await redactQr(c, o.redact) });
      if (r.apps === 0) throw new Error('no app window has this fleet open');
      printResult(r, json(), () => 'shown');
    }),
  };
}
