import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import { ellipsis, type AgentKind, type Finding, type Preset, type RetroPlan, type RetroReport, type RetroStatus } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { NO_USAGE, type Call, type Runner, type Usage } from '../scribe/run.js';
import { oneLine } from '../text.js';
import { aggregate, type Aggregate, type AggregateInput, type Evidence, type Group, type Labelled } from './aggregate.js';
import { Budget, callTokens, cardCall, FAMILY, labelCall, OVERHEAD, SYNTHESIS_FLOOR, synthesisCall, synthesisInputFor, verifyCalls } from './budget.js';
import { calibrate, calibrated, readCalibration, writeCalibration } from './calibrate.js';
import { CARD_SYSTEM, cardInput, cardKey, cachedCard, cacheCard, CardsReply, CardsWire, checkCard, chunks, mergeCards, packCalls, parseCard, wireSchema, type Card, type Chunk, type SessionCard } from './cards.js';
import { compact } from './compact.js';
import { classOf, Label, LABEL_SYSTEM, labelInput, labelItems, LabelsReply, LabelsWire, packLabels, type LabelItem, type ReviewRun } from './labels.js';
import { dismissedCategories, findingId, readLedger, recordFindings, writeLedger } from './ledger.js';
import type { Outline } from './outline.js';
import type { PrThread } from './prs.js';
import { redact } from './redact.js';
import { keepCandidates, SYNTHESIS_SYSTEM, synthesisInput, SynthesisReply, SynthesisWire, type Candidate } from './synthesis.js';
import { targetText, type Target } from './targets.js';
import { effortOf, valueOf } from './value.js';
import { applyVerdict, evidenceFor, textsFor, Verdict, VERIFY_SYSTEM, verifyInput, VerifyReply, VerifyWire, type Checked } from './verify.js';

export type RunInput = {
  plan: RetroPlan; preset: Preset; budget: number;
  // retro runners, tools off
  runner: (agent: AgentKind) => Runner;
  // runs/<plan id>; the card cache and the calibration beside the runs
  dir: string; cardsDir: string; calibrationFile: string; ledgerFile: string;
  // the inventory as it is at run time
  targets: Target[];
  // the sessions in scope as the plan indexed them, each one's repo, the threads of the PRs review runs were joined to, and
  // the joins that failed
  outlines: Outline[]; repoOf: Map<string, string | undefined>; threads: Map<string, PrThread>;
  joins: { reviews: Omit<ReviewRun, 'findings'>[]; failed: number; ambiguous: number };
  // the installed skills no transcript has run
  unused: string[];
  // the last finished run's findings the ledger now marks fixed
  previous: Finding[];
  onStatus: (s: RetroStatus) => void; signal: AbortSignal; now?: () => number; backoffMs?: number;
};

type Stage = keyof RetroReport['usage']['byStage'];
const PARALLEL = 6, SLOWED = 3, BACKOFF_MS = 30_000, VERIFY_GROUP = 4, EXAMPLES = 5, QUOTE = 300, ERRORS = 10, ASKS = 20;
const CARDS_SCHEMA = wireSchema(CardsWire), LABELS_SCHEMA = wireSchema(LabelsWire), SYNTHESIS_SCHEMA = wireSchema(SynthesisWire), VERIFY_SCHEMA = wireSchema(VerifyWire);
const RATE_LIMITED = /\b429\b|rate.?limit/i;
const OVER = 'over the budget';

const said = (e: unknown): string => ellipsis(String(e instanceof Error ? e.message : e).replace(/\s+/g, ' '), 300);
const json = (text: string): unknown => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

/** Cards every session in scope, labels the PR comments after its review runs, synthesizes once over the groups code
 *  counted, verifies before it finalizes, and writes the cards, groups, ledger and calibration; the report is the caller's. */
