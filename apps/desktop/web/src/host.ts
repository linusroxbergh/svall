import type { ConnectionState, HostArgs, HostOp, HostStep } from './bridge.js';

// a value the shell said was a token is never shown, kept or logged, whatever step carried it
const TOKEN = /(token["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi;
const TOKEN_FLAG = /(--token[ =])[^\s"']+/gi;

export function withoutTokens(text: string): string {
  return text.replace(TOKEN, '$1…').replace(TOKEN_FLAG, '$1…');
}

/** The machines this Mac knows: each one's name by its id. */
export type MachineNames = Record<string, string>;

// an id says nothing to a person; one inside a path names a file, and stays
const UUID = '(?<!/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?!\\.\\w|/)';
export const ids = (pattern: string) => new RegExp(pattern.replaceAll('UUID', UUID), 'gi');

export const withoutGenerations = (text: string): string => text
  .replace(/\bis at generation \d+, not \d+/g, 'has moved on')
  .replace(/ at generation \d+/g, '');

/** A step's words with a machine this Mac knows by its name, any other as another machine, and no other id or generation. */
function withoutIds(text: string, names: MachineNames): string {
  const machine = (id: string) => names[id] ?? 'another machine';
  return withoutGenerations(text)
    .replace(ids(' \\(UUID\\)'), '')
    .replace(ids('\\banswered with fleetId UUID, not UUID'), 'answered for another fleet')
    .replace(ids('\\banswered with machineId (UUID), not UUID'), (_, id: string) => `answered as ${machine(id)}`)
    .replace(ids('\\b(?:the )?fleet UUID'), 'the fleet')
    .replace(ids(' in handover UUID'), ' in another handover')
    .replace(ids('UUID is committed'), 'the handover is committed')
    .replace(ids('\\bmachine (UUID)'), (_, id: string) => machine(id))
    .replace(ids('\\b(names|belongs to) (UUID)'), (_, said: string, id: string) => `${said} ${machine(id)}`)
    .replace(ids('(UUID) holds'), (_, id: string) => `${machine(id)} holds`)
    // an id said anywhere else is a known machine's name, or nothing
    .replace(ids('\\s?(UUID)'), (all: string, id: string) => (names[id] ? all.replace(id, names[id]) : ''));
}

const plainStep = (text: string, names: MachineNames): string => withoutIds(withoutTokens(text), names);

/** The phases the checklist shows, and the steps `svall host …` emits inside each. */
const PHASES = [
  { phase: 'connect', label: 'Reaching the machine', steps: ['name', 'machine', 'ssh', 'master'] },
  { phase: 'prerequisites', label: 'What the machine needs', steps: ['os', 'home', 'tools', 'space', 'linger'] },
  // the tmux the units start, which the release installed carries
  { phase: 'companion', label: 'Svall on the machine', steps: ['release', 'upload', 'install', 'tmux', 'uninstall'] },
  // an upgrade enrols the machine once its probe passes
  { phase: 'service', label: 'Running Svall there', steps: ['service', 'identity', 'enrol'] },
  { phase: 'agents', label: 'Agent CLIs', steps: ['claude', 'codex', 'opencode', 'versions'] },
  // an upgrade puts the release before back when its probe fails
  { phase: 'probe', label: 'Trying it out', steps: ['probe', 'rollback'] },
  // an add writes the registry after its final probe, and a removal after its uninstall
  { phase: 'registry', label: "This Mac's list of machines", steps: ['registry'] },
] as const;

export type Phase = (typeof PHASES)[number]['phase'] | 'other';
export type PhaseRows = { phase: Phase; label: string; rows: HostStep[] };

// the checks a machine's own doctor adds
const OTHER = { phase: 'other' as const, label: 'Checks' };

const phaseOf = (step: string) => PHASES.find((p) => (p.steps as readonly string[]).includes(step)) ?? OTHER;

/** The steps as they arrived, cut into runs of one phase, so a step is never shown out of order. */
export function groupSteps(steps: HostStep[]): PhaseRows[] {
  const groups: PhaseRows[] = [];
  for (const row of steps) {
    const { phase, label } = phaseOf(row.step);
    const last = groups.at(-1);
    if (last?.phase === phase) last.rows.push(row);
    else groups.push({ phase, label, rows: [row] });
  }
  return groups;
}

/** One `svall host <op>` the page is watching: its steps so far, and the code it ended with. */
export type HostRun = { op: HostOp; args: HostArgs; steps: HostStep[]; running: boolean; code?: number };

export const beginRun = (op: HostOp, args: HostArgs): HostRun => ({ op, args, steps: [], running: true });

/** A step is announced before it runs and named again when it ends: the row is the same row. */
export function applyStep(run: HostRun, event: HostStep, names: MachineNames = {}): HostRun {
  const row: HostStep = {
    step: event.step, status: event.status,
    ...(event.detail ? { detail: plainStep(event.detail, names) } : {}),
    ...(event.action ? { action: plainStep(event.action, names) } : {}),
    ...(event.run ? { run: event.run } : {}),
  };
  if (event.status === 'start' && run.steps.some((s) => s.step === event.step)) return run;
  const at = run.steps.findIndex((s) => s.step === event.step && s.status === 'start');
  const steps = at < 0 ? [...run.steps, row] : run.steps.map((s, i) => (i === at ? row : s));
  return { ...run, steps };
}

export const endRun = (run: HostRun, code: number): HostRun => ({ ...run, running: false, code });

export const runActions = (run: HostRun): string[] => run.steps.flatMap((s) => (s.action ? [s.action] : []));

const STEP_LABEL: Record<string, string> = {
  name: 'Name', machine: 'Machine', ssh: 'ssh login', master: 'Connection', os: 'System', home: 'Home folder', tools: 'Tools',
  space: 'Free space', linger: 'Runs after logout', release: 'Release', upload: 'Upload', install: 'Install', uninstall: 'Uninstall',
  service: 'Services', identity: 'Installed release', enrol: 'Worker', claude: 'Claude Code',
  codex: 'Codex', opencode: 'OpenCode', versions: 'Agent versions', probe: 'Final check', rollback: 'Rollback', registry: 'Machine list',
  systemd: 'Fleet service', worker: 'Worker', 'daemon env': 'Service environment', svalld: 'Fleet daemon', node: 'Node', path: 'PATH',
  gh: 'GitHub CLI', git: 'Git', hooks: 'Agent hooks', 'codex hooks': 'Codex hooks', 'codex sandbox': 'Codex sandbox', 'opencode plugin': 'OpenCode plugin',
  'hook receiver': 'Hook receiver', config: 'Fleet config', agents: 'Agents', doctor: "Machine's own checks", svall: 'Svall',
};

/** What a step is called in the panel; one it does not know, as a check the machine's doctor added, by its own name. */
export const stepLabel = (step: string): string => STEP_LABEL[step] ?? step;

/** What a step said, without the machine the panel already names when the sentence starts with it. */
export const stepSaid = (row: HostStep, machine: string): string | undefined =>
  (row.detail?.startsWith(`${machine} `) ? row.detail.slice(machine.length + 1) : row.detail);

export const OP_TITLE: Record<HostOp, string> = {
  add: 'Add machine', doctor: 'Check', upgrade: 'Upgrade', rollback: 'Roll back', remove: 'Remove',
};

/** How a finished run ends: its one line, whether nothing is left (`done`), and the one step the panel offers next. */
export type RunOutcome = { text: string; done?: true; next?: 'rollback' };

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// each step's action, and each failed step that names none
const thingsLeft = (run: HostRun): number => runActions(run).length + run.steps.filter((s) => s.status === 'fail' && !s.action).length;

export function outcomeOf(run: HostRun): RunOutcome {
  const name = run.args.name;
  const left = thingsLeft(run);
  // an upgrade puts the release before back on its own; only a rollback that failed leaves one to ask for
  const rollback = run.op === 'upgrade' && run.steps.some((s) => s.step === 'rollback' && s.status === 'fail') ? { next: 'rollback' as const } : {};
  if (run.op === 'add' || run.op === 'doctor' || run.op === 'upgrade') {
    if (left) return { text: `${name} needs ${plural(left, 'thing')} before robots can move there.`, ...rollback };
    if (run.code === 0) return { text: `${name} is ready. Robots you move there keep working while this Mac sleeps.`, done: true };
  }
  const failed = run.steps.find((s) => s.status === 'fail');
  if (failed) return { text: `${OP_TITLE[run.op]} stopped at ${stepLabel(failed.step)}${failed.detail ? `: ${failed.detail}` : ''}` };
  if (run.code !== 0) return { text: `${OP_TITLE[run.op]} ended with exit ${run.code}` };
  const done: Partial<Record<HostOp, string>> = { rollback: `${name} is rolled back`, remove: `${name} is ${run.args.forget ? 'forgotten' : 'removed'}` };
  return { text: done[run.op] ?? `${OP_TITLE[run.op]}: done`, done: true };
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SSH = /^[A-Za-z0-9][A-Za-z0-9._@:[\]-]*$/;

export const machineName = (value: string): boolean => NAME.test(value);
export const sshDestination = (value: string): boolean => SSH.test(value);

const who = (owner: string) => (owner === 'local' ? 'this machine' : owner);

/** How long a far daemon may stay silent after its route opened before the banner says so. */
export const FAR_ANSWER_MS = 60_000;

export type BannerAction = 'reconnect' | 'check' | 'upgrade' | 'here';
/** One plain sentence, what the helper said folded away, the machine it is about, and what the banner offers. `ssh`: the destination to run ssh to once. */
export type Banner = { text: string; detail?: string; machine?: string; ssh?: string; actions: BannerAction[] };

/** `machine`: the one that did not answer; none for a helper that failed before it reached one. */
function errorText(c: ConnectionState, machine: string | undefined): Pick<Banner, 'text' | 'ssh'> {
  if (machine === undefined) return { text: 'The connection helper has not said where the fleet runs.' };
  const name = machine === 'local' ? 'this Mac' : machine;
  // a machine other than the one the fleet was announced on is the gateway, asked who owns it
  const gateway = machine !== 'local' && machine !== c.owner;
  const unknown = `The gateway ${machine} did not answer, so where the fleet runs is not known`;
  switch (c.kind) {
    case 'auth': return { text: `${name} did not let ssh log in.`, ssh: c.destination ?? machine };
    case 'host_key': return { text: `ssh does not trust ${name}'s host key.`, ssh: c.destination ?? machine };
    case 'version': return { text: `${name} is on another version of Svall.` };
    case 'unreachable': return { text: gateway ? `${unknown}; trying again.` : `${name} is not reachable; trying again.` };
    case 'daemon_down': return { text: machine === 'local' ? 'svalld is not running on this Mac; trying again.' : `${name}'s svalld is not running; trying again.` };
    default: return { text: gateway ? `${unknown}.` : `${name} could not be reached.` };
  }
}

/**
 * What the banner says while the fleet is not answering here, and what it offers; nothing once it is online, unless
 * the far daemon has been `silent` since. A fleet on this Mac reports its connection only once it asks for handover,
 * which the Machines panel and this Mac's copy (`copyHere`: the shell has one to open) wait on too.
 */
export function connectionBanner(c: ConnectionState | undefined, o: { handoverEnabled: boolean; copyHere?: boolean; silent?: boolean }): Banner | undefined {
  if (!c || (c.owner === 'local' && !o.handoverEnabled)) return undefined;
  const remote = (machine: string) => o.handoverEnabled && machine !== 'local';
  switch (c.state) {
    case 'online': {
      if (!o.silent || c.owner === 'local') return undefined;
      return { text: `${c.owner}'s svalld has not answered.`, machine: c.owner, actions: [...(remote(c.owner) ? ['check' as const] : []), 'reconnect'] };
    }
    case 'connecting': return { text: `connecting to ${who(c.owner)}…`, actions: [] };
    case 'owner-changed': return { text: `the fleet moved to ${who(c.owner)}; reconnecting…`, actions: [] };
    case 'error': {
      const machine = c.kind === 'helper' ? undefined : c.machine ?? c.owner;
      const { text, ssh } = errorText(c, machine);
      const away = machine === undefined || remote(machine);
      const actions: BannerAction[] = [
        ...(c.owner === 'local' && away && o.copyHere ? ['here' as const] : []),
        ...(machine && c.kind === 'version' && remote(machine) ? ['upgrade' as const] : []),
        ...(machine && (c.kind === 'daemon_down' || c.kind === 'other' || !c.kind) && remote(machine) ? ['check' as const] : []),
        'reconnect',
      ];
      return {
        text, ...(c.message ? { detail: withoutTokens(c.message) } : {}), ...(machine && machine !== 'local' ? { machine } : {}), ...(ssh ? { ssh } : {}), actions,
      };
    }
  }
}

/** The port a login there waits for the browser on: Codex's, on localhost:1455, which a forward from this Mac reaches. */
export const loginForward = (run: string): number | undefined => (/^codex login\s*$/.test(run) ? 1455 : undefined);
