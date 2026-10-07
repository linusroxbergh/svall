import readline from 'node:readline';
import type { Blocker, HandoverChoices, HandoverEntity, HandoverEvent, HandoverPhase, Names, Outcome, Verdict } from '@svall/protocol';
import { ARCHIVABLE } from '@svall/svalld/handover/replicas';

/** How a view names the commands it points to and the machines it speaks of. */
export type Words = { svall(args: string): string; machine(id?: string): string };

const HEADINGS: Record<HandoverPhase, string> = {
  begin: 'Begun', freeze: 'Resting characters', transfer: 'Transferring files and sessions', verify: 'Verifying',
  prepare: 'Preparing the destination', ready: 'Verifying and committing', commit: 'Committing', activate: 'Resuming characters',
  complete: 'Completing', aborted: 'Aborting',
};

const REST = new Set(['agent_working', 'agent_blocked']);

const unique = (xs: string[]): string[] => [...new Set(xs)];
const union = (held: HandoverChoices['terminateShells'] | string[] | undefined, more: string[]): string[] =>
  unique([...(Array.isArray(held) ? held : []), ...more]);

// in thousands, as the sheet counts them
function bytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return `${v.toFixed(1)} ${units[u]}`;
}

/** Who or what an entity is, for a person: a character's name, a root's destination path, a session's character. */
export function label(names: Names, entity?: HandoverEntity): string | undefined {
  if (!entity) return undefined;
  if (entity.kind === 'character') return names.characters[entity.id] ?? entity.id;
  if (entity.kind === 'root') return names.roots[entity.id] ?? entity.id;
  if (entity.kind === 'session') return names.sessions?.[entity.id] ? `${names.sessions[entity.id]}'s session` : entity.id;
  return undefined;
}

/** One blocker or warning as a line, led by what it names unless its message already says so. */
function issueLine(names: Names, b: Blocker, mark: string): string {
  const who = label(names, b.entity);
  const escaped = who?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a name inside a path, as ada in /Users/ada, does not say who
  const says = !who || new RegExp(`(^|[\\s(])${escaped}('s|\\b)`).test(b.message) || (b.entity?.kind === 'root' && b.message.startsWith('/'));
  return `  ${mark} ${says ? '' : `${who}: `}${b.message} (${b.code})`;
}

// a session OpenCode's database went on with; a divergence of files, whatever the agent, ends with the files
const OPENCODE_SESSION = /OpenCode went on with session (ses_[0-9a-f]{12}[0-9A-Za-z]{14}) past the copy coming in$/;

/** The way out of a session the destination went on with, which no choice clears. */
function sessionHint(b: Blocker, at = 'the destination'): string | undefined {
  if (b.code !== 'destination_diverged' || b.entity?.kind !== 'character') return undefined;
  const id = OPENCODE_SESSION.exec(b.message)?.[1];
  return `    The copy of this session on ${at} went on there. ` + (id
    ? `To keep it, run \`opencode session export --standalone ${id} > keep.json\` on ${at}, then \`opencode session delete --standalone ${id}\`, then try again.`
    : `Move the file named above aside on ${at}, then try again.`);
}

const characters = (blockers: Blocker[], codes: (c: string) => boolean): string[] =>
  unique(blockers.flatMap((b) => (codes(b.code) && b.entity?.kind === 'character' ? [b.entity.id] : [])));
const roots = (blockers: Blocker[]): string[] =>
  unique(blockers.flatMap((b) => (ARCHIVABLE.has(b.code) && b.entity?.kind === 'root' ? [b.entity.id] : [])));

export type Option = { key: string; label: string; answer: HandoverChoices | 'cancel' };

/**
 * What a person may do about these blockers, each naming the characters and paths it affects, and each answer the
 * whole of the choices from here on. At `begin`, nothing has started, so blockers no choice clears offer nothing to choose.
 */
