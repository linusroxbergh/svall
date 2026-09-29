import { toUrl, type BrowserTab, type Character } from '@svall/protocol';
import { Invalid, NotFound } from './errors.js';
import { newId } from './ids.js';
import type { Store } from './store.js';
import { oneLine } from './text.js';

const tabIndex = (c: Character, tab: string): number => {
  const i = c.browser?.tabs.findIndex((t) => t.id === tab) ?? -1;
  if (i === -1) throw new NotFound(`no tab ${tab} on ${c.id}`);
  return i;
};

export function openTab(store: Store, c: Character, url: string, tab?: string): BrowserTab {
  const target = toUrl(url);
  if (!target) throw new Invalid('a tab needs a url');
  const t: BrowserTab = { id: tab ?? newId('t'), url: target, title: '' };
  if (c.browser?.tabs.some((x) => x.id === t.id)) throw new Invalid(`tab ${t.id} exists`);
  store.update((d) => {
    const b = (d.characters[c.id].browser ??= { tabs: [] });
    b.tabs.push(t);
    b.active = t.id;
  });
  return t;
}

export function closeTab(store: Store, c: Character, tab: string): void {
  const i = tabIndex(c, tab);
  store.update((d) => {
    const b = d.characters[c.id].browser!;
    b.tabs.splice(i, 1);
    if (!b.tabs.length) { delete d.characters[c.id].browser; return; }
    if (b.active === tab) b.active = b.tabs[Math.min(i, b.tabs.length - 1)].id;
  });
}

export function activateTab(store: Store, c: Character, tab: string): void {
  tabIndex(c, tab);
  store.update((d) => { d.characters[c.id].browser!.active = tab; });
}

// a page reports its own url and title, each kept to one line; a view between pages has no url yet
export function updateTab(store: Store, c: Character, tab: string, patch: { url?: string; title?: string }): void {
  const i = tabIndex(c, tab);
  store.update((d) => {
    const t = d.characters[c.id].browser!.tabs[i];
    if (patch.url) t.url = oneLine(patch.url);
    if (patch.title !== undefined) t.title = oneLine(patch.title).slice(0, 200);
  });
}
