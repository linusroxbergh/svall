import { useEffect, useRef, useState } from 'react';
import { gb, LIMITS_WHY, type Limits, type LimitsOffer, type LimitsReport, type MachineId } from '@svall/protocol';
import { deps } from './boot.js';
import { withoutTokens } from './host.js';
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

// why a limit the machine's unit holds does not hold, in the window's words; systemd's stay behind details
const NOT_HELD: Partial<Record<LimitsReport['state'], (name: string) => { line: string; fix?: string }>> = {
  pending: (n) => ({ line: 'not in force yet', fix: `It takes hold when Svall's background service on ${n} starts.` }),
  unapplied: () => ({ line: 'not in force' }),
  no_cpu: (n) => ({ line: `${n} cannot hold this fleet to a number of cores`, fix: 'Memory can be limited.' }),
  no_memory: (n) => ({ line: `${n} cannot hold this fleet to an amount of memory` }),
  outside: (n) => ({ line: `robots on ${n} run outside the limit`, fix: "Until every robot there is closed and Svall's background service restarts." }),
};

export const limitsSaid = (r: LimitsReport, name: string): { line: string; fix?: string; raw?: string } | undefined => {
  const said = NOT_HELD[r.state]?.(name);
  return said && { ...said, raw: LIMITS_WHY[r.state] };
};

