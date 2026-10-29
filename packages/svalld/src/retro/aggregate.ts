import os from 'node:os';
import path from 'node:path';
import { ellipsis, GroupKind, type AgentKind } from '@svall/protocol';
import { activeMs, type SessionCard } from './cards.js';
import type { CommentClass, Label, LabelItem, ReviewRun } from './labels.js';
import type { Command, Outline } from './outline.js';
import type { Target } from './targets.js';


/** One thing a group can show as an example: a turn of a session, or a comment on a PR. */
export type Evidence = { id: string; agent?: AgentKind; session?: string; at?: string; pr?: string; comment?: string; when: number; repo?: string; text: string };

/** What code counted: `n` occurrences in all, `hit` of `of` in the rate's unit, and up to five examples. `occ` and `hits` are
 *  what was counted, so findings citing several groups count each once. */
export type Group = {
  id: string; kind: GroupKind; key: string; n: number; hit: number; of: number; unit: 'sessions' | 'runs' | 'prs';
  occ: string[]; hits: string[]; sessions: string[]; prs: string[]; examples: string[]; last: number;
  elapsedMs?: number; steps?: number; impact?: number; beside?: { later: number; unknown: number }; expected?: true; signature?: string;
};

export type Labelled = { item: LabelItem; label: Label; class: CommentClass };
export type AggregateInput = {
  outlines: Outline[]; cards: Map<string, SessionCard>; labelled: Labelled[]; reviews: ReviewRun[];
  repoOf: Map<string, string | undefined>; targets: Target[]; unused: string[];
};
export type ReviewTotals = {
  prs: number; later: number; confirmed: number; unknown: number; missPrs: number;
  themes: { theme: string; severity: string; later: number; confirmed: number; unknown: number }[];
};
export type Aggregate = {
  groups: Group[]; evidence: Map<string, Evidence>; works: { skill: string; clean: number; runs: number }[]; wins: Evidence[];
  skills: { skill: string; runs: number; went: Record<string, number> }[];
  mix: { repo: string; kind: string; sessions: number }[]; activeMs: number; reviews: ReviewTotals; unused: { source: string; skills: string[] }[];
};

const EXAMPLES = 5, TEXT = 300, KEY = 120, SIGNATURE = 160, WINS = 20, WORKS_RUNS = 5, WORKS_SHARE = 0.85;
const PROBES = new Set(['ls', 'cat', 'grep', 'rg', 'find', 'test', 'sleep', 'echo', 'which', 'stat', 'wc', 'sed', 'awk', 'jq', 'cd']);
const ERRORISH = /error|exception|fail|cannot|refused|denied|not found|no such file|timed? ?out/i;
// a heading, a rule or a label such as `Failures:` names no cause
const HEADER = /^(?:#+\s.*|[\W_]+|\S+(?:\s\S+)?:)$/;
const SEVERITY = { low: 2, medium: 3, high: 4 } as const;
// a correction that names the rule file it is about is kept apart from others of its kind
const RULE_FILE = /\b(CLAUDE\.md|AGENTS\.md|rules\/[\w.-]+\.md)\b/;

/** A command by its program and subcommand, past a leading `cd … &&` and the variables set for it. */
export function program(command: string): string {
  const words = command.replace(/^(?:\s*cd\s+\S+\s*(?:&&|;))+/, '').trim().split(/\s+/);
  while (/^[A-Za-z_]\w*=/.test(words[0] ?? '')) words.shift();
  const [name = '', sub] = words;
  return sub && /^[a-z][\w:-]*$/.test(sub) ? `${name} ${sub}` : name;
}

// what tells failures apart: status and exit codes and error classes stay, paths, hashes, line numbers and durations go
const normal = (line: string): string => line
  .replace(/(?<!\w)(?:~|\.{1,2})?\/[^\s'"`:,()]+/g, '<path>')
  .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, '<hash>')
  .replace(/:\d+(?::\d+)?\b/g, ':<n>')
  .replace(/\bline \d+\b/gi, 'line <n>')
  .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|m|min|h)\b/g, '<t>');

/** A failed command's program and what failed, from the first line of its output that reads as an error; a probe failing
 *  with no such file, not found or no error, and a command the user interrupted, are expected exits. */
export function signature(c: Command): { key: string; signature: string; expected: boolean } {
  const key = program(c.text);
  const lines = (c.out ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !HEADER.test(l));
  const error = lines.find((l) => ERRORISH.test(l));
  const line = error ?? lines[0];
  const interrupted = c.exit === undefined && /interrupted/i.test(c.out ?? '');
  const expected = interrupted || (PROBES.has(key.split(' ')[0]) && (!error || /no such file|not found/i.test(c.out ?? '')));
  return { key, signature: ellipsis(`exit ${c.exit ?? '?'}${line ? ` · ${normal(line)}` : ''}`, SIGNATURE), expected };
}