export function options(blockers: Blocker[], phase: HandoverPhase, names: Names, held: HandoverChoices = {}): Option[] {
  const name = (ids: string[]) => ids.map((id) => names.characters[id] ?? id).join(', ');
  const working = characters(blockers, (c) => REST.has(c));
  const stuck = characters(blockers, (c) => c === 'shell_busy' || c === 'agent_unsettled');
  const unsettled = characters(blockers, (c) => c === 'agent_unsettled');
  const archive = roots(blockers);
  const out: Option[] = [];
  if (phase === 'freeze' && (working.length || unsettled.length)) {
    out.push({ key: 'w', label: `Continue waiting for ${name(unique([...working, ...unsettled]))}`, answer: { ...held } });
  }
  if (working.length) {
    out.push({
      key: 'i', label: `Interrupt and carry ${name(working)}: Escape goes to each agent, and its hook or process tree must confirm it rested`,
      answer: { ...held, interruptAfterMs: 0 },
    });
  }
  if (stuck.length) {
    out.push({
      key: 't', label: `Terminate and carry ${name(stuck)}: kills what runs in the foreground of each terminal, an agent that will not settle included; the shell reopens in its directory`,
      answer: { ...held, terminateShells: held.terminateShells === true ? true : union(held.terminateShells, stuck) },
    });
  }
  if (archive.length) {
    out.push({
      key: 'a', label: `Archive ${archive.map((id) => names.roots[id] ?? id).join(', ')}: each is moved to a timestamped sibling first, then copied afresh`,
      answer: { ...held, archiveRoots: union(held.archiveRoots, archive) },
    });
  }
  if (!out.length && phase === 'begin') return [];
  if (!out.length) out.push({ key: 'r', label: 'Try again', answer: { ...held } });
  out.push({ key: 'c', label: 'Cancel: nothing moves, and the fleet stays where it is', answer: 'cancel' });
  return out;
}

/** The flags a run without a person at it takes to get past these blockers. */
function flags(blockers: Blocker[], names: Names): string[] {
  const out: string[] = [];
  if (characters(blockers, (c) => REST.has(c)).length) out.push('--interrupt-after <duration> interrupts the agents still working');
  if (characters(blockers, (c) => c === 'shell_busy' || c === 'agent_unsettled').length) out.push('--terminate-shells terminates what keeps a terminal busy');
  for (const id of roots(blockers)) out.push(`--archive ${names.roots[id] ?? id} moves what is there aside first`);
  return out;
}

/** Renders a handover's events for a person, one line at a time, as the foreground command and `attach` show them. */
export class View {
  names: Names = { characters: {}, roots: {} };
  phase?: HandoverPhase;
  /** the characters whose rest the source has not confirmed yet */
  resting = new Set<string>();
  /** the machines this run moves the fleet from and to, once known */
  about: { source?: string; destination?: string } = {};
  private shown = new Map<string, string>();
  private announced = false;
  // the checks were printed, and with them every blocker a start stopped at before Begin
  private checked = false;

  constructor(private print: (line: string) => void, private words: Words, private interactive = false) {}

  private issue(b: Blocker, mark: string): string[] {
    const hint = sessionHint(b, this.about.destination);
    return [issueLine(this.names, b, mark), ...(hint ? [hint] : [])];
  }

