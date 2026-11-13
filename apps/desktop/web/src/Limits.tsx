import { useEffect, useRef, useState } from 'react';
import { gb, LIMITS_WHY, type Limits, type LimitsOffer, type LimitsReport, type MachineId } from '@svall/protocol';
import { deps } from './boot.js';
import { splitSaid } from './host.js';
import { Info } from './Info.js';
import { Said } from './Said.js';

const tenths = (mb: number): number => Math.round(mb / 102.4) / 10;
const cores = (n: number): string => `${n} core${n === 1 ? '' : 's'}`;

/** `11 of 12 cores · 93 of 94 GB`, or `no limit`. */
export function limitsValue(r: Pick<LimitsReport, 'size' | 'limits'>): string {
  const { size, limits } = r;
  if (!limits.cpus && !limits.memoryMb) return 'no limit';
  return [
    limits.cpus ? `${limits.cpus} of ${cores(size.cores)}` : `all ${cores(size.cores)}`,
    limits.memoryMb ? `${tenths(limits.memoryMb)} of ${gb(size.memoryMb)}` : `all ${gb(size.memoryMb)}`,
  ].join(' · ');
}

// why a limit the machine's unit holds does not hold, in the window's words; a tool's own stay behind details
const NOT_HELD: Partial<Record<LimitsReport['state'], (name: string) => { line: string; fix?: string; raw?: string }>> = {
  pending: (n) => ({ line: 'not in force yet', fix: `It takes hold when Svall's background service on ${n} starts.` }),
  unapplied: () => ({ line: 'not in force', raw: LIMITS_WHY.unapplied }),
  no_cpu: (n) => ({ line: `${n} cannot hold this fleet to a number of cores`, fix: 'Memory can be limited.', raw: LIMITS_WHY.no_cpu }),
  no_memory: (n) => ({ line: `${n} cannot hold this fleet to an amount of memory`, raw: LIMITS_WHY.no_memory }),
  outside: (n) => ({ line: `robots on ${n} run outside the limit`, fix: "Close every robot there, then restart Svall's background service" }),
};

// a time of day today, with its date before
const clock = (at: number): string => (new Date(at).toDateString() === new Date().toDateString()
  ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  : new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }));

const hitsSaid = (r: LimitsReport): string => (r.hits
  ? ` This fleet reached it ${r.hits === 1 ? `once, ${clock(r.lastHit ?? 0)}` : `${r.hits} times, last ${clock(r.lastHit ?? 0)}`}.`
  : '');

/** The `11,95232M` a join's `--limits` takes, or `none`. */
export const limitsArg = (l: Limits): string => (l.cpus || l.memoryMb ? `${l.cpus ?? ''},${l.memoryMb ? `${l.memoryMb}M` : ''}` : 'none');

/**
 * Cores and GB fields, an empty one for no limit on that part, `edited` told of each change; each one's `range`, memory's from
 * `heldMb` in use, which the machine would refuse to go under; `wrong` is the field that cannot be set and its range.
 */
function useFields(size: LimitsReport['size'], from: Limits, edited: () => void, heldMb?: number) {
  const [cpus, setCpus] = useState(from.cpus ? String(from.cpus) : '');
  const [memory, setMemory] = useState(from.memoryMb ? String(tenths(from.memoryMb)) : '');
  const c = Number(cpus);
  const m = Number(memory);
  const least = heldMb ? Math.min(Math.ceil(heldMb / 1024), tenths(size.memoryMb)) : 0.5;
  const range = { cores: `1 to ${size.cores}`, memory: `${least} to ${gb(size.memoryMb)}` };
  const wrong = cpus && !(Number.isInteger(c) && c >= 1 && c <= size.cores) ? { part: 'cores', says: `1 to ${cores(size.cores)}` } as const
    : memory && !(m >= least && m <= tenths(size.memoryMb)) ? { part: 'memory', says: range.memory } as const : undefined;
  // a GB typed as the machine's own size is all of it, not the few MiB a tenth rounds up past it
  // memory left as it was keeps its MiB, which the tenths of a GB the field shows would round
  const kept = from.memoryMb && memory === String(tenths(from.memoryMb)) ? from.memoryMb : undefined;
  const limits: Limits = { ...(cpus && { cpus: c }), ...(memory && { memoryMb: kept ?? Math.min(Math.round(m * 1024), size.memoryMb) }) };
  const field = (part: 'cores' | 'memory', o: { label: string; max: number; step: number }) => (
    <input type="number" className="fld inline limits-fld" aria-label={o.label} data-testid={`limits-${part}`} min={part === 'cores' ? 1 : least} max={o.max} step={o.step}
      placeholder="all" value={part === 'cores' ? cpus : memory} onChange={(e) => { (part === 'cores' ? setCpus : setMemory)(e.target.value); edited(); }} />
  );
  return { limits, wrong, field, range };
}