/** Runs of 3–5 commands, by program and subcommand, that two or more sessions share; probes are left out and a command
 *  repeated at once counts once, and a run inside a longer one with the same sessions goes. */
export function sequences(outlines: Outline[]): { steps: string[]; sessions: string[] }[] {
  const found = new Map<string, { steps: string[]; sessions: Set<string> }>();
  for (const o of outlines) {
    const keys = o.commands.map((c) => program(c.text)).filter((k) => k && !PROBES.has(k.split(' ')[0]));
    const own = keys.filter((k, i) => k !== keys[i - 1]);
    for (let n = 3; n <= 5; n++) {
      for (let i = 0; i + n <= own.length; i++) {
        const steps = own.slice(i, i + n);
        const id = steps.join('\n');
        const had = found.get(id) ?? { steps, sessions: new Set<string>() };
        had.sessions.add(o.session);
        found.set(id, had);
      }
    }
  }
  const shared = [...found.values()].filter((s) => s.sessions.size >= 2);
  const inside = (a: string[], b: string[]) => b.length > a.length && b.some((_, i) => a.every((x, j) => b[i + j] === x));
  return shared.filter((s) => !shared.some((t) => t.sessions.size === s.sessions.size && inside(s.steps, t.steps)))
    .sort((a, b) => b.sessions.size - a.sessions.size || b.steps.length - a.steps.length || a.steps.join().localeCompare(b.steps.join()))
    .map((s) => ({ steps: s.steps, sessions: [...s.sessions].sort() }));
}

const lower = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, KEY);
const base = (repo?: string): string => (repo ? path.basename(repo) : 'no repo');
const home = os.homedir();
const tilde = (p: string): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

// one occurrence: `id` is what n counts once, `hit` what the rate counts once
type Occ = { id: string; hit: string; session?: string; pr?: string; ev: Omit<Evidence, 'id'> };
type Acc = { kind: GroupKind; key: string; unit: Group['unit']; of: number; occs: Occ[]; more?: Partial<Group> };

/** The groups code builds from what the sessions, cards and labels show, with every count and denominator, and the totals
 *  the report prints beside them. */
