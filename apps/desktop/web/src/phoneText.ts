import type { MobileStatus, PhoneSession } from '@svall/protocol';
import { splitRaw, withoutTokens } from './host.js';
import { pad } from './usageText.js';

/** Who has the phone page open right now: the line the corner panel and the settings row both carry, the row's
 *  `labelled` by its label, so it says neither what nor its own word for nobody. */
export function phonesHere(phones: PhoneSession[] = [], labelled = false): string {
  if (!phones.length) return labelled ? 'nobody' : 'nobody has this open';
  return phones.map((p) => {
    const d = new Date(p.since);
    return `${p.login} ${labelled ? '' : 'connected '}since ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }).join(' · ');
}

// the panes open now that say the phone link's problem, which a toast then need not say again
let saying = 0;
/** A pane that says the problem stands until the function it returns is called. */
export const sayingPhone = (): (() => void) => { saying++; return () => { saying--; }; };
export const phoneSaid = (): boolean => saying > 0;

export const NO_PAGE = 'No phone page built. Turn the switch off and on to build it, then re-enable notifications on each phone.';

export const OFF = 'Reach this fleet from your phone, over your tailnet only.';

/** What keeps the phone link from serving: the daemon's sentence, fix and command with what the tool said apart, or one sentence before what it said whole. */
export function phoneProblem(s: MobileStatus): { line: string; fix?: string; raw?: string; run?: string } | undefined {
  const said = s.error ?? s.reason;
  if (!said) return undefined;
  if (s.fix !== undefined || s.raw !== undefined) return { line: said, fix: s.fix, raw: s.raw, run: s.run };
  return splitRaw(said).raw === undefined ? { line: said } : { line: 'The phone link could not start.', raw: withoutTokens(said) };
}
