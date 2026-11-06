import { isDoc, PLUGIN_LISTS, type Doc, type WorkerState } from './mirror-state.js';

export const isList = (to: string): boolean => PLUGIN_LISTS.some((n) => to === `claude/plugins/${n}`);

export const entriesOf = (to: string, list: unknown): Doc => {
  const e = to.endsWith('installed_plugins.json') && isDoc(list) ? list.plugins : list;
  return isDoc(e) ? e : {};
};

type Merging = { state: WorkerState; additive: boolean };

/** What a merge leaves of the entries `held` holds: what the mirror did not write, a record from before it kept their names leaving none. */
export const ownEntries = (key: string, held: Doc, named: boolean, { state, additive }: Merging): Doc => {
  const wrote = additive ? [] : state.listed?.[key] ?? (named ? Object.keys(held) : []);
  return Object.fromEntries(Object.entries(held).filter(([k]) => !wrote.includes(k)));
};

/** List `to` as it lands: the sender's entries over this machine's own. */
export function withOwnEntries(to: string, list: Doc, heldList: unknown, a: Merging): Doc {
  const merged = { ...ownEntries(to, entriesOf(to, heldList), Object.hasOwn(a.state.files, to), a), ...entriesOf(to, list) };
  return to.endsWith('installed_plugins.json') ? { ...(isDoc(heldList) ? heldList : {}), ...list, plugins: merged } : merged;
}

export const parsed = (text: string | Buffer | void): unknown => {
  try { return text === undefined ? undefined : JSON.parse(text.toString()); } catch { return undefined; }
};