export function aggregate(i: AggregateInput): Aggregate {
  const scope = i.outlines.length;
  const bySession = new Map(i.outlines.map((o) => [o.session, o]));
  const accs = new Map<string, Acc>();
  const add = (kind: GroupKind, key: string, unit: Group['unit'], of: number, occ: Occ, more?: Partial<Group>) => {
    const id = `${kind}\n${key}`;
    const a = accs.get(id) ?? { kind, key, unit, of, occs: [], more };
    a.occs.push(occ);
    accs.set(id, a);
  };
  const turnEv = (o: Outline, at: string, text: string): Omit<Evidence, 'id'> => ({
    agent: o.agent, session: o.session, at, when: o.turns.find((t) => t.id === at)?.at ?? o.start, repo: i.repoOf.get(o.session), text: ellipsis(text, TEXT),
  });
  const turnText = (o: Outline, at: string) => o.turns.find((t) => t.id === at)?.text ?? '';

  // errors, from every session in scope, carded or not
  const ran = new Map<string, Set<string>>();
  for (const o of i.outlines) for (const c of o.commands) ran.set(program(c.text), (ran.get(program(c.text)) ?? new Set()).add(o.session));
  const spans = new Map<string, Map<string, [number, number][]>>();
  for (const o of i.outlines) {
    o.commands.forEach((c, k) => {
      if (!c.failed) return;
      const s = signature(c);
      const key = `${s.key} × ${s.signature}`;
      const next = o.commands.slice(k + 1).find((x) => !x.failed && program(x.text) === s.key);
      if (next) {
        const per = spans.get(key) ?? new Map<string, [number, number][]>();
        per.set(o.session, [...(per.get(o.session) ?? []), [c.at, next.at]]);
        spans.set(key, per);
      }
      add('error', key, 'sessions', ran.get(s.key)?.size ?? 1, {
        id: `${o.session}#${c.id}`, hit: o.session, session: o.session,
        ev: turnEv(o, c.id, `✗(${c.exit ?? '?'}) ${c.text}${c.out ? ` → "${c.out.split('\n').find((l) => l.trim()) ?? ''}"` : ''}`),
      }, { signature: s.signature, ...(s.expected && { expected: true as const }) });
    });
  }

  // what the cards show
  const runsOf = new Map<string, number>();
  for (const o of i.outlines) if (i.cards.has(o.session)) for (const r of o.skills) runsOf.set(r.name, (runsOf.get(r.name) ?? 0) + 1);
  const went = new Map<string, Record<string, number>>();
  const frictionSpans = new Map<string, Map<string, [number, number][]>>();
  const wins: Omit<Evidence, 'id'>[] = [];
  for (const [session, card] of i.cards) {
    const o = bySession.get(session);
    if (!o) continue;
    const at = new Map(o.turns.map((t) => [t.id, t.at]));
    const sessionOcc = (ev: Omit<Evidence, 'id'>): Occ => ({ id: session, hit: session, session, ev });
    for (const c of card.corrections) {
      const file = RULE_FILE.exec(`${c.quote} ${c.what}`)?.[1];
      add('correction', file ? `${c.about} · ${file}` : c.about, 'sessions', scope, sessionOcc(turnEv(o, c.at, `"${c.quote}" — ${c.what}`)));
    }
    for (const r of card.rules) add('retyped-rule', lower(r.quote), 'sessions', scope, sessionOcc(turnEv(o, r.at, `"${r.quote}"`)));
    for (const a of card.asks) add('ask', lower(a.intent), 'sessions', scope, sessionOcc(turnEv(o, a.at, `${a.intent} — "${ellipsis(turnText(o, a.at), 200)}"`)));
    for (const f of card.friction) {
      const key = `${f.kind} × ${base(i.repoOf.get(session))}`;
      const per = frictionSpans.get(key) ?? new Map<string, [number, number][]>();
      per.set(session, [...(per.get(session) ?? []), [at.get(f.from) ?? o.start, at.get(f.to) ?? o.start]]);
      frictionSpans.set(key, per);
      add('friction', key, 'sessions', scope, sessionOcc(turnEv(o, f.from, `${f.kind}: ${f.what}`)));
    }
    for (const s of card.skills) {
      const counts = went.get(s.name) ?? {};
      counts[s.went] = (counts[s.went] ?? 0) + 1;
      went.set(s.name, counts);
      if (s.went === 'no-issue' || s.went === 'unclear') continue;
      const id = `${session}#${s.at}`;
      add('skill-outcome', `${s.name} × ${s.went}`, 'runs', runsOf.get(s.name) ?? 0, { id, hit: id, session, ev: turnEv(o, s.at, `${s.name} ${s.went}: ${s.what}`) });
    }
    for (const w of card.wins) wins.push(turnEv(o, w.at, `"${w.quote}"`));
  }

  // review misses, over the PRs each review skill was joined to
  const reviewed = new Map<string, Set<string>>();
  for (const r of i.reviews) reviewed.set(r.skill, (reviewed.get(r.skill) ?? new Set()).add(r.pr));
  const beside = new Map<string, { later: number; unknown: number }>();
  for (const l of i.labelled) {
    const key = `${l.item.review.skill} × ${l.label.theme}`;
    const b = beside.get(key) ?? { later: 0, unknown: 0 };
    b.later++;
    if (l.class === 'unknown') b.unknown++;
    beside.set(key, b);
  }
  for (const l of i.labelled.filter((x) => x.class === 'confirmed')) {
    const o = bySession.get(l.item.review.session);
    const key = `${l.item.review.skill} × ${l.label.theme}`;
    add('review-miss', key, 'prs', reviewed.get(l.item.review.skill)?.size ?? 1, {
      id: `${l.item.pr}#${l.item.id}`, hit: l.item.pr, session: l.item.review.session, pr: l.item.pr,
      ev: {
        agent: o?.agent, session: l.item.review.session, at: l.item.review.run, pr: l.item.pr, comment: l.item.id, when: l.item.comment.at, repo: i.repoOf.get(l.item.review.session),
        text: ellipsis(`${l.item.comment.author}${l.item.comment.path ? ` on ${l.item.comment.path}` : ''}: ${l.item.comment.body}`, TEXT),
      },
    }, { beside: beside.get(key) });
  }
  const severity = new Map<string, number[]>();
  for (const l of i.labelled.filter((x) => x.class === 'confirmed')) {
    const key = `${l.item.review.skill} × ${l.label.theme}`;
    severity.set(key, [...(severity.get(key) ?? []), SEVERITY[l.label.severity]]);
  }

  for (const s of sequences(i.outlines)) {
    for (const session of s.sessions) {
      const o = bySession.get(session)!;
      const first = o.commands.find((c) => program(c.text) === s.steps[0]);
      add('sequence', s.steps.join(' → '), 'sessions', scope, { id: session, hit: session, session, ev: turnEv(o, first?.id ?? o.turns[0]?.id ?? 'L1.0', s.steps.join(' → ')) }, { steps: s.steps.length });
    }
  }

  // groups in kind order, the most counted first, each with up to five examples from distinct sessions, newest first
  const evidence = new Map<string, Evidence>();
  const time = (session: string, ivs: [number, number][]) => activeMs(bySession.get(session)?.turns.map((t) => t.at) ?? [], ivs);
  const elapsed = (per?: Map<string, [number, number][]>) => (per ? [...per].reduce((n, [s, ivs]) => n + time(s, ivs), 0) : undefined);
  const groups = [...accs.values()].map((a) => {
    const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => x !== undefined))];
    const newest = [...a.occs].sort((x, y) => y.ev.when - x.ev.when);
    const firsts = newest.filter((o, k) => newest.findIndex((x) => x.session === o.session) === k);
    const picked = [...firsts, ...newest.filter((o) => !firsts.includes(o))].slice(0, EXAMPLES);
    const ms = a.kind === 'error' ? elapsed(spans.get(a.key)) ?? 0 : a.kind === 'friction' ? elapsed(frictionSpans.get(a.key)) : undefined;
    const sev = severity.get(a.key);
    return {
      a, picked,
      group: {
        id: '', kind: a.kind, key: a.key, n: uniq(a.occs.map((o) => o.id)).length, hit: uniq(a.occs.map((o) => o.hit)).length, of: a.of, unit: a.unit,
        occ: uniq(a.occs.map((o) => o.id)), hits: uniq(a.occs.map((o) => o.hit)), sessions: uniq(a.occs.map((o) => o.session)).sort(), prs: uniq(a.occs.map((o) => o.pr)).sort(),
        examples: [], last: Math.max(...a.occs.map((o) => o.ev.when)),
        ...a.more, ...(ms !== undefined && { elapsedMs: ms }), ...(sev && { impact: sev.reduce((x, y) => x + y, 0) / sev.length }),
      } as Group,
    };
  }).sort((x, y) => GroupKind.options.indexOf(x.group.kind) - GroupKind.options.indexOf(y.group.kind) || y.group.n - x.group.n || x.group.key.localeCompare(y.group.key));
  groups.forEach(({ group, picked }, k) => {
    group.id = `g${k + 1}`;
    group.examples = picked.map((o) => {
      const id = `e${evidence.size + 1}`;
      evidence.set(id, { id, ...o.ev });
      return id;
    });
  });

  const skills = [...runsOf].map(([skill, runs]) => ({ skill, runs, went: went.get(skill) ?? {} })).sort((a, b) => b.runs - a.runs || a.skill.localeCompare(b.skill));
  const works = skills.flatMap((s) => {
    const clean = s.went['no-issue'] ?? 0;
    return s.runs >= WORKS_RUNS && clean / s.runs >= WORKS_SHARE ? [{ skill: s.skill, clean, runs: s.runs }] : [];
  });

  const mixed = new Map<string, { repo: string; kind: string; sessions: number }>();
  for (const [session, card] of i.cards) {
    const repo = base(i.repoOf.get(session));
    const m = mixed.get(`${repo}\n${card.kind}`) ?? { repo, kind: card.kind, sessions: 0 };
    m.sessions++;
    mixed.set(`${repo}\n${card.kind}`, m);
  }

  const themes = new Map<string, ReviewTotals['themes'][number]>();
  for (const l of i.labelled) {
    const t = themes.get(`${l.label.theme}\n${l.label.severity}`) ?? { theme: l.label.theme, severity: l.label.severity, later: 0, confirmed: 0, unknown: 0 };
    t.later++;
    if (l.class === 'confirmed') t.confirmed++;
    if (l.class === 'unknown') t.unknown++;
    themes.set(`${l.label.theme}\n${l.label.severity}`, t);
  }
  const confirmed = i.labelled.filter((l) => l.class === 'confirmed');

  const sources = new Map<string, string[]>();
  for (const name of i.unused) {
    const t = i.targets.find((x) => x.kind === 'skill' && x.name === name);
    const source = name.includes(':') ? name.slice(0, name.indexOf(':')) : t ? tilde(path.dirname(path.dirname(t.path))) : 'unknown';
    sources.set(source, [...(sources.get(source) ?? []), name]);
  }

  return {
    groups: groups.map((g) => g.group), evidence, works, skills,
    wins: wins.sort((a, b) => b.when - a.when).slice(0, WINS).map((w, k) => ({ id: `w${k + 1}`, ...w })),
    mix: [...mixed.values()].sort((a, b) => b.sessions - a.sessions || a.repo.localeCompare(b.repo)),
    activeMs: i.outlines.reduce((n, o) => n + activeMs(o.turns.map((t) => t.at)), 0),
    reviews: {
      prs: new Set(i.reviews.map((r) => r.pr)).size, later: i.labelled.length, confirmed: confirmed.length,
      unknown: i.labelled.filter((l) => l.class === 'unknown').length, missPrs: new Set(confirmed.map((l) => l.item.pr)).size,
      themes: [...themes.values()].sort((a, b) => a.theme.localeCompare(b.theme) || a.severity.localeCompare(b.severity)),
    },
    unused: [...sources].map(([source, skills]) => ({ source, skills: skills.sort() })).sort((a, b) => b.skills.length - a.skills.length || a.source.localeCompare(b.source)),
  };
}
