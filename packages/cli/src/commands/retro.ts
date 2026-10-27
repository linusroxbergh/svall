import os from 'node:os';
import path from 'node:path';
import { Command, Option } from 'commander';
import { AGENT_LABEL, FocusPick, RetroSpan, type Finding, type Range, type RetroPlan, type RetroReport, type RetroStatus } from '@svall/protocol';
import { patchFleetConfig, readFleetConfig } from '@svall/svalld/config';
import { expandHome, resolvePaths } from '@svall/svalld/paths';
import type { Client } from '../client.js';
import { printResult } from '../format.js';
import { withClient } from './fleet.js';

const POLL_MS = 3_000;
const FOCUS_LABEL: Record<FocusPick, string> = { 'skills-reviews': 'skills and reviews', 'new-skills': 'new skills', instructions: 'instructions', all: 'everything' };
const LANDS: Record<NonNullable<Finding['target']>['class'], string> = {
  repo: 'a robot opens a PR', local: 'applied on your OK', 'agent-settings': 'proposal only', synced: 'proposal only; a local edit would be overwritten', svall: 'proposal only',
};
const ENDED = new Set<RetroStatus['stage']>(['done', 'failed', 'interrupted']);

const home = os.homedir();
const short = (p: string): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
const tokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const tokenRange = (r: Range): string => {
  const [a, b] = [tokens(r.min), tokens(r.max)];
  return a.slice(-1) === b.slice(-1) ? `${a.slice(0, -1)}–${b} tokens` : `${a}–${b} tokens`;
};
const usd = (r: Range): string => `~$${r.min.toFixed(1)}–${r.max.toFixed(1)}`;
const collect = (v: string, all: string[] = []): string[] => [...all, v];
const collectPath = (v: string, all: string[] = []): string[] => [...all, path.resolve(expandHome(v))];
// the unrecorded repos the plan lists by name; the rest are counted, and --json lists them all
const SHOWN = 8;
const indent = (text: string, by: string): string => text.split('\n').map((l) => `${by}${l}`).join('\n');
const source = (s: Finding['evidence'][number]['source']): string => ('pr' in s ? s.pr : `${s.agent} ${s.session} line ${s.line}`);
const rate = (r: { count: number; of: number } | null): string => (r ? `${r.count} of ${r.of}` : '–');

const BILLING: Record<RetroPlan['billing'], string> = {
  'api-key': 'API key: this is billed as money',
  subscription: "subscription: tokens count toward your plan's limits",
  provider: 'billed by the provider your OpenCode model runs on',
};

/** A plan as the crew shows it before asking: what is read, what is left out, and each preset's tokens and cost. */
export function formatPlan(p: RetroPlan): string {
  const c = p.counts;
  const lines = [
    `plan ${p.id} · ${p.span.label} · ${FOCUS_LABEL[p.focus]}`,
    `scope: ${c.inScope} in scope, ${c.excluded} excluded, ${c.otherFleets} in other fleets, ${c.remote} robots on another machine`,
  ];
  if (c.unrecorded.length) {
    const groups = c.unrecorded.slice(0, SHOWN).map((u) => `${short(u.repo)} ${u.count}${u.picked ? ' (picked)' : ''}`);
    const rest = c.unrecorded.slice(SHOWN);
    if (rest.length) groups.push(`${rest.length} more with ${rest.reduce((n, u) => n + u.count, 0)}`);
    lines.push(`not recorded by a fleet (read only when picked): ${groups.join(', ')}`);
  }
  const missing = Object.entries(c.missing).filter(([, n]) => n > 0);
  if (missing.length) lines.push(`missing: ${missing.map(([field, n]) => `${n} sessions without ${field}`).join(', ')}`);
  lines.push(`reviews: ${p.reviews === 'gh' ? 'from gh' : 'skipped: gh is not installed or signed in'}`);
  lines.push(`batches: ${p.batches.length}, about ${tokens(p.batches.reduce((n, b) => n + b.tokens, 0))} tokens of excerpts`);
  for (const t of p.thin) lines.push(`too little to judge: ${t}`);
  lines.push(`${AGENT_LABEL[p.agent]}, ${BILLING[p.billing]}`);
  const width = Math.max(...p.presets.map((x) => x.label.length));
  for (const x of p.presets) {
    const cost = x.cost && p.billing !== 'subscription' ? `  ${usd(x.cost)}` : '';
    lines.push(`  ${x.name.padEnd(10)}${x.label.padEnd(width)}  ${tokenRange(x.tokens)}${cost}`);
  }
  if (p.billing !== 'subscription') lines.push(`prices checked ${p.pricesChecked}`);
  return lines.join('\n');
}

