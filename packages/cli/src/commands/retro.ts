import path from 'node:path';
import { AGENT_LABEL, type Range, type RetroSpan, type RetroPlan, type RetroStatus } from '@svall/protocol';
import { patchFleetConfig, readFleetConfig } from '@svall/svalld/config';
import { resolvePaths } from '@svall/svalld/paths';
import { clean, fenced, flat, short, summary, tokens } from '@svall/svalld/retro/render';
import type { Client } from '../client.js';
import { printResult } from '../format.js';
import { withClient } from '../client.js';

const POLL_MS = 3_000;
const ENDED = new Set<RetroStatus['stage']>(['done', 'failed', 'interrupted']);

const usd = (r: Range): string => `~$${r.min.toFixed(1)}–${r.max.toFixed(1)}`;
// the unrecorded repos the plan lists by name; the rest are counted, and --json lists them all
const SHOWN = 8;

const BILLING: Record<RetroPlan['billing'], string> = {
  'api-key': 'API key: this is billed as money',
  subscription: "subscription: tokens count toward your plan's limits",
  provider: 'billed by the provider your OpenCode model runs on',
};

/** A plan as the crew shows it before asking: what is read, what is left out, what the cache holds, and each preset's
 *  tokens, typical and cap, and cost. */
export function formatPlan(p: RetroPlan): string {
  const c = p.counts;
  const w = p.work;
  const lines = [
    `plan ${p.id} · ${p.span.label}`,
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
  lines.push(`cards: ${w.sessions} sessions, ${w.cached} of ${w.chunks} chunks cached, ${w.calls} calls`);
  lines.push(`reviews: ${p.reviews === 'gh' ? `${w.prs} PRs from gh, ${w.comments} later comments to label` : 'skipped: gh is not installed or logged in'}`);
  lines.push(`${AGENT_LABEL[p.agent]}, ${BILLING[p.billing]}`);
  const width = Math.max(...p.presets.map((x) => x.label.length));
  for (const x of p.presets) {
    const cost = x.cost && p.billing !== 'subscription' ? `  ${usd(x.cost)}` : '';
    lines.push(`  ${x.name.padEnd(10)}${x.label.padEnd(width)}  typical ~${tokens(x.tokens.min)}, cap ${tokens(x.tokens.max)}${cost}`);
  }
  if (p.billing !== 'subscription') lines.push(`prices checked ${p.pricesChecked}`);
  return lines.join('\n');
}

const statusLine = (s: RetroStatus): string =>
  `${s.run} ${s.stage}${s.stage === 'reading' ? ` ${s.done}/${s.total}` : ''}${s.used ? ` · ${tokens(s.used)}` : ''}${s.error ? `: ${s.error}` : ''}`;

export function retroActions(connect: () => Promise<Client>, json: () => boolean, fleetHome: () => string) {
  return {
    plan: async (o: { span: RetroSpan; excludeRepo?: string[]; excludeIsland?: string[]; pick?: string[] }) => {
      const exclude = o.excludeRepo || o.excludeIsland ? { repos: o.excludeRepo, islands: o.excludeIsland } : undefined;
      const plan = await withClient(connect, (c) => c.call('retro.plan', { span: o.span, exclude, unrecorded: o.pick }));
      printResult(plan, json(), () => formatPlan(plan));
    },

    run: async (planId: string, o: { preset?: string; budget?: string }) => {
      const budget = o.budget === undefined ? undefined : Number(o.budget);
      if (budget !== undefined && !(Number.isInteger(budget) && budget > 0)) throw new Error(`bad --budget "${o.budget}", expected a whole number of tokens`);
      const r = await withClient(connect, (c) => c.call('retro.run', { plan: planId, preset: o.preset, budget, robot: process.env.SVALL_ROBOT_ID }));
      printResult(r, json(), () => `retro ${r.run} started; svall retro wait follows it`);
    },

    wait: async (run?: string) => {
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
    },

    status: async (run?: string) => {
      const s = await withClient(connect, (c) => c.call('retro.status', { run }));
      printResult(s, json(), () => statusLine(s));
    },

    findings: async (run?: string) => {
      const r = await withClient(connect, (c) => c.call('retro.findings', { run }));
      printResult(r, json(), () => summary(r, path.join(resolvePaths(fleetHome()).retro, 'runs', r.run, 'report.md')));
    },

    show: async (n: string, run?: string) => {
      if (!/^[1-9]\d*$/.test(n)) throw new Error(`bad finding "${n}", expected its number in the findings`);
      const r = await withClient(connect, (c) => c.call('retro.show', { n: Number(n), run }));
      printResult(r, json(), () => clean(r.text));
    },

    mark: async (action: string, refs: string[], o: { reason?: 'wrong' | 'not-worth-it' }) => {
      if (action !== 'fix' && action !== 'dismiss' && action !== 'later') throw new Error(`bad action "${action}", expected fix, dismiss or later`);
      if (action === 'dismiss' && !o.reason) throw new Error('say whether it was wrong or not worth it: --reason wrong|not-worth-it');
      const r = await withClient(connect, async (c) => {
        const ids = await resolveIds(c, refs);
        return c.call('retro.mark', { marks: ids.map((id) => ({ id, action, ...(o.reason && { reason: o.reason }) })) });
      });
      // one result per mark, in order, each named as the user named it; apply takes the id, which a newer run can't renumber
      printResult(r, json(), () => r.results.map((x, i) => {
        const at = flat(short(x.path ?? ''));
        const ref = refs[i] ?? x.id;
        if (x.outcome === 'robot') return `${ref}: robot ${x.robot} opens a PR for ${at}`;
        if (x.outcome === 'apply') return `${ref}: show the user this diff for ${at}; on their OK, svall retro apply ${x.id}\n${fenced(x.diff ?? '', '   ')}`;
        if (x.outcome === 'proposal') return `${ref}: a proposal; make the change by hand${x.path ? ` in ${at}` : ''}\n${fenced(x.diff ?? '', '   ')}`;
        if (x.outcome === 'fixed') return `${ref}: a robot already took this fix for ${at}`;
        return `${ref}: ${x.outcome}`;
      }).join('\n'));
    },

    apply: async (ref: string) => {
      const r = await withClient(connect, async (c) => c.call('retro.apply', { id: (await resolveIds(c, [ref]))[0] }));
      printResult(r, json(), () => `applied to ${short(r.path)}; the file as it was is at ${short(r.backup)}`);
    },

    config: (o: {
      excludeRepo?: string[]; excludeIsland?: string[]; includeRepo?: string[]; includeIsland?: string[]; agent: 'claude' | 'codex' | 'opencode';
      readModel?: string; judgeModel?: string; verifyModel?: string; reviewSkills?: string;
    }) => {
      const file = resolvePaths(fleetHome()).fleetConfig;
      const retro = readFleetConfig({ fleetConfig: file }).retro;
      const models = o.readModel || o.judgeModel || o.verifyModel;
      const changed = o.excludeRepo || o.excludeIsland || o.includeRepo || o.includeIsland || models || o.reviewSkills !== undefined;
      if (changed) {
        const edit = (list: string[], add?: string[], drop?: string[]) => [...new Set([...list, ...(add ?? [])])].filter((x) => !drop?.includes(x));
        retro.exclude = { repos: edit(retro.exclude.repos, o.excludeRepo, o.includeRepo), islands: edit(retro.exclude.islands, o.excludeIsland, o.includeIsland) };
        if (models) {
          const had = retro.model?.[o.agent] ?? {};
          retro.model = { ...retro.model, [o.agent]: { ...had, ...(o.readModel && { read: o.readModel }), ...(o.judgeModel && { judge: o.judgeModel }), ...(o.verifyModel && { verify: o.verifyModel }) } };
        }
        if (o.reviewSkills !== undefined) retro.reviewSkills = o.reviewSkills.split(',').map((s) => s.trim()).filter(Boolean);
        patchFleetConfig(file, { retro });
      }
      printResult(retro, json(), () => JSON.stringify(retro, null, 2));
    },
  };
}

// a number from 1 to how many the newest findings are is a finding's place in them; anything else is an id, all digits as some are
async function resolveIds(c: Client, refs: string[]): Promise<string[]> {
  if (!refs.some((r) => /^\d+$/.test(r))) return refs;
  const { findings } = await c.call('retro.findings', {});
  return refs.map((r) => (/^\d+$/.test(r) && Number(r) >= 1 && Number(r) <= findings.length ? findings[Number(r) - 1].id : r));
}