export async function runPlan(o: RunInput): Promise<RetroReport> {
  const { plan, preset, signal } = o;
  const now = o.now ?? Date.now;
  const agent = plan.agent;
  const budget = new Budget(o.budget);
  const byStage: Record<Stage, number> = { cards: 0, labels: 0, synthesis: 0, verify: 0 };
  const total = o.outlines.length;
  let done = 0;
  let stage: RetroStatus['stage'] = 'reading';
  const status = (error?: string) => o.onStatus({ run: plan.id, stage, done, total, used: budget.used, ...(error && { error }) });
  let calibration = readCalibration(o.calibrationFile);
  const family = FAMILY[agent];
  const cpt = calibrated(calibration, family);
  let limit = PARALLEL;
  const inventory = new Map(o.targets.map((t) => [t.id, t]));

  // one call, settled to what it used, or to all it held when it fails or its CLI tells no usage. OpenCode has no schema
  // flag, so the schema rides in its prompt and its JSON may come wrapped in prose or a fence
  const once = async (s: Stage, run: Runner, system: string, prompt: string, call: Call, hold: number): Promise<string> => {
    const asked = agent === 'opencode' ? `${prompt}\n\nAnswer with JSON only, fitting this schema:\n${JSON.stringify(call.schema)}` : prompt;
    let used: Usage | undefined;
    try {
      const r = await run(system, asked, call, signal);
      if (r.usage.input || r.usage.output) {
        used = r.usage;
        calibration = calibrate(calibration, family, { chars: system.length + asked.length, input: r.usage.input + r.usage.cacheRead + r.usage.cacheWrite, overhead: OVERHEAD[agent].min });
      }
      return r.text;
    } finally {
      const u = used ?? { ...NO_USAGE, input: hold };
      budget.settle(hold, u);
      byStage[s] += u.input + u.output + u.cacheRead + u.cacheWrite;
      status();
    }
  };
  // a call retried once under a reservation of its own; a rate limit first waits and leaves three calls at once
  const ask = async <T>(s: Stage, run: Runner, system: string, prompt: string, call: Call, reply: z.ZodType<T>, hold: number): Promise<T> => {
    try { return reply.parse(json(await once(s, run, system, prompt, call, hold))); } catch (e) {
      signal.throwIfAborted();
      if (RATE_LIMITED.test(said(e))) { limit = SLOWED; await sleep(o.backoffMs ?? BACKOFF_MS, signal); }
      if (!budget.reserve(hold)) throw new Error("the budget left won't cover a retry");
      return reply.parse(json(await once(s, run, system, prompt, call, hold)));
    }
  };
  // calls at most `limit` at once; a worker past a lowered limit stops after its call
  const pooled = async (tasks: (() => Promise<void>)[]) => {
    let next = 0, stop = false;
    const work = async (k: number) => { while (!stop && next < tasks.length && k < limit) await tasks[next++](); };
    const ended = await Promise.allSettled(Array.from({ length: PARALLEL }, (_, k) => work(k).catch((e: unknown) => { stop = true; throw e; })));
    for (const r of ended) if (r.status === 'rejected') throw r.reason;
  };

  // the synthesis and the verify are held first, at their caps; an overrun cuts the verify to one call, then the synthesis
  // input to its floor, before it leaves a session or comment unread
  const verifyCall = callTokens(verifyCalls()[0], agent).max;
  const holds = { synthesis: total ? callTokens(synthesisCall(0, 0, cpt), agent).max : 0, verify: total ? verifyCall * verifyCalls().length : 0 };
  const floors = { synthesis: callTokens({ input: { min: SYNTHESIS_FLOOR, max: SYNTHESIS_FLOOR }, out: synthesisCall(0, 0, cpt).out }, agent).max, verify: verifyCall };
  if (!budget.reserve(holds.synthesis + holds.verify)) throw new Error(`a budget of ${o.budget} tokens won't cover the synthesis and verify's ${holds.synthesis + holds.verify}`);
  const reserve = reserver(budget, holds, floors);

  try {
    status();
    // cards: a chunk's cached card is read again, the rest asked of the small model, one card per chunk id
    const reader = o.runner(preset.read.agent);
    const readCall: Call = { model: preset.read.model, schema: CARDS_SCHEMA, timeoutMs: 600_000 };
    const keyOf = (c: Chunk) => cardKey({ model: preset.read.model, agent: preset.read.agent, text: c.text });
    const all = o.outlines.map((s) => ({ s, cs: chunks(s, compact(s), o.repoOf.get(s.session)) }));
    const raw = new Map<string, unknown>(), failed = new Map<string, string>(), cached = new Set<string>();
    const left = new Map(all.map(({ s, cs }) => [s.session, cs.length]));
    const settled = (c: Chunk) => {
      const n = (left.get(c.session) ?? 1) - 1;
      left.set(c.session, n);
      if (n === 0) { done++; status(); }
    };
    for (const { cs } of all) for (const c of cs) {
      const hit = cachedCard(o.cardsDir, keyOf(c));
      if (parseCard(hit)?.card.chunk === c.id) { raw.set(c.id, hit); cached.add(c.id); settled(c); }
    }
    done += all.filter(({ cs }) => !cs.length).length;
    const cardsFor = async (cs: Chunk[]): Promise<Map<string, unknown>> => {
      const chars = CARD_SYSTEM.length + cardInput(cs).length;
      const hold = callTokens(cardCall(chars, cs.length, cpt), agent).max;
      if (!reserve(hold)) throw new Error(OVER);
      const reply = await ask('cards', reader, CARD_SYSTEM, cardInput(cs), readCall, CardsReply, hold);
      const got = new Map<string, unknown>();
      for (const r of reply.cards) {
        const id = (r as { chunk?: unknown } | null)?.chunk;
        if (typeof id === 'string' && cs.some((c) => c.id === id) && !got.has(id)) got.set(id, r);
      }
      return got;
    };
    const keep = (c: Chunk, r: unknown) => { raw.set(c.id, r); cacheCard(o.cardsDir, keyOf(c), r); };
    await pooled(packCalls(all.flatMap(({ cs }) => cs.filter((c) => !raw.has(c.id)))).map((call) => async () => {
      const got = await cardsFor(call).catch((e: unknown) => { signal.throwIfAborted(); for (const c of call) failed.set(c.id, said(e)); return new Map<string, unknown>(); });
      for (const c of call) {
        if (got.has(c.id)) keep(c, got.get(c.id));
        // a chunk the reply left out is asked again alone, once
        else if (!failed.has(c.id)) {
          const alone = await cardsFor([c]).catch((e: unknown) => { signal.throwIfAborted(); failed.set(c.id, said(e)); return new Map<string, unknown>(); });
          if (alone.has(c.id)) keep(c, alone.get(c.id));
          else if (!failed.has(c.id)) failed.set(c.id, 'no card after a retry');
        }
        settled(c);
      }
    }));
    let kept = 0, dropped = 0;
    const cards = new Map<string, SessionCard>();
    for (const { s, cs } of all) {
      const checked = cs.flatMap((c): Card[] => {
        const p = parseCard(raw.get(c.id));
        if (!p) return [];
        const r = checkCard(p.card, c, s);
        kept += r.kept;
        dropped += r.dropped + p.dropped;
        return [r.card];
      });
      if (checked.length) cards.set(s.session, mergeCards(checked, s, now()));
    }
    writeDurable(path.join(o.dir, 'cards.json'), Buffer.from(JSON.stringify(Object.fromEntries(cards))), { mode: 0o600 });

    // labels: what each review run's card says it found goes with the later comments on its PR
    const bySession = new Map(o.outlines.map((s) => [s.session, s]));
    const reviews: ReviewRun[] = o.joins.reviews.map((r) => {
      const s = bySession.get(r.session);
      const run = s?.skills.find((x) => x.id === r.run);
      const at = new Map(s?.turns.map((t) => [t.id, t.at]));
      const findings = (cards.get(r.session)?.reviews ?? []).filter((x) => run && (at.get(x.at) ?? 0) >= run.at && (at.get(x.at) ?? 0) <= run.end).flatMap((x) => x.findings);
      return { ...r, findings };
    });
    const items = labelItems(reviews, o.threads);
    const labels = new Map<string, Label>();
    const labelling: Call = { model: preset.read.model, schema: LABELS_SCHEMA, timeoutMs: 600_000 };
    const labelsFor = async (xs: LabelItem[]) => {
      const hold = callTokens(labelCall(LABEL_SYSTEM.length + labelInput(xs).length, xs.length, cpt), agent).max;
      if (!reserve(hold)) throw new Error(OVER);
      const reply = await ask('labels', reader, LABEL_SYSTEM, labelInput(xs), labelling, LabelsReply, hold);
      for (const r of reply.labels) {
        const l = Label.safeParse(r).data;
        if (l && xs.some((x) => x.id === l.comment) && !labels.has(l.comment)) labels.set(l.comment, l);
      }
    };
    await pooled(packLabels(items).map((xs) => async () => {
      await labelsFor(xs).catch(() => signal.throwIfAborted());
      for (const x of xs.filter((i) => !labels.has(i.id))) await labelsFor([x]).catch(() => signal.throwIfAborted());
    }));
    const labelled: Labelled[] = items.flatMap((item) => { const label = labels.get(item.id); return label ? [{ item, label, class: classOf(item, label) }] : []; });

    const input: AggregateInput = { outlines: o.outlines, cards, labelled, reviews, repoOf: o.repoOf, targets: o.targets, unused: o.unused };
    const agg = aggregate(input);
    writeDurable(path.join(o.dir, 'groups.json'), Buffer.from(JSON.stringify({ groups: agg.groups, evidence: Object.fromEntries(agg.evidence) })), { mode: 0o600 });

    // synthesis over the groups, then the verify, the top-ranked candidates first
    stage = 'judging';
    status();
    const ledger = readLedger(o.ledgerFile);
    const hashes = new Map<string, string>();
    const read = (t: Target) => {
      const { text, hash } = targetText(t);
      hashes.set(t.id, hash);
      return { text, mtime: fs.statSync(t.realPath).mtimeMs };
    };
    let overview = '', works = '', cut = 0, unverified = 0;
    let checked: Checked[] = [];
    if (agg.groups.some((g) => !g.expected)) {
      const rules = o.targets.filter((t) => t.kind === 'rule').flatMap((t) => { try { return [{ id: t.id, path: short(t.path), text: targetText(t).text }]; } catch { return []; } });
      const syn = synthesisInput({
        agg, skills: o.targets.filter((t) => t.kind === 'skill'), rules, dismissed: dismissedCategories(ledger),
        sessions: total, repos: repos(o), maxTokens: synthesisInputFor(holds.synthesis, agent), cpt,
      });
      cut = syn.cut;
      const reply = await ask('synthesis', o.runner(preset.judge.agent), SYNTHESIS_SYSTEM, syn.text, { model: preset.judge.model, schema: SYNTHESIS_SCHEMA, timeoutMs: 900_000 }, SynthesisReply, holds.synthesis);
      holds.synthesis = 0;
      overview = oneLine(redact(reply.overview));
      works = oneLine(redact(reply.works));
      const groups = new Map(agg.groups.map((g) => [g.id, g]));
      const candidates = keepCandidates(reply.candidates, agg, inventory)
        .map((c) => ({ c, score: valueOf({ category: c.category, groups: c.groups.flatMap((g) => groups.get(g) ?? []), verdict: 'holds' }).score }))
        .sort((a, b) => b.score - a.score).map((x) => x.c);
      const calls = Math.min(Math.ceil(candidates.length / VERIFY_GROUP), Math.floor(holds.verify / verifyCall));
      const verified = candidates.slice(0, calls * VERIFY_GROUP);
      unverified = candidates.length - verified.length;
      checked = candidates.slice(verified.length).map((c) => ({ c, dropped: `not verified: ${OVER}` }));
      budget.release(holds.verify - calls * verifyCall);
      holds.verify = 0;
      const verifier = o.runner(preset.verify.agent);
      for (let k = 0; k < verified.length; k += VERIFY_GROUP) {
        const group = verified.slice(k, k + VERIFY_GROUP).map((c, i) => {
          const ev = evidenceFor(c, { agg, outlines: bySession, threads: o.threads, cpt });
          return { n: k + i + 1, c, cut: ev.cut, evidence: ev.text, ...textsFor(c, { inventory, read, cpt }) };
        });
        const verdicts = await ask('verify', verifier, VERIFY_SYSTEM, verifyInput(group), { model: preset.verify.model, schema: VERIFY_SCHEMA, timeoutMs: 600_000 }, VerifyReply, verifyCall)
          .then((r) => r.verdicts.flatMap((v) => Verdict.safeParse(v).data ?? []), (e: unknown) => { signal.throwIfAborted(); return said(e); });
        for (const x of group) {
          if (typeof verdicts === 'string') { checked.push({ c: x.c, dropped: `not verified: ${verdicts}` }); continue; }
          const latest = Math.max(0, ...examplesOf(x.c, agg).map((e) => e.when));
          checked.push(applyVerdict(x.c, verdicts.find((v) => v.candidate === x.n), { cut: x.cut, inventory, mtimeOf: (t) => fs.statSync(t.realPath).mtimeMs, latest }));
        }
      }
    }
    budget.release(holds.synthesis + holds.verify);

    const dismissed = new Set(Object.values(ledger).filter((e) => e.status === 'dismissed').map((e) => e.id));
    const final = finalize(checked, { agg, inventory, hashes, dismissed });

    // the last run's fixes, counted again over the sessions since each was fixed
    const previous = o.previous.map((f) => {
      const fixedAt = ledger[f.id]?.fixedAt;
      return fixedAt === undefined ? f : { ...f, measure: { ...f.measure, after: measureSince(f, input, fixedAt) } };
    });

    writeCalibration(o.calibrationFile, calibration);
    writeLedger(o.ledgerFile, recordFindings(readLedger(o.ledgerFile), final.findings, now()));
    const coverageOf = (s: Outline): RetroReport['coverage']['sessions'][number] => {
      const ids = all.find((x) => x.s === s)!.cs.map((c) => c.id);
      const reason = ids.length ? ids.map((id) => failed.get(id)).find((r) => r) : 'nothing in the span to read';
      return {
        session: s.session, agent: s.agent, ...(o.repoOf.get(s.session) && { repo: o.repoOf.get(s.session) }), day: new Date(s.start || now()).toLocaleDateString('en-CA'),
        status: reason ? 'failed' : ids.every((id) => cached.has(id)) ? 'cached' : 'carded', ...(reason && { reason }), clipped: s.clipped,
      };
    };
    stage = 'done';
    status();
    return {
      version: 2, run: plan.id, span: plan.span,
      preset: { read: preset.read.model ?? 'its own model', judge: preset.judge.model ?? 'its own model', verify: preset.verify.model ?? 'its own model' },
      overview: { text: overview, sessions: total, repos: repos(o), activeMs: agg.activeMs, mix: agg.mix },
      works: { text: works, skills: agg.works, wins: agg.wins.length },
      reviews: agg.reviews, previous, ...final,
      errors: agg.groups.filter((g) => g.kind === 'error').sort((a, b) => Number(!!a.expected) - Number(!!b.expected) || b.n - a.n).slice(0, ERRORS)
        .map((g) => ({ key: g.key.split(' × ')[0], signature: g.signature ?? '', failures: g.n, sessions: g.hit, of: g.of, elapsedMs: g.elapsedMs ?? 0, expected: !!g.expected })),
      asks: agg.groups.filter((g): g is Group & { kind: 'ask' | 'sequence' | 'retyped-rule' } => (g.kind === 'ask' || g.kind === 'sequence' || g.kind === 'retyped-rule') && g.hit >= 2)
        .sort((a, b) => b.hit - a.hit).slice(0, ASKS).map((g) => ({ kind: g.kind, key: g.key, sessions: g.hit })),
      skills: agg.skills, housekeeping: { unused: o.unused.length, sources: agg.unused },
      coverage: {
        sessions: o.outlines.map(coverageOf), quality: kept + dropped ? kept / (kept + dropped) : 1,
        joins: { joined: o.joins.reviews.length, failed: o.joins.failed, ambiguous: o.joins.ambiguous, truncated: [...o.threads.values()].filter((t) => t.truncated).length },
        cutGroups: cut, unverified, belowGate: final.belowGate,
      },
      usage: { budget: o.budget, used: budget.used, byStage },
    };
  } catch (e) {
    stage = 'failed';
    status(said(e));
    throw e;
  }
}