function formatFinding(f: Finding, n: number): string {
  const t = f.target;
  const lines = [`${n}. ${f.title}`, `   ${f.claim}`, `   Change: ${f.change.summary}`];
  if (t) lines.push(`   Lands in: ${short(t.path)} (${LANDS[t.class]}${f.change.kind === 'diff' ? ', diff below' : ''})`);
  for (const e of f.evidence) lines.push(`   ${source(e.source)}:`, '   ```', indent(e.quote, '   '), '   ```');
  if (f.change.text) lines.push(indent(f.change.text, '      '));
  return lines.join('\n');
}

/** A run's findings as printed, numbered for the user's answer: the last run's fixes and how they measured since come first. */
export function formatFindings(r: RetroReport): string {
  const out: string[] = [];
  if (r.previous.length) {
    out.push('Fixed since the last retro:', ...r.previous.map((f) => `  ${f.measure.name}: ${rate(f.measure.before)} → ${rate(f.measure.after)}`), '');
  }
  out.push(r.findings.length ? r.findings.map((f, i) => formatFinding(f, i + 1)).join('\n\n') : 'No finding recurs often enough to report.');
  if (r.mechanical.length) out.push('', 'Also found:', ...r.mechanical.map((m) => `  ${m}`));
  if (r.thin.length) out.push('', 'Too little to judge:', ...r.thin.map((t) => `  ${t}`));
  if (r.skipped.length) out.push('', 'Read:', ...r.skipped.map((s) => `  ${s}`));
  out.push('', `used ${tokens(r.usage.used)} of ${tokens(r.usage.budget)} tokens`);
  return out.join('\n');
}

const statusLine = (s: RetroStatus): string =>
  `${s.run} ${s.stage}${s.stage === 'reading' ? ` ${s.done}/${s.total}` : ''}${s.error ? `: ${s.error}` : ''}`;

