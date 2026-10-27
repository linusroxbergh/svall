import type { AgentKind, Focus } from '@svall/protocol';
import { GH_BODY, type Outline, type SkillRun, type Turn } from './outline.js';
import type { PrComment } from './prs.js';
import type { Target } from './targets.js';

/** A cut of one session for a read, with a review run's PR thread; a higher `priority` is read first. */
export type Excerpt = {
  id: string; focus: Focus; priority: number; session?: { agent: AgentKind; session: string }; pr?: string;
  // the skill whose run it was cut from
  skill?: string;
  // `L<line> <ROLE>: <text>` per turn, then `PR <author>: <body>` per comment
  text: string;
};

// runs read per skill, first prompts read for triggers, failures before a command is listed, and the evidence a focus needs
const RUNS = 20, FIRST_PROMPTS = 200, FAILURES = 3, THIN_SESSIONS = 3, THIN_PRS = 2;
const REJECTED = '[rejected] ';

type Run = { s: Outline; r: SkillRun };
type Draft = { id: string; focus: Focus; priority: number; s: Outline; turns: Set<number>; skill?: string; pr?: string; comments?: PrComment[] };

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
// tier 2 for a review run or a run something followed, 1 another run or a rule's output, 0 prompts; then the newest first,
// as `at / 1e13` stays under 1 until 2286
const priority = (tier: number, at: number): number => tier + at / 1e13;
// the places in a session's turns that `keep` picks
const places = (s: Outline, keep: (t: Turn, i: number) => boolean): number[] => s.turns.flatMap((t, i) => (keep(t, i) ? [i] : []));
// a run's turns, from its call to the prompt that ended it
const runTurns = ({ s, r }: Run): number[] => {
  const end = s.prompts.find((p) => p.line > r.line)?.line ?? Infinity;
  return places(s, (t) => t.line >= r.line && t.line <= end);
};
// a skill's runs to read: those something followed first, then the newest
const first = <R extends Run>(runs: R[]): R[] => [...runs].sort((a, b) => Number(!a.r.next) - Number(!b.r.next) || b.r.at - a.r.at).slice(0, RUNS);

// a command by its program and subcommand, past a leading `cd … &&` and the variables set for it
function program(command: string): string {
  const words = command.replace(/^(?:\s*cd\s+\S+\s*(?:&&|;))+/, '').trim().split(/\s+/);
  while (/^[A-Za-z_]\w*=/.test(words[0] ?? '')) words.shift();
  const [name = '', sub] = words;
  return sub && /^[a-z][\w:-]*$/.test(sub) ? `${name} ${sub}` : name;
}

// hook errors, commands that keep failing and rejected tool calls, counted without a model
function mechanical(outlines: Outline[]): string[] {
  type Tally = Map<string, { n: number; sessions: Set<string> }>;
  const failed: Tally = new Map(), rejected: Tally = new Map();
  const tally = (m: Tally, key: string, session: string) => {
    const v = m.get(key) ?? { n: 0, sessions: new Set<string>() };
    v.n++;
    v.sessions.add(session);
    m.set(key, v);
  };
  for (const s of outlines) {
    for (const c of s.commands) if (c.failed) tally(failed, program(c.text), s.session);
    for (const t of s.turns) if (t.role === 'error' && t.text.startsWith(REJECTED)) tally(rejected, t.text.slice(REJECTED.length), s.session);
  }
  const listed = (m: Tally, did: string, min: number) => [...m].filter(([, v]) => v.n >= min).sort(([a, x], [b, y]) => y.n - x.n || a.localeCompare(b))
    .map(([k, v]) => `${k} ${did} ${count(v.n, 'time')} in ${count(v.sessions.size, 'session')}`);
  const hooks = outlines.filter((s) => s.hookErrors > 0);
  return [
    ...(hooks.length ? [`hook errors: ${hooks.reduce((n, s) => n + s.hookErrors, 0)} in ${count(hooks.length, 'session')}`] : []),
    ...listed(failed, 'failed', FAILURES), ...listed(rejected, 'rejected', 1),
  ];
}

/**
 * The excerpts each focus reads, cut from the outlines; `runs` counts every run of each skill before the cap,
 * `mechanical` what code finds alone and `thin` the focuses with too little evidence.
 */