  show(e: HandoverEvent): void {
    switch (e.event) {
      case 'handover.preflight': {
        const d = e.data;
        if (d.names) this.names = d.names;
        this.checked = true;
        const s = d.summary;
        this.print(`Checks: ${s.roots} roots, ${s.files} files (${bytes(s.bytes)}), ${s.sessions} agent sessions`);
        for (const b of d.blockers) this.print(issueLine(this.names, b, '✗'));
        for (const w of d.warnings) this.print(issueLine(this.names, w, '!'));
        if (!d.blockers.length) this.print('  ✓ nothing blocks the handover');
        return;
      }
      case 'handover.changed': {
        const { phase, transactionId } = e.data;
        if (phase === this.phase) return;
        this.phase = phase;
        this.print(phase === 'begin' ? `Handover ${transactionId} begun` : `${HEADINGS[phase]}`);
        if (phase === 'freeze' && this.interactive && !this.announced) {
          this.announced = true;
          this.print('  type i and Enter to interrupt and carry the agents still working, or c to cancel');
        }
        return;
      }
      case 'handover.entity': {
        const d = e.data;
        const who = label(this.names, { kind: d.kind, id: d.id }) ?? d.id;
        let line: string | undefined;
        if (d.kind === 'character') {
          if (d.phase === 'freeze') {
            if (d.error) this.resting.delete(d.id);
            else if (d.done === undefined) this.resting.add(d.id);
            else this.resting.delete(d.id);
          }
          line = d.error ? `  ✗ ${who}: ${d.error}` : d.phase === 'activate' ? `  ✓ ${who} resumed${d.notice ? `; ${d.notice}` : ''}`
            : d.done === undefined ? `  … ${who} resting` : `  ✓ ${who} rested`;
        } else if (d.error) {
          line = `  ! ${who}: ${d.error}`;
        } else if (d.archivedTo && !this.shown.has(`archived:${d.id}`)) {
          this.shown.set(`archived:${d.id}`, d.archivedTo);
          this.print(`  ! ${who}: what was there is kept at ${d.archivedTo}`);
        }
        if (d.kind === 'root' && !d.error && d.total !== undefined && d.done === d.total) {
          line = `  ✓ ${who} ${d.phase === 'verify' ? 'verified' : 'copied'}`;
        }
        const key = `${d.kind}:${d.id}:${d.phase}`;
        if (line && this.shown.get(key) !== line) {
          this.shown.set(key, line);
          this.print(line);
        }
        return;
      }
      case 'handover.blocked':
        this.print(`Blocked while ${HEADINGS[e.data.phase].toLowerCase()}:`);
        for (const b of e.data.blockers) for (const l of this.issue(b, '✗')) this.print(l);
        return;
      case 'handover.retry':
        this.print(`  … ${e.data.phase}: ${e.data.error}; asking again (attempt ${e.data.attempt})`);
        return;
      case 'handover.result':
        for (const line of this.outcome(e.data)) this.print(line);
        return;
      case 'handover.status':
        for (const line of this.status(e.data)) this.print(line);
        return;
      case 'handover.detached':
        this.print(`The handover runs in the background (pid ${e.data.pid}); \`${this.words.svall('handover attach')}\` follows it.`);
    }
  }

