import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import { FOCUS_OF, JudgeReply, NoteReply, type AgentKind, type Finding, type Note, type Preset, type RetroPlan, type RetroReport, type RetroStatus } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { NO_USAGE, type Call, type Runner } from '../scribe/run.js';
import { Budget, FAMILY, judgeTokens, RATIO, readTokens } from './budget.js';
import { dismissedCategories, findingId, measure, readLedger, recordFindings, writeLedger } from './ledger.js';
import { clip, type Outline, type Span } from './outline.js';
import type { PrComment } from './prs.js';
import { judgeInput, judgePrompt, readInput, readPrompt, wireSchema } from './prompts.js';
import { redact } from './redact.js';
import type { Excerpt } from './select.js';
import { fitTargets, targetText, type Target } from './targets.js';

export type RunInput = {
  plan: RetroPlan; preset: Preset; budget: number;
  // retro runners, tools off
  runner: (agent: AgentKind) => Runner;
  // runs/<plan id>, whose batches/<batch id>.json plan time wrote, each an Excerpt[]
  dir: string;
  ledgerFile: string;
  // the inventory as it is at run time
  targets: Target[];
  measure: { outlines: Outline[]; span: Span; prOf: Map<string, string>; comments: Map<string, PrComment[]> };
  // every run of each skill before select's cap
  runs: Record<string, number>;
  mechanical: string[]; thin: string[];
  // the last finished run's findings the ledger now marks fixed
  previous: Finding[];
  onStatus: (s: RetroStatus) => void; signal: AbortSignal; now?: () => number;
};

const READS = 3, NOTE_TOKENS = 100_000, TARGET_TOKENS = 40_000, FINDINGS = 7, QUOTE = 300, CLAIM = 600;
const NOTE_SCHEMA = wireSchema(NoteReply), JUDGE_SCHEMA = wireSchema(JudgeReply);

type Read = { excerpts: Excerpt[]; notes: Note[] } | { failed: string };

const said = (e: unknown): string => clip(String(e instanceof Error ? e.message : e).replace(/\s+/g, ' '), 300);
const sessionKey = (s: { agent: AgentKind; session: string }): string => `${s.agent}\n${s.session}`;

// one call whose answer must fit `reply`, retried once; OpenCode has no schema flag, so its prompt carries the schema,
// and its answer may wrap the JSON in prose or a fence
async function ask<T>(run: Runner, agent: AgentKind, system: string, prompt: string, call: Call, reply: z.ZodType<T>, budget: Budget, signal: AbortSignal): Promise<T> {
  const asked = agent === 'opencode' ? `${prompt}\n\nAnswer with JSON only, fitting this schema:\n${JSON.stringify(call.schema)}` : prompt;
  const once = async (): Promise<T> => {
    const { text, usage } = await run(system, asked, call, signal);
    budget.settle(0, usage);
    return reply.parse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
  };
  try { return await once(); } catch { signal.throwIfAborted(); return once(); }
}

// a note stands on a session or PR its own batch holds; a target outside the inventory is none
function keep(notes: Note[], excerpts: Excerpt[], inventory: Map<string, Target>): Note[] {
  const sessions = new Set(excerpts.flatMap((e) => (e.session ? [sessionKey(e.session)] : [])));
  const prs = new Set(excerpts.flatMap((e) => (e.pr ? [e.pr] : [])));
  return notes.filter((n) => ('pr' in n.source ? prs.has(n.source.pr) : sessions.has(sessionKey(n.source)))).map((n) => ({
    ...n, target: n.target !== null && inventory.has(n.target) ? n.target : null, claim: clip(redact(n.claim), CLAIM), quote: clip(redact(n.quote), QUOTE),
  }));
}

// the notes that fit in `chars`, the last dropped first
function cut(notes: Note[], chars: number): Note[] {
  const kept: Note[] = [];
  for (const n of notes) {
    chars -= JSON.stringify(n).length + 1;
    if (chars < 0) break;
    kept.push(n);
  }
  return kept;
}