export function retroCommands(connect: () => Promise<Client>, json: () => boolean, fleetHome: () => string): Command {
  const cmd = new Command('retro').description('read what the agents did and propose changes to skills, reviews and instructions');

  cmd.command('plan').description('read the stores and print the scope, the batches and each preset\'s tokens and cost; sends nothing to a model')
    .addOption(new Option('--span <span>', 'since the last retro, or the last 7 or 30 days').choices(RetroSpan.options).default('last'))
    .addOption(new Option('--focus <focus>', 'what to look for').choices(FocusPick.options).default('skills-reviews'))
    .option('--exclude-repo <path>', 'leave out a repo (saved)', collectPath)
    .option('--exclude-island <name>', 'leave out an island by name or id (saved)', collect)
    .option('--pick <repo>', 'read the sessions no fleet recorded in this repo (saved)', collectPath)
    .action(async (o: { span: RetroSpan; focus: FocusPick; excludeRepo?: string[]; excludeIsland?: string[]; pick?: string[] }) => {
      const exclude = o.excludeRepo || o.excludeIsland ? { repos: o.excludeRepo, islands: o.excludeIsland } : undefined;
      const plan = await withClient(connect, (c) => c.call('retro.plan', { span: o.span, focus: o.focus, exclude, unrecorded: o.pick }));
      printResult(plan, json(), () => formatPlan(plan));
    });

  cmd.command('run <plan>').description('read the plan\'s batches with a preset, stopping at the budget; svalld carries on if this exits')
    .option('--preset <name>', 'the preset to read and judge with', 'balanced')
    .option('--budget <tokens>', 'the most tokens the run may spend (default: the preset\'s upper estimate)')
    .action(async (planId: string, o: { preset: string; budget?: string }) => {
      const budget = o.budget === undefined ? undefined : Number(o.budget);
      if (budget !== undefined && !(Number.isInteger(budget) && budget > 0)) throw new Error(`bad --budget "${o.budget}", expected a whole number of tokens`);
      const r = await withClient(connect, (c) => c.call('retro.run', { plan: planId, preset: o.preset, budget, robot: process.env.SVALL_ROBOT_ID }));
      printResult(r, json(), () => `retro ${r.run} started; svall retro wait follows it`);
    });

  cmd.command('wait [run]').description('follow a run until it ends; exits 1 when it failed or was interrupted')
    .action(async (run?: string) => {
      const last = await withClient(connect, async (c) => {
        let said = '';
        for (;;) {
          const s = await c.call('retro.status', { run });
          const line = statusLine(s);
          if (line !== said && !json()) process.stdout.write(`${line}\n`);
          said = line;
          if (ENDED.has(s.stage)) return s;
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      });
      if (json()) printResult(last, true);
      if (last.stage !== 'done') process.exitCode = 1;
    });

  cmd.command('status [run]').description('the stage of the newest run, or of the one named')
    .action(async (run?: string) => {
      const s = await withClient(connect, (c) => c.call('retro.status', { run }));
      printResult(s, json(), () => statusLine(s));
    });

  cmd.command('findings [run]').description('print a run\'s findings, numbered, each with its evidence and its change')
    .action(async (run?: string) => {
      const r = await withClient(connect, (c) => c.call('retro.findings', { run }));
      printResult(r, json(), () => formatFindings(r));
    });

  cmd.command('mark <action> <findings...>').description('fix, dismiss or later findings by their number in the last findings, or by id')
    .addOption(new Option('--reason <reason>', 'why a dismissed finding is dismissed').choices(['wrong', 'not-worth-it']))
    .action(async (action: string, refs: string[], o: { reason?: 'wrong' | 'not-worth-it' }) => {
      if (action !== 'fix' && action !== 'dismiss' && action !== 'later') throw new Error(`bad action "${action}", expected fix, dismiss or later`);
      if (action === 'dismiss' && !o.reason) throw new Error('say whether it was wrong or not worth it: --reason wrong|not-worth-it');
      const r = await withClient(connect, async (c) => {
        const ids = await resolveIds(c, refs);
        return c.call('retro.mark', { marks: ids.map((id) => ({ id, action, ...(o.reason && { reason: o.reason }) })) });
      });
      printResult(r, json(), () => r.results.map((x) => {
        if (x.outcome === 'robot') return `${x.id}: robot ${x.robot} opens a PR for ${short(x.path ?? '')}`;
        if (x.outcome === 'apply') return `${x.id}: show the user this diff for ${short(x.path ?? '')}; on their OK, svall retro apply ${x.id}\n${indent(x.diff ?? '', '   ')}`;
        if (x.outcome === 'proposal') return `${x.id}: a proposal; make the change by hand${x.path ? ` in ${short(x.path)}` : ''}\n${indent(x.diff ?? '', '   ')}`;
        return `${x.id}: ${x.outcome}`;
      }).join('\n'));
    });

  cmd.command('apply <finding>').description('apply a finding\'s diff to its file outside git, after the user said yes; keeps a backup')
    .action(async (ref: string) => {
      const r = await withClient(connect, async (c) => c.call('retro.apply', { id: (await resolveIds(c, [ref]))[0] }));
      printResult(r, json(), () => `applied to ${short(r.path)}; the file as it was is at ${short(r.backup)}`);
    });

  cmd.command('config').description('show or change what the retro leaves out and the models it uses (fleet.json retro)')
    .option('--exclude-repo <path>', 'leave out a repo', collectPath)
    .option('--exclude-island <name>', 'leave out an island', collect)
    .option('--include-repo <path>', 'stop leaving out a repo', collectPath)
    .option('--include-island <name>', 'stop leaving out an island', collect)
    .addOption(new Option('--agent <cli>', 'the CLI --read-model and --judge-model are for').choices(['claude', 'codex', 'opencode']).default('claude'))
    .option('--read-model <model>', 'the model that reads the batches')
    .option('--judge-model <model>', 'the model that judges the notes')
    .option('--review-skills <names>', 'skills to read as reviews, comma-separated, beside those named for one')
    .action((o: { excludeRepo?: string[]; excludeIsland?: string[]; includeRepo?: string[]; includeIsland?: string[]; agent: 'claude' | 'codex' | 'opencode'; readModel?: string; judgeModel?: string; reviewSkills?: string }) => {
      const file = resolvePaths(fleetHome()).fleetConfig;
      const retro = readFleetConfig({ fleetConfig: file }).retro;
      const changed = o.excludeRepo || o.excludeIsland || o.includeRepo || o.includeIsland || o.readModel || o.judgeModel || o.reviewSkills !== undefined;
      if (changed) {
        const edit = (list: string[], add?: string[], drop?: string[]) => [...new Set([...list, ...(add ?? [])])].filter((x) => !drop?.includes(x));
        retro.exclude = { repos: edit(retro.exclude.repos, o.excludeRepo, o.includeRepo), islands: edit(retro.exclude.islands, o.excludeIsland, o.includeIsland) };
        if (o.readModel || o.judgeModel) {
          const had = retro.model?.[o.agent] ?? {};
          retro.model = { ...retro.model, [o.agent]: { ...had, ...(o.readModel && { read: o.readModel }), ...(o.judgeModel && { judge: o.judgeModel }) } };
        }
        if (o.reviewSkills !== undefined) retro.reviewSkills = o.reviewSkills.split(',').map((s) => s.trim()).filter(Boolean);
        patchFleetConfig(file, { retro });
      }
      printResult(retro, json(), () => JSON.stringify(retro, null, 2));
    });

  return cmd;
}

// a number is the finding's place in the newest findings; anything else is an id
async function resolveIds(c: Client, refs: string[]): Promise<string[]> {
  if (!refs.some((r) => /^\d+$/.test(r))) return refs;
  const { findings } = await c.call('retro.findings', {});
  return refs.map((r) => {
    if (!/^\d+$/.test(r)) return r;
    const f = findings[Number(r) - 1];
    if (!f) throw new Error(`no finding ${r}: the last findings have ${findings.length}`);
    return f.id;
  });
}
