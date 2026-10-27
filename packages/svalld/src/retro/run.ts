import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { FOCUS_OF, JudgeFinding, JudgeReply, Note, NoteReply, type AgentKind, type Finding, type Preset, type RetroPlan, type RetroReport, type RetroStatus, type Source } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { NO_USAGE, type Call, type Runner, type Usage } from '../scribe/run.js';
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
  // every run of each skill before select's cap, and the skills no transcript has run
  runs: Record<string, number>; unused: string[];
  mechanical: string[]; thin: string[];
  // the last finished run's findings the ledger now marks fixed
  previous: Finding[];
  onStatus: (s: RetroStatus) => void; signal: AbortSignal; now?: () => number;
};

const READS = 3, REPLY_TOKENS = 2_000, NOTE_TOKENS = 100_000, TARGET_TOKENS = 40_000, FINDINGS = 7, QUOTE = 300, CLAIM = 600;
const NOTE_SCHEMA = wireSchema(NoteReply), JUDGE_SCHEMA = wireSchema(JudgeReply);
// a reply of the right shape keeps each note or finding that fits, and drops the rest
const fitting = <T>(item: z.ZodType<T>, xs: unknown[]): T[] => xs.flatMap((x) => {
  const r = item.safeParse(x);
  return r.success ? [r.data] : [];
});
const NOTES = z.object({ notes: z.array(z.unknown()) }).transform((r) => fitting(Note, r.notes));
const FINDINGS_OF = z.object({ findings: z.array(z.unknown()) }).transform((r) => fitting(JudgeFinding, r.findings));

type Read = { excerpts: Excerpt[]; notes: Note[] } | { failed: string };

const said = (e: unknown): string => clip(String(e instanceof Error ? e.message : e).replace(/\s+/g, ' '), 300);
const sessionKey = (s: { agent: AgentKind; session: string }): string => `${s.agent}\n${s.session}`;
const lineKey = (s: Source): string => ('pr' in s ? s.pr : `${sessionKey(s)}\n${s.line}`);

// one call whose answer must fit `reply`, under the `hold` its caller reserved, retried once under a reservation of its
// own; a call that fails, or whose CLI says nothing of what it used, is charged all it held. OpenCode has no schema flag,
// so its prompt carries the schema, and its answer may wrap the JSON in prose or a fence
async function ask<T>(run: Runner, agent: AgentKind, system: string, prompt: string, call: Call, reply: z.ZodType<T>, hold: number, budget: Budget, signal: AbortSignal): Promise<T> {
  const asked = agent === 'opencode' ? `${prompt}\n\nAnswer with JSON only, fitting this schema:\n${JSON.stringify(call.schema)}` : prompt;
  const once = async (): Promise<T> => {
    let used: Usage | undefined;
    try {
      const { text, usage } = await run(system, asked, call, signal);
      if (usage.input || usage.output) used = usage;
      return reply.parse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
    } finally {
      budget.settle(hold, used ?? { ...NO_USAGE, input: hold });
    }
  };
  try { return await once(); } catch {
    signal.throwIfAborted();
    if (!budget.reserve(hold)) throw new Error("the budget left won't cover a retry");
    return once();
  }
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

// the inventory's target by its id, with the hash of the bytes the judge read and none when it read none, the path a
// draft would go to, or none
function targetOf(id: string | null, inventory: Map<string, Target>, read: Map<string, string>): Finding['target'] {
  const t = id === null ? undefined : inventory.get(id);
  if (t) return { id: t.id, path: t.path, realPath: t.realPath, class: t.class, hash: read.get(t.id) ?? null };
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
    // the judge's share is held first, so reads never eat it; with nothing to read the judge is never called
    const judgeHold = total ? judgeTokens(total, preset.judge.agent).max : 0;
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
        const excerpts = JSON.parse(fs.readFileSync(path.join(o.dir, 'batches', `${b.id}.json`), 'utf8')) as Excerpt[];
        const hold = readTokens(b.tokens, preset.read.agent).max;
        if (!budget.reserve(hold)) { stop = true; return; }
        reads[i] = await ask(reader, preset.read.agent, system, readInput({ excerpts }), call, NOTES, hold, budget, signal).then(
          (r) => {
            const notes = cut(keep(r, excerpts, inventory), REPLY_TOKENS * RATIO[FAMILY[preset.read.agent]]);
            writeDurable(path.join(o.dir, 'notes', `${b.id}.json`), notes);
            return { excerpts, notes };
          },
          (e: unknown) => { signal.throwIfAborted(); return { failed: `${b.id} not read: ${said(e)}` }; },
        );
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
      const hashes = new Map<string, string>();
      const targets = fitTargets(named, TARGET_TOKENS, ratio).map((t) => {
        const { text, hash } = targetText(t);
        hashes.set(t.id, hash);
        return { id: t.id, path: t.path, text };
      });
      const reply = await ask(
        o.runner(preset.judge.agent), preset.judge.agent, judgePrompt({ focus }),
        judgeInput({ notes, targets, dismissed: dismissedCategories(ledger), previous: o.previous }),
        { model: preset.judge.model, schema: JUDGE_SCHEMA, timeoutMs: 600_000 }, FINDINGS_OF, judgeHold, budget, signal,
      );
      const dismissed = new Set(Object.values(ledger).filter((e) => e.status === 'dismissed').map((e) => e.id));
      const given = new Map<string, Note[]>();
      for (const n of notes) given.set(lineKey(n.source), [...(given.get(lineKey(n.source)) ?? []), n]);
      const unused = new Set(o.unused);
      findings = reply.flatMap((j): Finding[] => {
        const target = targetOf(j.target, inventory, hashes);
        const id = findingId(j.focus, j.category, target?.realPath ?? '', j.subject);
        // evidence counts only where it cites a note the judge was given, line and all, and shows that note's own quote
        const evidence = j.evidence.flatMap((e) => {
          const cited = given.get(lineKey(e.source)) ?? [];
          const n = cited.find((x) => x.quote === e.quote) ?? cited[0];
          return n ? [{ source: n.source, quote: n.quote }] : [];
        });
        const sessions = new Set(evidence.flatMap((e) => ('pr' in e.source ? [] : [sessionKey(e.source)]))).size;
        const prs = new Set(evidence.flatMap((e) => ('pr' in e.source ? [e.source.pr] : []))).size;
        // a skill no transcript has run is a fact code read, which no session shows, and is never changed by a diff
        const unusedSkill = j.category === 'unused-skill' && unused.has(j.subject) && j.change.kind !== 'diff';
        if ((sessions < 3 && prs < 2 && !unusedSkill) || dismissed.has(id)) return [];
        return [{
          id, focus: j.focus, category: j.category, title: redact(j.title), claim: clip(redact(j.claim), CLAIM),
          evidence: evidence.map((e) => ({ source: e.source, quote: clip(redact(e.quote), QUOTE) })), sessions, prs,
          change: { kind: j.change.kind, summary: redact(j.change.summary), text: redact(j.change.text) }, target,
          measure: { kind: j.measure.kind, subject: j.measure.subject, name: redact(j.measure.name), before: measure(j.measure, o.measure), after: null },
          rank: j.rank,
        }];
      }).sort((a, b) => a.rank - b.rank)
        // two findings on one issue share an id, and the better ranked stands for both
        .filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i).slice(0, FINDINGS);
    } else {
      budget.settle(judgeHold, NO_USAGE);
    }

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
      // each batch the budget or a failed read left unread
      ...plan.batches.flatMap((b, i) => {
        const r = reads[i];
        return !r ? [`${b.id} not read: over the budget`] : 'failed' in r ? [r.failed] : [];
      }),
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
