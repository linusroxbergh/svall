import { PaneKind, type AppShow } from '@svall/protocol';
import { Command, Option } from 'commander';
import QRCode from 'qrcode';
import type { Client } from '../client.js';
import { printResult } from '../format.js';
import { withFleet } from './fleet.js';
import { num, size } from './parse.js';
import { robotId } from './resolve.js';

type Shown = 'show' | 'hide';
type Opts = {
  left?: PaneKind; right?: PaneKind | 'none'; ratio?: string; file?: string; preview?: boolean; tree?: Shown; card?: AppShow['card'];
  sidebar?: Shown; sideCard?: Shown; view?: AppShow['view']; panel?: AppShow['panel']; size?: string; redact?: string;
};

const SHOWN = ['show', 'hide'];
const shown = (v?: Shown): boolean | undefined => (v === undefined ? undefined : v === 'show');

/** What `svall app show` asks of the app, from its robot and flags. */
export function showParams(id: string | undefined, o: Opts): AppShow {
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

// a QR for url whose modules are the size of the fleet's, as svalld's mobile.ts draws it: the quiet zone makes up the difference
async function redactQr(c: Client, url: string): Promise<AppShow['redact']> {
  const status = await c.call('mobile.get', {});
  if (!status.serving) throw new Error('--redact needs the phone link on: svall mobile on');
  const modules = (text: string) => QRCode.create(text, {}).modules.size;
  const margin = 1 + (modules(status.pair ?? status.url) - modules(url)) / 2;
  if (margin < 1) throw new Error(`a QR for ${url} is denser than the fleet's`);
  return { qr: await QRCode.toDataURL(url, { margin, width: 320 }) };
}

export function appCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const cmd = new Command('app').description('what the app window on this fleet shows');

  cmd.command('show').description("show a robot's card, its panes and the window's sides; what is left out stays")
    .argument('[robot]', 'the robot whose card opens')
    .addOption(new Option('--left <pane>', 'the left pane').choices(PaneKind.options))
    .addOption(new Option('--right <pane>', 'the right pane, or none for the left alone').choices([...PaneKind.options, 'none']))
    .option('--ratio <share>', "the left pane's share of the card, 0.25 to 0.75")
    .option('--file <path>', "open a file in the robot's Files, as a link in its terminal would")
    .addOption(new Option('--preview', 'show the --file formatted, when it is markdown').hideHelp())
    .addOption(new Option('--tree <state>', "the folders beside Files' editor").choices(SHOWN))
    .addOption(new Option('--card <size>', "the robot's card; closed leaves the robot selected").choices(['half', 'full', 'closed']))
    .addOption(new Option('--sidebar <state>', 'the islands list on the left').choices(SHOWN))
    .addOption(new Option('--side-card <state>', "the selected robot's details on the right").choices(SHOWN))
    .addOption(new Option('--view <view>', 'the map or the board').choices(['map', 'board']))
    .addOption(new Option('--panel <panel>', "the dock's panel, or none").choices(['phone', 'usage', 'load', 'none']))
    .option('--size <w,h>', "the window's size in points, like 1280,820")
    .addOption(new Option('--redact <url>', "with --panel phone, a QR for url in place of the fleet's, and its link and logins hidden").hideHelp())
    .action((ref: string | undefined, o: Opts) => withFleet(connect, async (c, state) => {
      const p = showParams(ref === undefined ? undefined : robotId(state, ref), o);
      const r = await c.call('app.show', o.redact === undefined ? p : { ...p, redact: await redactQr(c, o.redact) });
      if (r.apps === 0) throw new Error('no app window has this fleet open');
      printResult(r, json(), () => 'shown');
    }));

  return cmd;
}