const hitsLine = (r: LimitsReport): string | undefined => (r.hits
  ? `reached its memory limit ${r.hits === 1 ? 'once' : `${r.hits} times`}, last ${new Date(r.lastHit ?? 0).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  : undefined);

/** The `11,95232M` a join's `--limits` takes, or `none`. */
export const limitsArg = (l: Limits): string => (l.cpus || l.memoryMb ? `${l.cpus ?? ''},${l.memoryMb ? `${l.memoryMb}M` : ''}` : 'none');

/** Cores and GB fields, an empty one for no limit on that part; `wanting` says why what they hold cannot be set. */
function useFields(size: LimitsReport['size'], from: Limits) {
  const [cpus, setCpus] = useState(from.cpus ? String(from.cpus) : '');
  const [memory, setMemory] = useState(from.memoryMb ? String(tenths(from.memoryMb)) : '');
  const c = Number(cpus);
  const m = Number(memory);
  const wanting = cpus && !(Number.isInteger(c) && c >= 1 && c <= size.cores) ? `Cores: 1 to ${size.cores}`
    : memory && !(m >= 0.5 && m <= tenths(size.memoryMb)) ? `Memory: 0.5 to ${gb(size.memoryMb)}` : undefined;
  // a GB typed as the machine's own size is all of it, not the few MiB a tenth rounds up past it
  const limits: Limits = { ...(cpus && { cpus: c }), ...(memory && { memoryMb: Math.min(Math.round(m * 1024), size.memoryMb) }) };
  const field = (part: 'cores' | 'memory', o: { label: string; max: number; step: number }) => (
    <input type="number" className="fld inline limits-fld" aria-label={o.label} data-testid={`limits-${part}`} min={part === 'cores' ? 1 : 0.5} max={o.max} step={o.step}
      placeholder="all" value={part === 'cores' ? cpus : memory} onChange={(e) => (part === 'cores' ? setCpus : setMemory)(e.target.value)} />
  );
  return { limits, wanting, field };
}

/**
 * A connect's ask: the machine's size and what this fleet may use of it, filled in with the default. `set` resolves once it is
 * set; a rejection is said under it, and Set can be pressed again.
 */
export function LimitsAsk({ name, offer, set, waits }: { name: string; offer: LimitsOffer; set(l: Limits): Promise<unknown>; waits?: string }) {
  const { limits, wanting, field } = useFields(offer.size, offer.suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const press = () => {
    setBusy(true);
    setError(undefined);
    set(limits).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const why = waits ?? wanting;
  return (
    <div className="limits-ask" data-testid="limits-ask">
      <div className="limits-ask-row">
        <span>
          {name} has {cores(offer.size.cores)} and {gb(offer.size.memoryMb)}. Let this fleet use{' '}
          {offer.suggested.cpus !== undefined && <>{field('cores', { label: 'Cores', max: offer.size.cores, step: 1 })} cores{offer.suggested.memoryMb !== undefined && ' and '}</>}
          {offer.suggested.memoryMb !== undefined && <>{field('memory', { label: 'Memory in GB', max: tenths(offer.size.memoryMb), step: 0.5 })} GB</>}
        </span>
        <button className="btn sm" data-testid="limits-set" disabled={busy || !!why} data-tip={why} onClick={press}>{busy ? 'Setting…' : 'Set'}</button>
      </div>
      {error && <Said line={withoutTokens(error)} mark="warn" />}
    </div>
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
  useEffect(() => {
    if (!ask) return;
    setEditing(true);
    box.current?.scrollIntoView({ block: 'nearest' });
  }, [ask]);
  if (error && !report) return (
    <div className="machine-rows" data-testid={`machine-limits-${name}`}>
      <div className="row">
        <span>limits</span>
        <b><button className="btn sm" data-testid="limits-read" onClick={() => setReads((n) => n + 1)}>Read again</button></b>
      </div>
      <div className="set-said"><Said line={withoutTokens(error)} settings mark="warn" /></div>
    </div>
  );
  if (!report) return (
    <div className="machine-rows" data-testid={`machine-limits-${name}`}>
      <div className="row"><span>limits</span><b><span className="move-spin" data-testid="limits-reading" /></b></div>
    </div>
  );
  const said = limitsSaid(report, name);
  const hits = hitsLine(report);
  return (
    <div ref={box} className="machine-rows" data-testid={`machine-limits-${name}`}>
      <div className="row">
        <span>limits<Info id={`limits-${id}`}>The cores and memory this fleet&apos;s robots share on {name}. At the memory limit, {name} stops the robot process holding most.</Info></span>
        <b className="set-pair">
          <span data-testid="limits-value">{limitsValue(report)}</span>
          <button className="btn sm" data-testid="limits-change" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Cancel' : 'Change'}</button>
        </b>
      </div>
      {said && <div className="set-said" data-testid="limits-said"><Said {...said} settings mark="warn" /></div>}
      {hits && <div className="set-note" data-testid="limits-hits">{hits}</div>}
      {editing && <LimitsEditor id={id} report={report} done={(r) => { setReport(r); setEditing(false); }} />}
    </div>
  );
}

function LimitsEditor({ id, report, done }: { id: MachineId; report: LimitsReport; done(r: LimitsReport): void }) {
  const set = report.limits.cpus || report.limits.memoryMb;
  const { limits, wanting, field } = useFields(report.size, set ? report.limits : report.suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = (l: Limits) => {
    setBusy(true);
    setError(undefined);
    deps().api.call('machines.setLimits', { machine: id, cpus: l.cpus ?? null, memoryMb: l.memoryMb ?? null })
      .then(done, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const cpuless = report.suggested.cpus === undefined && !report.limits.cpus;
  return (
    <div className="limits-edit" data-testid="limits-edit">
      {!cpuless && <div className="row"><span>cores</span><b className="set-pair">{field('cores', { label: 'Cores', max: report.size.cores, step: 1 })}of {report.size.cores}</b></div>}
      <div className="row"><span>memory</span><b className="set-pair">{field('memory', { label: 'Memory in GB', max: tenths(report.size.memoryMb), step: 0.5 })}of {gb(report.size.memoryMb)}</b></div>
      {report.heldMb !== undefined && <div className="row" data-testid="limits-held"><span>in use now</span><b>{gb(report.heldMb)}</b></div>}
      {error && <div className="set-said" data-testid="limits-error"><Said line={withoutTokens(error)} settings mark="warn" /></div>}
      <div className="row">
        <span />
        <b className="set-pair">
          <button className="btn sm" data-testid="limits-none" disabled={busy || !set} data-tip={set ? undefined : 'It has none'} onClick={() => save({})}>No limit</button>
          <button className="btn sm" data-testid="limits-save" disabled={busy || !!wanting} data-tip={wanting} onClick={() => save(limits)}>{busy ? 'Saving…' : 'Save'}</button>
        </b>
      </div>
    </div>
  );
}
