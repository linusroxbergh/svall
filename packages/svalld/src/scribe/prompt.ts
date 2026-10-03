import { z, type ZodType } from 'zod';
import { bareUrl, itemUrl, linkKind, trimEnd, type Character, type ContextItem, type Island } from '@svall/protocol';
import { LINK } from '../agent/jsonl.js';
import { MAX_REF } from '../context/items.js';
import { isGeneratedName } from '../names.js';
import { oneLine } from '../text.js';

// two lines on a token
const NAME_MAX = 24;
export const NOTE_MAX = 80;
export const DESCRIPTION_MAX = 280;
// a link's chip
const LABEL_MAX = 40;

export const SYSTEM_CHARACTER = `You describe one coding agent's work for a map of a fleet of agents. You get its name, directory, branch, note, links, and the end of its transcript. Reply with one JSON object and nothing else:
{"name": {"value": "...", "reason": "generated" | "identifier"}, "note": "...", "links": [{"url": "...", "label": "..."}]}

name: omit it unless the name should change. Any name that is not a placeholder is the user's and keeps its words.
- generated: the current name is marked as a generated placeholder. Replace it whenever you can write a note.
- identifier: the work has a PR or ticket a name that is not a placeholder lacks. Put it in front of the current name, which stays as it is: "robin review" becomes "#542 robin review".
A name is at most 4 words and ${NAME_MAX} characters, count them; lower case except the identifier, identifier first (#542, ENG-1907), then what the agent is doing and what on, in one or two words each: "#542 review auth tests", "ENG-1907 fix login", "deploy web". An identifier and a verb alone say too little: not "#542 review".

note: one line under ${NOTE_MAX} characters on the session's overall goal, the feature or fix the work is for, never the step it is on: "rewrite of the auth test helpers", not "finishing task 2, task 3 next". Omit it when the note is hand-written or the current note still names the goal.

links: full URLs the transcript, the PR evidence or an auto PR names, copied exactly, for the things the work is about: every PR it opens, reviews or works on, and its issues, tickets and docs. A PR named by number may have its URL in the PR evidence. Link the item itself, not a comment, commit or file inside it, and not a repository or home page. Leave out links listed as manual, and auto links other than PRs. Keep the scribe links still worth having. Short labels: "#542", "ENG-1907", "design doc". List the PR the work is on first. [] when there are none.

With too little to go on, omit name and note.`;

export const SYSTEM_ISLAND = `You describe one island on a map of a fleet of coding agents: a group of agents the user keeps together. You get its name, description and links, and each member's name, directory, branch, note and links. Reply with one JSON object and nothing else:
{"description": "...", "links": [{"url": "...", "label": "..."}]}

description: one to three sentences under ${DESCRIPTION_MAX} characters on what the island is for: the project or goal its members' work shares, the repositories it spans, and the threads of work within it. Not how it is going. Omit it when the description is hand-written or already says all of this.

links: full URLs from the members' links, copied exactly, for the things the island as a whole is about: the repositories, projects, epics and docs its work shares. A PR or ticket only when it is what the island is about, not one member's own. Leave out links listed as manual. Keep the scribe links still worth having. Short labels: "svall", "auth epic", "design doc". [] when there are none.`;

const REASONS = ['generated', 'identifier'] as const;

export const CharacterAnswer = z.object({
  name: z.object({ value: z.string(), reason: z.enum(REASONS) }).nullish(),
  note: z.string().nullish(),
  // absent keeps the scribe's links as they are
  links: z.array(z.object({ url: z.string(), label: z.string().default('') })).nullish(),
});
export type CharacterAnswer = z.infer<typeof CharacterAnswer>;

export const IslandAnswer = z.object({
  description: z.string().nullish(),
  links: z.array(z.object({ url: z.string(), label: z.string().default('') })).nullish(),
});
export type IslandAnswer = z.infer<typeof IslandAnswer>;

