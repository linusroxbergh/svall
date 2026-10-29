import os from 'node:os';
import type { Finding, RetroReport } from '@svall/protocol';
import { day } from './synthesis.js';

const SHOWN = 5, WORKS = 4, LINE = 160, UNUSED = 15;
const LANDS: Record<NonNullable<Finding['target']>['class'], string> = {
  repo: 'a robot opens a PR', local: 'applied on your OK', 'agent-settings': 'a proposal: settings are yours to change',
  synced: 'a proposal: a local edit would be overwritten at the next sync', svall: "a proposal: Svall's own files are rewritten on start",
};
const WENT = ['no-issue', 'corrected', 'redone', 'abandoned', 'wrong-trigger', 'unclear'];

const home = os.homedir();
export const short = (p: string): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
// what a model wrote keeps no control bytes but newlines and tabs, so it can't move the cursor, recolour or retitle the
// terminal, and a line of it stays one line
export const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
export const flat = (s: string): string => clean(s).replace(/\s+/g, ' ').trim();
// a fence longer than any run of backticks in the text, which so cannot close it
export const fenced = (text: string, by = '', lang = ''): string => {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return [`${by}${fence}${lang}`, ...clean(text).split('\n').map((l) => `${by}${l}`), `${by}${fence}`].join('\n');
};
export const tokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const hours = (ms: number): string => `${Math.round(ms / 3_600_000)}h`;
const minutes = (ms: number): string => (ms >= 3_600_000 ? `~${hours(ms)}` : ms >= 60_000 ? `~${Math.round(ms / 60_000)}m` : '–');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n = LINE): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cell = (s: string | number): string => flat(String(s)).replace(/\|/g, '\\|');
const table = (head: string[], rows: (string | number)[][]): string[] => (rows.length
  ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)] : ['None.']);

/** A span as `Oct 22–29`, or `Sep 28–Oct 5` across a month. */
function spanText(s: RetroReport['span']): string {
  const [a, b] = [day(s.from), day(s.to)];
  return a.split(' ')[0] === b.split(' ')[0] ? `${a}–${b.split(' ')[1]}` : `${a}–${b}`;
}

const prName = (url: string): string => {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url;
};

// the tokens each model spent, a model in two roles once
function spent(r: RetroReport): string {
  const by = new Map<string, number>();
  const add = (model: string, n: number) => { if (n) by.set(model, (by.get(model) ?? 0) + n); };
  add(r.preset.read, r.usage.byStage.cards + r.usage.byStage.labels);
  add(r.preset.judge, r.usage.byStage.synthesis);
  add(r.preset.verify, r.usage.byStage.verify);
  return by.size ? `${[...by].map(([m, n]) => `${tokens(n)} ${m}`).join(' + ')} tokens` : 'no tokens';
}

function reviewLine(v: RetroReport['reviews']): string {
  const themes = new Map<string, number>();
  for (const t of v.themes) themes.set(t.theme, (themes.get(t.theme) ?? 0) + t.confirmed);
  const top = [...themes].sort((a, b) => b[1] - a[1])[0];
  const misses = v.confirmed
    ? `${plural(v.confirmed, 'confirmed miss', 'confirmed misses')} in ${v.missPrs} of ${plural(v.prs, 'reviewed PR')}${top?.[1] ? `, most ${top[0]}` : ''}`
    : `no confirmed misses in ${plural(v.prs, 'reviewed PR')}`;
  return `Reviews: ${misses} · ${plural(v.later, 'later comment')}${v.unknown ? `, ${v.unknown} unknown` : ''}`;
}