/** The first run's ask: the server's size and what this fleet may use of it, filled in with the default, both fields empty for no limit; Set leads the page's foot, Back beside it. */
export function LimitsAsk({ name, offer, set, back }: { name: string; offer: LimitsOffer; set(l: Limits): void; back(): void }) {
  const { limits, wrong, field } = useFields(offer.size, offer.suggested, () => undefined);
  return (
    <>
      <div className="limits-ask" data-testid="limits-ask">
        <div className="limits-ask-row">
          <span>
            {name} has {cores(offer.size.cores)} and {gb(offer.size.memoryMb)}. Let this fleet use{' '}
            {offer.suggested.cpus !== undefined && <>{field('cores', { label: 'Cores', max: offer.size.cores, step: 1 })} cores{offer.suggested.memoryMb !== undefined && ' and '}</>}
            {offer.suggested.memoryMb !== undefined && <>{field('memory', { label: 'Memory in GB', max: tenths(offer.size.memoryMb), step: 0.5 })} GB</>}
          </span>
        </div>
        {wrong && <span className="setup-hint" data-testid="limits-wrong">{wrong.says}</span>}
      </div>
      <div className="setup-acts">
        <button type="button" className="btn pri" data-testid="limits-set" disabled={!!wrong} data-tip={wrong?.says} onClick={() => set(limits)}>Set</button>
        <button type="button" className="btn" data-testid="fork-back" onClick={back}>Back</button>
      </div>
    </>
  );
}

/**
 * Add machine's ask in one row: the fields, from `from` and empty for no limit, and Set at its end. `set` resolves once it is
 * set; a refusal is said under it, and Set can be pressed again; `waits` says why Set is off.
 */