// the model may wrap its object in prose or a code fence
export function parseAnswer<T>(schema: ZodType<T>, text: string): T {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error("the scribe's answer has no JSON object");
  let parsed: unknown;
  // the parser's message quotes the text it choked on, and that text is the model's
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error("the scribe's answer is not valid JSON"); }
  const r = schema.safeParse(parsed);
  if (!r.success) throw new Error(`the scribe's answer has the wrong shape: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return r.data;
}

const linkLine = (it: ContextItem): string => `- ${it.source} ${it.label && it.label !== it.ref ? `${it.label} ` : ''}${it.ref}`;

// the last n distinct values, in the order each was last seen
const lastDistinct = (xs: string[], n: number): string[] => [...new Set([...xs].reverse())].slice(0, n).reverse();

// The condensed transcript can lose a PR URL in an older tool result. An explicit "PR #42"
// also names a PR without spelling out its URL; the known GitHub repository supplies that part.
export function prEvidence(c: Character, transcript: string, tail: string): string[] {
  const urls = [...(tail.match(LINK) ?? [])]
    .map((url) => itemUrl(trimEnd(url, '.,;:!?')))
    .filter((url) => /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/pull\/\d+$/i.test(url));
  const found = new Set(lastDistinct(urls, 8));
  const repo = c.context.map((it) => it.ref.replace(/\/pull\/\d+\/?$/i, ''))
    .find((ref) => /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/?$/i.test(ref));
  if (repo) {
    const refs = [...(`${tail}\n${transcript}`.matchAll(/\b(?:PR|pull request)\s*#?\s*(\d+)\b|\b#(\d+)\s+(?:PR|pull request)\b/gi))]
      .map((m) => m[1] ?? m[2]);
    for (const number of lastDistinct(refs, 8)) {
      if (![...found].some((url) => url.endsWith(`/pull/${number}`))) found.add(`${repo.replace(/\/$/, '')}/pull/${number}`);
    }
  }
  return [...found].slice(-8);
}

export function characterPrompt(c: Character, transcript: string, others: string[], prLinks: string[] = []): string {
  const note = !c.note ? 'Note: (none)' : c.noteSource === 'manual' ? `Note (hand-written): ${c.note}` : `Note: ${c.note}`;
  return [
    `Name: ${c.name}${isGeneratedName(c.name) ? ' (generated placeholder)' : ''}`,
    `Directory: ${c.cwd}`,
    c.repo && `Branch: ${c.repo.branch}`,
    note,
    c.context.length ? ['Links:', ...c.context.map(linkLine)].join('\n') : 'Links: (none)',
    prLinks.length ? ['PR evidence (candidate links; choose only those this work is about):', ...prLinks.map((url) => `- ${url}`)].join('\n') : '',
    others.length ? `Names other agents have, which a new name must not repeat: ${others.join(', ')}` : '',
    '',
    'Transcript, most recent last:',
    '<transcript>',
    transcript,
    '</transcript>',
  ].filter((l): l is string => typeof l === 'string').join('\n');
}

export function islandPrompt(i: Island, members: Character[]): string {
  const links = (items: ContextItem[], indent: string) => items.map((it) => `${indent}${linkLine(it)}`);
  return [
    `Island: ${i.name}`,
    `Description${i.descriptionSource === 'manual' ? ' (hand-written)' : ''}: ${i.description || '(none)'}`,
    i.context.length ? 'Links:' : 'Links: (none)',
    ...links(i.context, ''),
    'Members:',
    ...members.flatMap((c) => [
      `- ${c.name} | ${c.cwd}${c.repo ? ` | ${c.repo.branch}` : ''} | ${c.note.split('\n')[0] || '(no note)'}`,
      ...links(c.context, '  '),
    ]),
  ].join('\n');
}

// the model miscounts, so text too long to fit loses words from the end
const fit = (text: string, max: number): string => {
  const words = text.split(' ');
  while (words.length > 1 && words.join(' ').length > max) words.pop();
  return words.join(' ');
};

// the new name, or undefined when the current one stays; taken is matched in any case, as the CLI resolves names
export function acceptName(current: string, proposal: CharacterAnswer['name'], taken: ReadonlySet<string>): string | undefined {
  if (!proposal) return undefined;
  // a generated name is replaced outright; only a given one keeps its words behind an identifier
  const generated = isGeneratedName(current);
  if (proposal.reason === 'generated' && !generated) return undefined;
  if (proposal.reason === 'identifier' && generated) return undefined;
  const given = oneLine(proposal.value);
  // an identifier goes in front of the whole current name, so there is nothing to trim
  if (proposal.reason === 'identifier' && !given.endsWith(` ${current}`)) return undefined;
  const v = proposal.reason === 'identifier' ? given : fit(given, NAME_MAX);
  const lower = v.toLowerCase();
  if (!v || v === current || v.length > NAME_MAX || [...taken].some((t) => t.toLowerCase() === lower)) return undefined;
  return v;
}

// one line of at most max characters, or undefined when there is nothing to write
export function acceptLine(text: string | null | undefined, max: number): string | undefined {
  const v = fit(oneLine(text ?? ''), max).slice(0, max);
  return v || undefined;
}

// the scribe's links after this answer: only URLs the given text names or the scribe already holds, none the other sources hold.
// The branch's PR is the scribe's to take too, pin and all, so the work keeps it once its checkout moves to another branch.
// A held link someone pinned, or that the branch's lookup still reads a state for, stays whatever the answer says
export function acceptLinks(proposed: NonNullable<CharacterAnswer['links']>, text: string, context: ContextItem[]): ContextItem[] {
  const held = new Map(context.filter((it) => it.source === 'scribe').map((it) => [bareUrl(it.ref), it]));
  const branchPrs = new Map(context.filter((it) => it.source === 'auto' && it.kind === 'pr').map((it) => [bareUrl(it.ref), it]));
  const seen = new Set(context.filter((it) => it.source !== 'scribe').map((it) => bareUrl(it.ref)).filter((key) => !branchPrs.has(key)));
  const out: ContextItem[] = [];
  for (const { url, label } of proposed) {
    const ref = itemUrl(url.trim());
    if (ref.length > MAX_REF || !/^https?:\/\/\S+$/.test(ref)) continue;
    const key = bareUrl(ref);
    if (seen.has(key) || !(text.includes(ref) || held.has(key) || branchPrs.has(key))) continue;
    seen.add(key);
    const pinned = (held.get(key) ?? branchPrs.get(key))?.pinned;
    out.push({ kind: linkKind(ref), ref, label: acceptLine(label, LABEL_MAX) ?? ref, source: 'scribe', ...(pinned ? { pinned } : {}) });
  }
  for (const [key, it] of held) if ((it.pinned || it.prState) && !seen.has(key)) out.push(it);
  return out;
}
