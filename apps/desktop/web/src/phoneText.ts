import type { PhoneSession } from '@archipelago/protocol';

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

export const NO_PAGE = 'This checkout has no phone page built. Turn the switch off and on to build one, then turn notifications on again on each phone.';

export const OFF = 'Turn this on to reach this fleet from your phone, over your tailnet only. After you turn it off, turn notifications on again on each phone (⚙ → Notify this phone). If this checkout has no phone page built yet, the first start takes a few minutes.';