  outcome(o: Outcome): string[] {
    const { svall } = this.words;
    const next = (safe: ('resume' | 'abort')[]): string =>
      (safe.length
        ? `Next: ${safe.map((s) => `\`${svall(`handover --${s}`)}\` ${s === 'resume' ? 'goes on' : 'takes the fleet back'}`).join(', or ')}.`
        : `\`${svall('handover status')}\` says where it stands.`);
    switch (o.status) {
      case 'complete': {
        const lines = [`Handed over: the fleet runs on ${this.about.destination ?? 'its new machine'} at generation ${o.generation}.`];
        for (const c of o.characters.filter((x) => !x.ok)) {
          lines.push(`  ✗ ${this.names.characters[c.id] ?? c.id} did not resume: ${c.error ?? 'no reason given'}; it stays dormant with its transcript`);
        }
        for (const c of o.characters.filter((x) => x.ok && x.notice)) lines.push(`  ! ${this.names.characters[c.id] ?? c.id}: ${c.notice}`);
        if (o.pending?.length) lines.push(`Still to finish on the ${o.pending.join(' and the ')}: \`${svall('handover --resume')}\`.`);
        return lines;
      }
      case 'none':
        return [`Nothing to do: ${o.reason}.`];
      case 'blocked': {
        const lines = [`Nothing moved: the handover is blocked${o.phase === 'begin' ? '' : ` while ${HEADINGS[o.phase].toLowerCase()}`}, and the fleet stays where it was.`];
        if (o.phase !== 'begin' || !this.checked) for (const b of o.blockers) lines.push(...this.issue(b, '✗'));
        const ways = flags(o.blockers, this.names);
        if (ways.length) lines.push(...['Without a person to ask, a run takes these instead:', ...ways.map((w) => `  ${w}`)]);
        if (this.about.destination) lines.push(`\`${svall(`handover ${this.about.destination}`)}\` tries again.`);
        return lines;
      }
      case 'aborted':
        return [
          `Aborted: nothing was committed, and the fleet stays on ${this.about.source ?? 'the machine it ran on'}.`,
          ...(this.about.destination ? [`\`${svall(`handover ${this.about.destination}`)}\` starts again.`] : []),
        ];
      case 'interrupted':
        return [`Stopped ${o.phase === 'begin' ? 'before it began' : `while ${HEADINGS[o.phase].toLowerCase()}`}: ${o.error}`, next(o.safe)];
      case 'detached':
        return [`Stopped watching. The fleet is committed and the move goes on; \`${svall('handover status')}\` says where it stands.`];
    }
  }

  status(v: Verdict & { helper?: { pid: number } }): string[] {
    const { svall, machine } = this.words;
    // a live helper is named without the journals being read; it says where it stands to whoever attaches
    if (v.helper && v.standing === 'unknown' && !v.transactionId) return [`${v.reason[0].toUpperCase()}${v.reason.slice(1)}.`];
    if (v.standing === 'none' && !v.transactionId) {
      return [`No handover of this fleet is open: ${v.reason}.`, ...(v.safe.includes('abort') ? [`\`${svall('handover --abort')}\` clears what is left of it.`] : [])];
    }
    const lines = [`Handover ${v.transactionId ?? '(Begin never answered)'} ${v.standing}${v.phase ? `, at ${v.phase}` : ''}: ${v.reason}.`];
    if (v.fromMachineId || v.toMachineId) lines.push(`  from ${machine(v.fromMachineId)} to ${machine(v.toMachineId)}${v.generation === undefined ? '' : `, generation ${v.generation}`}`);
    lines.push(`  source journal: ${v.journals.source ?? 'none'}; destination journal: ${v.journals.destination ?? 'none'}`);
    if (v.helper) lines.push(`  running here as pid ${v.helper.pid}; \`${svall('handover attach')}\` follows it`);
    if (v.standing === 'superseded') lines.push(`Next: \`${svall('handover --forget')}\` drops this controller's journal of it; the daemons and the gateway keep theirs.`);
    else if (v.safe.length) lines.push(`Safe: ${v.safe.map((s) => `\`${svall(`handover --${s}`)}\``).join(' or ')}.`);
    else lines.push('Nothing is safe until the gateway answers.');
    return lines;
  }
}

/**
 * The terminal a person steers a handover from: a menu for each decision, and between them the lines they
 * type while characters rest. Ctrl-C stays a signal; nothing here holds the terminal raw.
 */
export class Prompter {
  private rl: readline.Interface;
  private waiting?: (line: string | undefined | null) => void;

  constructor(input: NodeJS.ReadableStream, private print: (line: string) => void, private idle: (line: string) => void, private ended?: () => void) {
    this.rl = readline.createInterface({ input, terminal: false });
    this.rl.on('line', (line) => {
      const w = this.waiting;
      if (w) { this.waiting = undefined; w(line); } else if (line.trim()) this.idle(line.trim().toLowerCase());
    });
    // input that ends cancels where a person drives the run, and where they only watch one it just ends the watch
    this.rl.on('close', () => {
      const w = this.waiting;
      this.waiting = undefined;
      w?.(this.ended ? null : undefined);
      this.ended?.();
    });
  }

  /** The option a person picks; `cancel` when input that drives the run ends, and undefined when the question went away. */
  async pick(opts: Option[]): Promise<HandoverChoices | 'cancel' | undefined> {
    for (;;) {
      for (const o of opts) this.print(`  ${o.key}) ${o.label}`);
      const keys = opts.map((o) => o.key);
      this.print(`Choose ${keys.slice(0, -1).join(', ')} or ${keys.at(-1)}:`);
      const line = await new Promise<string | undefined | null>((resolve) => { this.waiting = resolve; });
      if (line === null) return undefined;
      if (line === undefined) return 'cancel';
      const o = opts.find((x) => x.key === line.trim().toLowerCase());
      if (o) return o.answer;
    }
  }

  /** Drops the question in hand, which was answered some other way. */
  abandon(): void {
    const w = this.waiting;
    this.waiting = undefined;
    w?.(null);
  }

  close(): void {
    this.rl.close();
  }
}