// the inventory's target by its id, the path a draft would go to, or none
function targetOf(id: string | null, inventory: Map<string, Target>): Finding['target'] {
  const t = id === null ? undefined : inventory.get(id);
  if (t) return { id: t.id, path: t.path, realPath: t.realPath, class: t.class, hash: t.hash };
  if (!id || !/^~?\//.test(id)) return null;
  const p = id.startsWith('~/') ? path.join(os.homedir(), id.slice(2)) : id;
  return { path: p, realPath: p, class: 'local', hash: null };
}

/** Reads the plan's batches under the budget, judges the notes, and writes notes, findings, totals and the ledger; batches never outlive it. */
export async function runPlan(o: RunInput): Promise<RetroReport> {
  const { plan, preset, signal } = o;
  const now = o.now ?? Date.now;
  const total = plan.batches.length;
  let done = 0;
  const status = (stage: RetroStatus['stage'], error?: string) => o.onStatus({ run: plan.id, stage, done, total, ...(error && { error }) });
  const budget = new Budget(o.budget);
  const focus = FOCUS_OF[plan.focus];
  const inventory = new Map(o.targets.map((t) => [t.id, t]));
  try {
    // the judge's share is held first, so reads never eat it
    const judgeHold = judgeTokens(total, preset.judge.agent).max;
    if (!budget.reserve(judgeHold)) throw new Error(`a budget of ${o.budget} tokens won't cover the judge's ${Math.ceil(judgeHold)}`);
    status('reading');

    const reader = o.runner(preset.read.agent), system = readPrompt({ focus, targets: o.targets });
    const call: Call = { model: preset.read.model, effort: 'low', schema: NOTE_SCHEMA, timeoutMs: 300_000 };
    const reads: Read[] = [];
    let next = 0, stop = false;
    // the highest priority batch first; once one is refused, it and every later one go unread
    const worker = async () => {
      while (!stop && next < total) {
        const i = next++, b = plan.batches[i];
        const hold = readTokens(b.tokens, preset.read.agent).max;
        if (!budget.reserve(hold)) { stop = true; return; }
        try {
          const excerpts = JSON.parse(fs.readFileSync(path.join(o.dir, 'batches', `${b.id}.json`), 'utf8')) as Excerpt[];
          reads[i] = await ask(reader, preset.read.agent, system, readInput({ excerpts }), call, NoteReply, budget, signal).then(
            (r) => {
              const notes = keep(r.notes, excerpts, inventory);
              writeDurable(path.join(o.dir, 'notes', `${b.id}.json`), notes);
              return { excerpts, notes };
            },
            (e: unknown) => { signal.throwIfAborted(); return { failed: `${b.id} not read: ${said(e)}` }; },
          );
        } finally {
          budget.settle(hold, NO_USAGE);
        }
        done++;
        status('reading');
      }
    };
    // a worker that throws stops the others taking batches, and the run fails once the calls in flight are back
    const ended = await Promise.allSettled(Array.from({ length: READS }, () => worker().catch((e: unknown) => { stop = true; throw e; })));
    for (const r of ended) if (r.status === 'rejected') throw r.reason;
    const read = reads.flatMap((r) => ('notes' in r ? [r] : []));

    const ledger = readLedger(o.ledgerFile);
    const ratio = RATIO[FAMILY[preset.judge.agent]];
    const notes = cut(read.flatMap((r) => r.notes), NOTE_TOKENS * ratio);
    let findings: Finding[] = [];
    // with no notes there is nothing to judge
    if (notes.length) {
      status('judging');
      const named = notes.flatMap((n) => inventory.get(n.target ?? '') ?? []);
      const targets = fitTargets(named, TARGET_TOKENS, ratio).map((t) => ({ id: t.id, path: t.path, text: targetText(t) }));
      const reply = await ask(
        o.runner(preset.judge.agent), preset.judge.agent, judgePrompt({ focus }),
        judgeInput({ notes, targets, dismissed: dismissedCategories(ledger), previous: o.previous }),
        { model: preset.judge.model, schema: JUDGE_SCHEMA, timeoutMs: 600_000 }, JudgeReply, budget, signal,
      );
      const dismissed = new Set(Object.values(ledger).filter((e) => e.status === 'dismissed').map((e) => e.id));
      findings = reply.findings.flatMap((j): Finding[] => {
        const target = targetOf(j.target, inventory);
        const id = findingId(j.focus, j.category, target?.realPath ?? '', j.subject);
        const sessions = new Set(j.evidence.flatMap((e) => ('pr' in e.source ? [] : [sessionKey(e.source)]))).size;
        const prs = new Set(j.evidence.flatMap((e) => ('pr' in e.source ? [e.source.pr] : []))).size;
        // an unused skill is a fact of the inventory, which no session shows
        if ((sessions < 3 && prs < 2 && j.category !== 'unused-skill') || dismissed.has(id)) return [];
        return [{
          id, focus: j.focus, category: j.category, title: redact(j.title), claim: clip(redact(j.claim), CLAIM),
          evidence: j.evidence.map((e) => ({ source: e.source, quote: clip(redact(e.quote), QUOTE) })), sessions, prs,
          change: { kind: j.change.kind, summary: redact(j.change.summary), text: redact(j.change.text) }, target,
          measure: { kind: j.measure.kind, subject: j.measure.subject, name: redact(j.measure.name), before: measure(j.measure, o.measure), after: null },
          rank: j.rank,
        }];
      }).sort((a, b) => a.rank - b.rank).slice(0, FINDINGS);
    }
    budget.settle(judgeHold, NO_USAGE);

    // a fix is measured from its date
    const previous = o.previous.map((f) => {
      const fixedAt = ledger[f.id]?.fixedAt;
      return fixedAt === undefined ? f : { ...f, measure: { ...f.measure, after: measure(f.measure, { ...o.measure, span: { from: fixedAt, to: now() } }) } };
    });

    const readOf = read.flatMap((r) => r.excerpts.flatMap((e) => (e.skill ? [e.skill] : [])));
    const skipped = [
      ...Object.entries(o.runs).flatMap(([skill, n]) => {
        const k = readOf.filter((s) => s === skill).length;
        return k < n ? [`${skill}: ${k} of ${n} runs read`] : [];
      }),
      ...reads.flatMap((r) => ('failed' in r ? [r.failed] : [])),
    ];
    const usage = { budget: o.budget, used: budget.used };
    writeDurable(path.join(o.dir, 'findings.json'), findings);
    writeDurable(path.join(o.dir, 'totals.json'), {
      counts: plan.counts, measures: Object.fromEntries([...findings, ...previous].map((f) => [f.id, f.measure])),
      usage: { ...usage, over: usage.used - usage.budget }, skipped,
    });
    // read again, as the user may have marked findings while this ran
    writeLedger(o.ledgerFile, recordFindings(readLedger(o.ledgerFile), findings, now()));
    status('done');
    return { run: plan.id, findings, previous, mechanical: o.mechanical, thin: o.thin, skipped, usage };
  } catch (e) {
    status('failed', said(e));
    throw e;
  } finally {
    fs.rmSync(path.join(o.dir, 'batches'), { recursive: true, force: true });
  }
}
