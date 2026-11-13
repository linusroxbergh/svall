import { Limits, LimitsReport, type LimitsOffer } from '@svall/protocol';
import { WHY, gb, limitsWords } from '@svall/svalld/linux/limits';
import { svallExe } from '@svall/svalld/release';
import { shq } from '@svall/svalld/text';
import type { SshMaster } from './ssh.js';

/** `{}` for no limit; undefined leaves the question for later. */
export type LimitsAsk = (o: { name: string; report: LimitsReport }) => Promise<Limits | undefined>;
export type LimitsChoice = { limits?: Limits; ask?: LimitsAsk };

const GB = /^(\d+(?:\.\d+)?)\s*([gm])b?$/i;

/** `93G` or `512M` as MiB. */
export function parseMemory(text: string): number {
  const m = GB.exec(text.trim());
  if (!m) throw new Error(`${text} is not an amount of memory, such as 8G or 512M`);
  return Math.round(Number(m[1]) * (m[2].toLowerCase() === 'g' ? 1024 : 1));
}

export function parseCpus(text: string): number {
  if (!/^\d+$/.test(text.trim()) || Number(text) < 1) throw new Error(`${text} is not a number of cores`);
  return Number(text);
}

/** `11,93G`, either part left empty for no limit on it. */
export function parseLimits(text: string): Limits {
  const [cpus = '', memory = '', ...more] = text.split(',').map((p) => p.trim());
  if (more.length || (!cpus && !memory)) throw new Error(`${text} is not cores,memory, such as 11,93G`);
  return Limits.parse({ ...(cpus && { cpus: parseCpus(cpus) }), ...(memory && { memoryMb: parseMemory(memory) }) });
}

const memoryFlag = (mb: number): string => (mb % 1024 ? `${mb}M` : `${mb / 1024}G`);

/** The flags that set `limits`, as `svall fleet limits set` and `svall host limits` take them. */
export const limitFlags = (limits: Limits): string[] => (limits.cpus || limits.memoryMb
  ? [...(limits.cpus ? ['--cpus', String(limits.cpus)] : []), ...(limits.memoryMb ? ['--memory', memoryFlag(limits.memoryMb)] : [])]
  : ['--none']);

export const sizeWords = (r: LimitsReport): string => `${r.size.cores} core${r.size.cores === 1 ? '' : 's'} and ${gb(r.size.memoryMb)}`;

/** What a report says in one line, with why a limit does not hold. */
export function limitsLine(r: LimitsReport, name: string): string {
  const set = r.limits.cpus || r.limits.memoryMb;
  const why = WHY[r.state];
  const hits = r.hits ? `; it reached its memory limit ${r.hits === 1 ? 'once' : `${r.hits} times`}, last ${new Date(r.lastHit ?? 0).toTimeString().slice(0, 5)}` : '';
  return `${set
    ? `this fleet may use ${limitsWords(r.limits, r.size)} on ${name}${why ? `, but ${why}` : ''}`
    : `${name} has ${sizeWords(r)}, and this fleet may use all of it`}${hits}`;
}

type Far = { svallBase: string; env: string[]; flags: string[]; name: string; later: string };

async function farLimits(master: SshMaster, far: Far, argv: string[]): Promise<LimitsReport | string> {
  let r: Awaited<ReturnType<SshMaster['run']>>;
  try {
    r = await master.run([...far.env, shq(svallExe(far.svallBase)), ...far.flags, '--json', 'fleet', 'limits', ...argv], { timeoutMs: 60_000 });
  } catch (e) {
    return (e as Error).message;
  }
  if (r.code !== 0) return r.stderr.trim().replace(/^svall: /, '').slice(0, 300) || `svall fleet limits exited ${r.code}`;
  try { return LimitsReport.parse(JSON.parse(r.stdout)); } catch { return 'svall fleet limits did not answer what a limit reads as'; }
}

type Step = { value: undefined; status?: 'warn'; detail: string; offer?: LimitsOffer };

/** A connect's question: what this fleet may use of the machine. One that holds a limit is shown it; one with none is set
 *  what `limits` or `ask` says, and left with none, as advice, when neither does. A limit that cannot be set stops nothing. */
export async function limitsStep(master: SshMaster, far: Far, o: LimitsChoice): Promise<Step> {
  const report = await farLimits(master, far, []);
  if (typeof report === 'string') return { value: undefined, status: 'warn', detail: `what this fleet may use of ${far.name} was not read: ${report}` };
  const shown = (r: LimitsReport): Step => ({ value: undefined, ...(WHY[r.state] && { status: 'warn' as const }), detail: limitsLine(r, far.name) });
  if (o.limits === undefined && (report.limits.cpus || report.limits.memoryMb)) return shown(report);
  const wanted = o.limits ?? await o.ask?.({ name: far.name, report });
  if (wanted === undefined) {
    const offer = report.suggested.cpus || report.suggested.memoryMb;
    return {
      value: undefined, status: 'warn', detail: `${limitsLine(report, far.name)}${offer ? `; ${far.later} ${limitFlags(report.suggested).join(' ')} keeps the rest for the machine` : ''}`,
      ...(offer && { offer: { size: report.size, suggested: report.suggested } }),
    };
  }
  if (!wanted.cpus && !wanted.memoryMb && report.state === 'none') return shown(report);
  const set = await farLimits(master, far, ['set', ...limitFlags(wanted)]);
  if (typeof set === 'string') return { value: undefined, status: 'warn', detail: `no limit was set on ${far.name}: ${set}; ${far.later} sets one` };
  return shown(set);
}
