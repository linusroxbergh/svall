import type { MobileStatus, PhoneSession } from '@svall/protocol';
import { splitRaw, withoutTokens } from './host.js';
import { pad } from './usageText.js';

/** Who has the phone page open right now: the line the corner panel and the settings row both carry,
 *  each with its own word for nobody, since the settings row has a label to lean on. */
export function phonesHere(phones: PhoneSession[] = [], none = 'nobody has this open'): string {
  if (!phones.length) return none;
  return phones.map((p) => {
    const d = new Date(p.since);
    return `${p.login} since ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }).join(' · ');
}

export const NO_PAGE = 'No phone page built. Turn the switch off and on to build it, then re-enable notifications on each phone.';

export const OFF = 'Reach this fleet from your phone, over your tailnet only.';

/** What keeps the phone link from serving: the daemon's sentence, fix and command with what the tool said apart, or one sentence before what it said whole. */
export function phoneProblem(s: MobileStatus): { line: string; fix?: string; raw?: string; run?: string } | undefined {
  const said = s.error ?? s.reason;
  if (!said) return undefined;
  if (s.fix !== undefined || s.raw !== undefined) return { line: said, fix: s.fix, raw: s.raw, run: s.run };
  return splitRaw(said).raw === undefined ? { line: said } : { line: 'The phone link could not start.', raw: withoutTokens(said) };
}