function readLine(r: RetroReport): string {
  const all = r.coverage.sessions.length;
  const read = r.coverage.sessions.filter((s) => s.status !== 'failed').length;
  return `${read === all ? `All ${plural(all, 'session')} read` : `${read} of ${plural(all, 'session')} read (${all - read} in the report's coverage)`} · ${spent(r)}`;
}

function moreLine(r: RetroReport): string | undefined {
  const parts = [
    r.findings.length > SHOWN ? `${r.findings.length - SHOWN} more ${r.findings.length - SHOWN === 1 ? 'finding' : 'findings'}` : '',
    r.singletons.length ? `${r.singletons.length} seen once` : '', r.emerging.length ? `${r.emerging.length} emerging` : '',
  ].filter(Boolean);
  const plugins = r.housekeeping.sources.filter((s) => !s.source.includes('/'));
  const unused = r.housekeeping.unused
    ? `${plural(r.housekeeping.unused, 'installed skill')} never ran${plugins.length ? ` (${plural(plugins.length, 'plugin')} hold ${plugins.reduce((n, s) => n + s.skills.length, 0)})` : ''}`
    : '';
  const line = [parts.length ? `${parts.join(', ')}, in the report` : '', unused].filter(Boolean).join(' · ');
  return line || undefined;
}

/** The chat's summary: at most 25 lines, the top five findings, no session ids or line numbers. */
export function summary(r: RetroReport, reportPath: string): string {
  const error = r.errors.find((e) => !e.expected);
  const lines = [
    `Retro · ${spanText(r.span)} · ${plural(r.overview.sessions, 'session')} in ${plural(r.overview.repos, 'repo')} · report: ${short(reportPath)}`,
    '',
    clip(`The span: ${flat(r.overview.text).replace(/\.$/, '') || 'no sessions'} · ${hours(r.overview.activeMs)} active`),
    ...(r.reviews.prs ? [reviewLine(r.reviews)] : []),
    ...(error ? [clip(`Errors: ${error.key}, ${plural(error.failures, 'failure')} in ${plural(error.sessions, 'session')}: ${flat(error.signature)}`)] : []),
    ...(r.works.skills.length || r.works.text
      ? ['', 'Ran without a correction', `  ${r.works.skills.length ? r.works.skills.slice(0, WORKS).map((w) => `${w.skill} ${w.clean} of ${w.runs} runs`).join(' · ') : clip(flat(r.works.text))}`]
      : []),
    '', 'Worth fixing',
    ...(r.findings.length
      ? r.findings.slice(0, SHOWN).flatMap((f, i) => [`  ${i + 1} ${f.value.badge.padEnd(4)}  ${clip(flat(f.title))}`, `          ${clip(`${flat(f.value.reason)} → ${flat(f.fix)} · ${f.effort}`)}`])
      : ['  Nothing recurs often enough to fix.']),
    '',
    ...[moreLine(r)].filter((l): l is string => !!l),
    readLine(r),
    'Reply "fix 1 3", "more 2", "dismiss 4 wrong"',
  ];
  return lines.join('\n');
}

const sourceText = (e: Finding['evidence'][number]): string => ('pr' in e.source ? `PR ${prName(e.source.pr)}` : e.source.session.slice(0, 8));
const where = (f: Finding): string => {
  const t = f.target;
  if (!t) return 'nowhere yet: a proposal to make by hand';
  return `${short(t.path)} — ${f.change.kind === 'diff' ? LANDS[t.class] : 'a proposal to make by hand'}`;
};
const measured = (f: Finding): string => (f.measure.keys.length
  ? `${f.measure.keys.map((k) => `${k.kind} "${flat(k.key)}"`).join(', ')}${f.measure.before ? `, now ${f.measure.before.count} of ${f.measure.before.of}` : ''}`
  : 'not automatically measurable');

function findingMd(f: Finding, n: number): string[] {
  const v = f.value;
  const rate = v.n && v.impact && v.confidence ? v.score / (v.n * v.impact * v.confidence) - 1 : 0;
  const verdict = [f.verdict.claim, f.verdict.change === 'ok' ? '' : f.verdict.change === 'edited' ? 'change edited by the verifier' : 'moved onto an existing target by the verifier', f.verdict.rule ?? '']
    .filter(Boolean).join('; ');
  return [
    `### ${n}. ${flat(f.title)}`, '',
    `**${v.badge}** · ${flat(v.reason)} · ${f.effort}`, '',
    `Why it matters: ${flat(f.problem)}`,
    `Value: score ${v.score} = ${v.n} × impact ${v.impact} × (1 + ${rate.toFixed(2)}) × confidence ${v.confidence}.`, '',
    'What was seen:',
    ...(f.evidence.length ? f.evidence.map((e) => `- ${day(e.when)} · ${e.repo ? e.repo.split('/').pop() : 'no repo'} · ${sourceText(e)} · "${flat(e.quote)}"`) : ['- counted by code only']),
    '', `The change (${f.change.kind}): ${flat(f.change.summary)}`, fenced(f.change.text, '', f.change.kind === 'diff' ? 'diff' : ''), '',
    `Where it lands: ${where(f)}`,
    `Verdict: ${verdict} — ${flat(f.verdict.reason)}`,
    `Measured next time by: ${measured(f)}`, '',
  ];
}

const brief = (f: Finding): string => `- ${flat(f.title)} — ${flat(f.value.reason)} · ${f.effort}`;

/** The full report, under the summary's numbers: each finding's why, evidence, change, landing, verdict and measure, then
 *  what the summary leaves out. */
export function reportMd(r: RetroReport, reportPath: string): string {
  const c = r.coverage;
  const by = (key: (s: RetroReport['coverage']['sessions'][number]) => string) => {
    const rows = new Map<string, number[]>();
    for (const s of c.sessions) {
      const row = rows.get(key(s)) ?? [0, 0, 0, 0, 0];
      row[0]++;
      row[{ carded: 1, cached: 2, failed: 3 }[s.status]]++;
      row[4] += s.clipped;
      rows.set(key(s), row);
    }
    return [...rows].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, ...v]);
  };
  const failed = c.sessions.filter((s) => s.status === 'failed');
  const expected = r.errors.filter((e) => e.expected);
  const u = r.usage.byStage;
  return [
    `# Retro · ${spanText(r.span)}`, '',
    '## Summary', '', fenced(summary(r, reportPath), '', 'text'), '',
    '## Findings', '',
    ...(r.findings.length ? r.findings.flatMap((f, i) => findingMd(f, i + 1)) : ['Nothing recurs often enough to fix.', '']),
    ...(r.previous.length ? ['## Fixed since the last retro', '', ...r.previous.map((f) => `- ${flat(f.title)}: ${f.measure.before ? `${f.measure.before.count} of ${f.measure.before.of}` : '–'} → ${f.measure.after ? `${f.measure.after.count} of ${f.measure.after.of}` : 'not measured yet'}`), ''] : []),
    '## Emerging and seen once', '',
    '### Emerging (two sessions)', '', ...(r.emerging.length ? r.emerging.map(brief) : ['None.']), '',
    '### Seen once', '', ...(r.singletons.length ? r.singletons.map(brief) : ['None.']), '',
    '## Dropped by the verifier', '', ...(r.dropped.length ? r.dropped.map((d) => `- ${flat(d.title)} — ${flat(d.reason)}`) : ['None.']), '',
    '## Errors', '',
    ...table(['Command', 'Failures', 'Sessions', 'Of sessions running it', 'Elapsed', 'Cause'], r.errors.filter((e) => !e.expected).map((e) => [e.key, e.failures, e.sessions, e.of, minutes(e.elapsedMs), e.signature])),
    ...(expected.length ? ['', `Expected probe exits, left out of the findings: ${expected.map((e) => `${e.key} ${e.failures}`).join(', ')}.`] : []), '',
    '## Skills', '',
    ...(r.works.text ? [flat(r.works.text), ''] : []),
    ...table(['Skill', 'Runs', ...WENT], r.skills.map((s) => [s.skill, s.runs, ...WENT.map((w) => s.went[w] ?? 0)])), '',
    '## Review feedback', '',
    ...(r.reviews.prs ? [reviewLine(r.reviews).replace(/^Reviews: /, ''), ''] : []),
    ...table(['Theme', 'Severity', 'Later feedback', 'Confirmed misses', 'Unknown'], r.reviews.themes.map((t) => [t.theme, t.severity, t.later, t.confirmed, t.unknown])), '',
    '## Repeated asks and sequences', '',
    ...table(['Kind', 'What', 'Sessions'], r.asks.map((a) => [a.kind, a.key, a.sessions])), '',
    '## Session mix and active time', '',
    `${flat(r.overview.text)} ${hours(r.overview.activeMs)} active over ${plural(r.overview.sessions, 'session')} in ${plural(r.overview.repos, 'repo')}.`, '',
    ...table(['Repo', 'Kind', 'Sessions'], r.overview.mix.map((m) => [m.repo, m.kind, m.sessions])), '',
    '## Unused skills', '',
    ...(r.housekeeping.sources.length ? r.housekeeping.sources.map((s) => `- ${short(s.source)} (${s.skills.length}): ${s.skills.slice(0, UNUSED).join(', ')}${s.skills.length > UNUSED ? `, and ${s.skills.length - UNUSED} more` : ''}`) : ['None.']), '',
    '## Coverage and tokens', '',
    ...table(['Agent', 'Sessions', 'Carded', 'Cached', 'Failed', 'Turns clipped'], by((s) => s.agent)), '',
    ...table(['Repo', 'Sessions', 'Carded', 'Cached', 'Failed', 'Turns clipped'], by((s) => (s.repo ? s.repo.split('/').pop()! : 'no repo'))), '',
    ...table(['Day', 'Sessions', 'Carded', 'Cached', 'Failed', 'Turns clipped'], by((s) => s.day)), '',
    ...(failed.length ? ['Not carded:', ...failed.map((s) => `- ${s.session.slice(0, 8)} (${s.agent}${s.repo ? `, ${s.repo.split('/').pop()}` : ''}, ${s.day}): ${flat(s.reason ?? 'failed')}`), ''] : []),
    `Cache: ${c.sessions.filter((s) => s.status === 'cached').length} of ${plural(c.sessions.length, 'session')} read from it. Card quality: ${Math.round(c.quality * 100)}% of items kept after the source checks.`,
    `Review joins: ${c.joins.joined} joined, ${c.joins.failed} with no PR, ${c.joins.ambiguous} naming several, ${c.joins.truncated} PRs with commits left unread.`,
    `Groups cut from the synthesis: ${c.cutGroups}. Candidates not verified: ${c.unverified}. Below the gate: ${c.belowGate}.`,
    `Tokens: cards ${tokens(u.cards)}, labels ${tokens(u.labels)}, synthesis ${tokens(u.synthesis)}, verify ${tokens(u.verify)}; ${tokens(r.usage.used)} of a ${tokens(r.usage.budget)} budget.`,
    '',
  ].join('\n');
}

/** Finding n's section of a report.md, or none past its findings. */
export function findingSection(md: string, n: number): string | undefined {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`### ${n}. `));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n').trimEnd();
}