type Holds = { synthesis: number; verify: number };
/** A reservation that, when the budget left won't cover it, first cuts the held verify to its floor and then the held
 *  synthesis to its floor; false when even that won't cover it. */
export function reserver(budget: Budget, holds: Holds, floors: Holds): (tokens: number) => boolean {
  return (n) => {
    for (const k of ['verify', 'synthesis'] as const) {
      if (budget.reserve(n)) return true;
      const cut = Math.min(n - budget.left, holds[k] - floors[k]);
      if (cut > 0) { budget.release(cut); holds[k] -= cut; }
    }
    return budget.reserve(n);
  };
}

const repos = (o: Pick<RunInput, 'outlines' | 'repoOf'>): number => new Set(o.outlines.flatMap((s) => o.repoOf.get(s.session) ?? [])).size;
const home = os.homedir();
const short = (p: string): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
const examplesOf = (c: Candidate, agg: Aggregate): Evidence[] =>
  (c.examples.length ? c.examples : agg.groups.filter((g) => c.groups.includes(g.id)).flatMap((g) => g.examples)).flatMap((id) => agg.evidence.get(id) ?? []);

// the inventory's target by its id, with the hash of the bytes the verifier read and none when it read none, the path a
// draft would go to, or none
function targetOf(id: string | null, inventory: Map<string, Target>, hashes: Map<string, string>): Finding['target'] {
  const t = id === null ? undefined : inventory.get(id);
  if (t) return { id: t.id, path: t.path, realPath: t.realPath, class: t.class, hash: hashes.get(t.id) ?? null };
  if (!id || !/^~?\//.test(id)) return null;
  const p = id.startsWith('~/') ? path.join(home, id.slice(2)) : id;
  return { path: p, realPath: p, class: 'local', hash: null };
}

/** The verified candidates as findings: occurrences from the groups they cite, the gate (a pattern needs 3 sessions or 2
 *  PRs, with 2 sessions emerging; a singleton passes only as an error or a rule conflict), ids from the final target,
 *  dismissed ids dropped, one finding per id, numbered by value. */
export function finalize(checked: Checked[], o: { agg: Aggregate; inventory: Map<string, Target>; hashes: Map<string, string>; dismissed: Set<string> }): Pick<RetroReport, 'findings' | 'emerging' | 'singletons' | 'dropped'> & { belowGate: number } {
  const groups = new Map(o.agg.groups.map((g) => [g.id, g]));
  const out = { findings: [] as Finding[], emerging: [] as Finding[], singletons: [] as Finding[], dropped: [] as RetroReport['dropped'], belowGate: 0 };
  const seen = new Map<string, Finding>();
  for (const x of checked) {
    if ('dropped' in x) { out.dropped.push({ title: x.c.title, reason: x.dropped }); continue; }
    const c = x.c;
    const cited = c.groups.flatMap((g) => groups.get(g) ?? []);
    const target = targetOf(c.target, o.inventory, o.hashes);
    const id = findingId(c.category, target?.realPath ?? '', c.subject);
    if (o.dismissed.has(id)) continue;
    const value = valueOf({ category: c.category, groups: cited, verdict: x.verdict });
    const hits = new Set(cited.flatMap((g) => g.hits)).size;
    const f: Finding = {
      id, category: c.category, title: c.title, problem: c.problem, fix: c.fix,
      evidence: examplesOf(c, o.agg).slice(0, EXAMPLES).map((e) => ({
        source: e.pr ? { pr: e.pr, ...(e.comment && { comment: e.comment }) } : { agent: e.agent ?? 'claude', session: e.session ?? '', at: e.at ?? '' },
        when: e.when, ...(e.repo && { repo: e.repo }), quote: ellipsis(redact(e.text), QUOTE),
      })),
      sessions: new Set(cited.flatMap((g) => g.sessions)).size, prs: new Set(cited.flatMap((g) => g.prs)).size,
      change: { kind: c.change.kind, summary: redact(c.change.summary), text: redact(c.change.text) }, target,
      value, effort: effortOf({ change: c.change, target, kind: c.target === null ? undefined : o.inventory.get(c.target)?.kind }),
      verdict: { claim: x.verdict, change: x.change, ...(x.rule && { rule: x.rule }), reason: oneLine(redact(x.reason)) },
      groups: cited.map((g) => ({ kind: g.kind, key: g.key })), kind: c.kind,
      measure: { keys: cited.map((g) => ({ kind: g.kind, key: g.key })), before: cited.length ? { count: hits, of: value.m } : null, after: null },
    };
    const had = seen.get(id);
    if (had && had.value.score >= f.value.score) continue;
    seen.set(id, f);
  }
  for (const f of seen.values()) {
    if (f.kind === 'singleton') {
      if (f.category === 'error' || f.category === 'rule-conflict') out.singletons.push(f);
      else out.belowGate++;
    } else if (f.sessions >= 3 || f.prs >= 2) out.findings.push(f);
    else if (f.sessions === 2) out.emerging.push(f);
    else out.belowGate++;
  }
  const order = (a: Finding, b: Finding) => b.value.score - a.value.score || b.value.n - a.value.n || a.id.localeCompare(b.id);
  return { ...out, findings: out.findings.sort(order), emerging: out.emerging.sort(order), singletons: out.singletons.sort(order) };
}

/** A fixed finding's groups counted again over the sessions that started since its fix; a key no group holds any more
 *  counts none of those sessions. */
export function measureSince(f: Finding, input: AggregateInput, since: number): Finding['measure']['after'] {
  if (!f.measure.keys.length) return null;
  const outlines = input.outlines.filter((s) => s.start >= since);
  const sessions = new Set(outlines.map((s) => s.session));
  const agg = aggregate({
    ...input, outlines, cards: new Map([...input.cards].filter(([s]) => sessions.has(s))),
    labelled: input.labelled.filter((l) => l.item.comment.at >= since), reviews: input.reviews.filter((r) => r.end >= since),
  });
  const keys = new Set(f.measure.keys.map((k) => `${k.kind}\n${k.key}`));
  const matched = agg.groups.filter((g) => keys.has(`${g.kind}\n${g.key}`));
  if (!outlines.length) return null;
  return { count: new Set(matched.flatMap((g) => g.hits)).size, of: matched.length ? Math.max(...matched.map((g) => g.of)) : outlines.length };
}