export function select(o: {
  outlines: Outline[]; focus: Focus[]; targets: Target[]; skillsSeen: Set<string>;
  // whether gh is installed and signed in; `prOf` links a session to its PR and `prs` holds each PR's thread
  gh: boolean; prs: Map<string, PrComment[]>; prOf: Map<string, string>;
}): { excerpts: Excerpt[]; runs: Record<string, number>; mechanical: string[]; thin: string[] } {
  const want = new Set(o.focus);
  const drafts = new Map<string, Draft>();
  const seen = new Map(o.focus.map((f) => [f, new Set<string>()]));
  // excerpts that start on the same line are one, sent once with the turns of each
  const add = (focus: Focus, tier: number, s: Outline, line: number, at: number, turns: number[], more?: Pick<Draft, 'skill' | 'pr' | 'comments'>) => {
    if (!turns.length) return;
    seen.get(focus)?.add(s.session);
    const id = `${s.session}:${line}`;
    let d = drafts.get(id);
    if (!d) drafts.set(id, (d = { id, focus, priority: 0, s, turns: new Set() }));
    d.priority = Math.max(d.priority, priority(tier, at));
    for (const i of turns) d.turns.add(i);
    Object.assign(d, more);
  };

  const bySkill = new Map<string, Run[]>();
  for (const s of o.outlines) for (const r of s.skills) bySkill.set(r.name, [...(bySkill.get(r.name) ?? []), { s, r }]);

  let reviewRuns = 0;
  const linked: (Run & { url: string })[] = [];
  if (want.has('review-tweaks') && o.gh) {
    const reviews = new Set(o.targets.filter((t) => t.review).map((t) => t.name));
    for (const [skill, rs] of bySkill) {
      if (!reviews.has(skill)) continue;
      reviewRuns += rs.length;
      const withPr = rs.flatMap((x) => {
        const url = o.prOf.get(x.s.session);
        const thread = url === undefined ? undefined : o.prs.get(url);
        return url === undefined || !thread ? [] : [{ ...x, url, thread }];
      });
      linked.push(...withPr);
      for (const x of first(withPr)) add('review-tweaks', 2, x.s, x.r.line, x.r.at, runTurns(x), { skill, pr: x.url, comments: x.thread.filter((c) => c.at > x.r.at) });
    }
  }

  if (want.has('skill-tweaks')) {
    for (const [skill, rs] of bySkill) for (const x of first(rs)) add('skill-tweaks', x.r.next ? 2 : 1, x.s, x.r.line, x.r.at, runTurns(x), { skill });
  }

  if (want.has('skill-triggers')) {
    const firsts = o.outlines.flatMap((s) => (s.skills.length || !s.prompts[0] ? [] : [{ s, p: s.prompts[0] }]))
      .sort((a, b) => b.p.at - a.p.at).slice(0, FIRST_PROMPTS);
    for (const { s, p } of firsts) add('skill-triggers', 0, s, p.line, p.at, places(s, (t) => t.role === 'user' && t.line === p.line));
  }

  if (want.has('new-skills')) {
    for (const s of o.outlines) {
      const lines = new Set(s.prompts.map((p) => p.line));
      if (s.prompts[0]) add('new-skills', 0, s, s.prompts[0].line, s.end, places(s, (t) => t.role === 'user' && lines.has(t.line)));
    }
  }

  if (want.has('instructions')) {
    for (const s of o.outlines) {
      const last = places(s, (t) => t.role === 'agent').at(-1);
      const keep = places(s, (t, i) => i === last || (t.role === 'tool' && GH_BODY.test(t.text)));
      if (keep.length) add('instructions', 1, s, s.turns[keep[0]].line, s.end, keep);
    }
  }

  const excerpts = [...drafts.values()].map((d): Excerpt => ({
    id: d.id, focus: d.focus, priority: d.priority, session: { agent: d.s.agent, session: d.s.session },
    ...(d.skill && { skill: d.skill }), ...(d.pr && { pr: d.pr }),
    text: [
      ...d.s.turns.flatMap((t, i) => (d.turns.has(i) ? [`L${t.line} ${t.role.toUpperCase()}: ${t.text}`] : [])),
      ...(d.comments ?? []).map((c) => `PR ${c.author}${c.path ? ` on ${c.path}` : ''}: ${c.body}`),
    ].join('\n'),
  }));
  // installed skills no transcript on disk has run: a fact code reads, listed beside the findings with nothing for a model to judge
  const unused = want.has('skill-triggers') ? o.targets.filter((t) => t.kind === 'skill' && !o.skillsSeen.has(t.name)).map((t) => t.name) : [];

  const thin = o.focus.flatMap((f): string[] => {
    const label = f.replace('-', ' ');
    if (f !== 'review-tweaks') {
      const n = seen.get(f)?.size ?? 0;
      return n < THIN_SESSIONS ? [`${label}: ${count(n, 'session')} of evidence`] : [];
    }
    if (!o.gh) return [`${label} skipped: gh is not installed or signed in`];
    const without = reviewRuns - linked.length;
    return new Set(linked.map((x) => x.url)).size < THIN_PRS ? [`${label}: ${count(linked.length, 'review run')} with a linked PR${without ? `, ${without} without` : ''}`] : [];
  });

  const never = unused.length ? [`skills no transcript on disk has run, to keep or retire: ${unused.join(', ')}`] : [];
  return { excerpts, runs: Object.fromEntries([...bySkill].map(([k, rs]) => [k, rs.length])), mechanical: [...mechanical(o.outlines), ...never], thin };
}
