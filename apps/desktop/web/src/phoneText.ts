import type { PhoneSession } from '@svall/protocol';

const pad = (n: number): string => String(n).padStart(2, '0');

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

export const OFF = 'Reach this fleet from your phone, over your tailnet only. The first start can take a few minutes. After turning it off, re-enable notifications on each phone.';