export function LimitsAskRow({ offer, from, set, waits }: { offer: LimitsOffer; from: Limits; set(l: Limits): Promise<unknown>; waits?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { limits, wrong, field } = useFields(offer.size, from, () => setError(undefined));
  const press = () => {
    setBusy(true);
    setError(undefined);
    set(limits).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const why = waits ?? wrong?.says;
  return (
    <>
      <div className="host-limits" data-testid="limits-ask">
        <span className="modal-sub">limits</span>
        <div className="host-limits-line">
          {offer.suggested.cpus !== undefined && <>{field('cores', { label: 'Cores', max: offer.size.cores, step: 1 })}<span>of {cores(offer.size.cores)}</span></>}
          {offer.suggested.cpus !== undefined && offer.suggested.memoryMb !== undefined && <span>·</span>}
          {offer.suggested.memoryMb !== undefined && <>{field('memory', { label: 'Memory in GB', max: tenths(offer.size.memoryMb), step: 0.5 })}<span>of {gb(offer.size.memoryMb)}</span></>}
          <button className="btn sm" data-testid="limits-set" disabled={busy || !!why} data-tip={why} onClick={press}>{busy ? 'Setting…' : 'Set'}</button>
        </div>
        {wrong && <span className="modal-sub" data-testid="limits-wrong">{wrong.says}</span>}
      </div>
      {error && <Said {...splitSaid(error)} mark="warn" />}
    </>
  );
}

/** A Linux machine's limits row in Settings → Machines, its editor opened by Change or by `ask`, a new object each time. */
export function MachineLimits({ id, name, ask }: { id: MachineId; name: string; ask?: object }) {
  const [report, setReport] = useState<LimitsReport>();
  const [error, setError] = useState<string>();
  const [reads, setReads] = useState(0);
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let left = false;
    setError(undefined);
    deps().api.call('machines.limits', { machine: id }).then((r) => { if (!left) setReport(r); }, (e: Error) => { if (!left) setError(e.message); });
    return () => { left = true; };
  }, [id, reads]);
  // the row an ask opened scrolls into view once, when it holds its limits
  const scrolled = useRef<object>(undefined);
  useEffect(() => {
    if (ask) setEditing(true);
  }, [ask]);
  useEffect(() => {
    if (!ask || !report || scrolled.current === ask) return;
    scrolled.current = ask;
    box.current?.scrollIntoView({ block: 'nearest' });
  }, [ask, report]);
  const label = (
    <span>limits<Info id={`limits-${id}`}>The cores and memory this fleet&apos;s robots share on {name}. At the memory limit, {name} stops the robot process holding most.{report && hitsSaid(report)}</Info></span>
  );
  if (error && !report) return (
    <div className="machine-rows" data-testid={`machine-limits-${name}`}>
      <div className="row">
        {label}
        <b><button className="btn sm" data-testid="limits-read" onClick={() => setReads((n) => n + 1)}>Read again</button></b>
      </div>
      <div className="set-said"><Said {...splitSaid(error)} settings mark="warn" /></div>
    </div>
  );
  if (!report) return (
    <div className="machine-rows" data-testid={`machine-limits-${name}`}>
      <div className="row">{label}<span className="set-note" data-testid="limits-reading"><span className="move-spin" />Reading {name}&apos;s limits…</span></div>
    </div>
  );
  const said = NOT_HELD[report.state]?.(name);
  return (
    <div ref={box} className="machine-rows" data-testid={`machine-limits-${name}`}>
      <div className="row">
        {label}
        <b className="set-pair">
          <span data-testid="limits-value">{limitsValue(report)}</span>
          <button className="btn sm limits-change" data-testid="limits-change" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Cancel' : 'Change'}</button>
        </b>
      </div>
      {said && <div className="set-said" data-testid="limits-said"><Said {...said} settings mark="warn" /></div>}
      {editing && <LimitsEditor id={id} name={name} report={report} done={(r) => { setReport(r); setEditing(false); }} />}
    </div>
  );
}

function LimitsEditor({ id, name, report, done }: { id: MachineId; name: string; report: LimitsReport; done(r: LimitsReport): void }) {
  const set = report.limits.cpus || report.limits.memoryMb;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { limits, wrong, field, range } = useFields(report.size, set ? report.limits : report.suggested, () => setError(undefined), report.heldMb);
  const save = () => {
    setBusy(true);
    setError(undefined);
    deps().api.call('machines.setLimits', { machine: id, cpus: limits.cpus ?? null, memoryMb: limits.memoryMb ?? null })
      .then(done, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const cpuless = report.suggested.cpus === undefined && !report.limits.cpus;
  // a field beside its range, which moves under it while what the field holds is out of it
  const part = (p: 'cores' | 'memory', o: { label: string; max: number; step: number }) => (
    <>
      <div className="row">
        <span>{p}</span>
        <b className="set-pair">{wrong?.part !== p && <span className="limits-range">{range[p]}</span>}{field(p, o)}</b>
      </div>
      {wrong?.part === p && <div className="set-note limits-wrong" data-testid="limits-wrong">{wrong.says}</div>}
    </>
  );
  return (
    <div className="limits-edit" data-testid="limits-edit">
      {!set && <div className="set-note" data-testid="limits-suggested">Suggested for {name}&apos;s {cores(report.size.cores)} and {gb(report.size.memoryMb)}</div>}
      {!cpuless && part('cores', { label: 'Cores', max: report.size.cores, step: 1 })}
      {part('memory', { label: 'Memory in GB', max: tenths(report.size.memoryMb), step: 0.5 })}
      {report.heldMb !== undefined && <div className="row" data-testid="limits-held"><span>memory in use now</span><b>{gb(report.heldMb)}</b></div>}
      {error && <div className="set-said" data-testid="limits-error"><Said {...splitSaid(error)} settings mark="warn" /></div>}
      <div className="row">
        <span className="set-note">Robots keep running; the limits take hold now</span>
        <b><button className="btn sm" data-testid="limits-save" disabled={busy || !!wrong} data-tip={wrong?.says} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></b>
      </div>
    </div>
  );
}
