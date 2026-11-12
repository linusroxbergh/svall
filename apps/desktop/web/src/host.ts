import { aside, MachineRecord, tierOf, type FleetAgents, type SetupRow, type Tier } from '@svall/protocol';
import type { HostArgs, HostOp, HostStep, MachineRow } from './bridge.js';
import type { AppState } from './store/index.js';

export { keyLabel, keyMask } from '@svall/protocol';

// a value the shell said was a token is never shown, kept or logged, whatever step carried it
const TOKEN = /(token["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi;
const TOKEN_FLAG = /(--token[ =])[^\s"']+/gi;

export function withoutTokens(text: string): string {
  return text.replace(TOKEN, '$1…').replace(TOKEN_FLAG, '$1…');
}

// where a sentence ends and what a tool said of it begins
const RAW_AT = /: Command failed:|Command failed:| exited \d+:|: ssh could not reach|\bssh: |within \d+ms:|\n(?=\s*\S)/;

/** A text that carries no `raw` of its own, cut where a tool's words begin: the sentence before them, and them behind it. */
export function splitRaw(text: string): { line: string; raw?: string } {
  const at = RAW_AT.exec(text);
  if (!at) return { line: withoutTokens(text) };
  const line = text.slice(0, at.index).replace(/[\s:]+$/, '');
  return { line: line ? withoutTokens(line) : 'Something went wrong on the machine', raw: withoutTokens(text.slice(at.index).replace(/^[\s:]+/, '')) };
}

/** The machines this Mac knows: each one's name by its id. */
export type MachineNames = Record<string, string>;

export const machineNames = (machines: MachineRow[] = []): MachineNames => Object.fromEntries(machines.map((m) => [m.id, m.name]));

// an id says nothing to a person; one inside a path names a file, and stays
const UUID = '(?<!/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?!\\.\\w|/)';
const ids = (pattern: string) => new RegExp(pattern.replaceAll('UUID', UUID), 'gi');

/** A step's words with a machine this Mac knows by its name, any other as another machine, and no other id. */
function withoutIds(text: string, names: MachineNames): string {
  const machine = (id: string) => names[id] ?? 'another machine';
  return text
    .replace(ids(' \\(UUID\\)'), '')
    .replace(ids('\\banswered with fleetId UUID, not UUID'), 'answered for another fleet')
    .replace(ids('\\banswered with machineId (UUID), not UUID'), (_, id: string) => `answered as ${machine(id)}`)
    .replace(ids('\\bmachine (UUID)'), (_, id: string) => machine(id))
    // an id said anywhere else is a known machine's name, or nothing
    .replace(ids('\\s?(UUID)'), (all: string, id: string) => (names[id] ? all.replace(id, names[id]) : ''));
}

export const plainStep = (text: string, names: MachineNames): string => withoutIds(withoutTokens(text), names);

/** What the CLI says of this machine, as a window on it says it. */
export const onThisMac = (text: string): string => text.replace(/\bthis machine\b/g, 'this Mac').replace(/\bThis machine\b/g, 'This Mac');

export const cdLine = (dir: string): string => `cd '${dir.replaceAll("'", "'\\''")}'`;
/** The folder a `cd` line goes to, as `cdLine` quotes it; none for any other command. */
export const cdDir = (run: string): string | undefined => /^cd '((?:[^']|'\\'')*)'$/.exec(run)?.[1].replaceAll("'\\''", "'");

/** Whether this Mac has an ssh route to the machine `name`, as far as its list says: a list not read, or not readable, says nothing against one. */
export const hasRoute = (s: Pick<AppState, 'machines' | 'machinesError'>, name: string): boolean =>
  s.machines === undefined || !!s.machinesError || !!s.machines.find((m) => m.name === name)?.ssh;

const plainRow = (event: HostStep, names: MachineNames): HostStep => ({
  step: event.step, status: event.status,
  ...(event.detail ? { detail: plainStep(event.detail, names) } : {}),
  ...(event.action ? { action: plainStep(event.action, names) } : {}),
  ...(event.run ? { run: event.run } : {}),
  ...(event.say ? { say: plainStep(event.say, names) } : {}),
  ...(event.forward ? { forward: event.forward } : {}),
  ...(event.tick ? { tick: event.tick } : {}),
  ...(event.gap ? { gap: event.gap } : {}),
  ...(event.here ? { here: event.here } : {}),
  ...(event.raw ? { raw: withoutTokens(event.raw) } : {}),
});

/** The sections the fine checks are listed under, in the sheet's order, and the steps `svall host …` and a machine's own doctor emit inside each; `on`, named for the machine. */
const PHASES = [
  { phase: 'connect', label: 'Connection', steps: ['name', 'machine', 'ssh', 'master'] },
  { phase: 'prerequisites', label: 'System', steps: ['os', 'home', 'tools', 'space', 'linger', 'git'] },
  {
    phase: 'svall', label: 'Svall', on: true, steps: [
      'release', 'relay', 'upload', 'install', 'tmux', 'uninstall', 'keys', 'service', 'identity', 'enrol', 'systemd', 'launchd', 'launchd plist', 'worker',
      'daemon env', 'daemon node', 'daemon path', 'svalld', 'node', 'path', 'hooks', 'codex hooks', 'codex sandbox', 'opencode plugin', 'hook receiver',
      'config', 'machine id', 'doctor', 'svall',
    ],
  },
  { phase: 'agents', label: 'Agents', on: true, steps: ['claude', 'codex', 'opencode', 'gh', 'versions', 'agents'] },
  // the mirror's report, each row a `mirror:<key>` step
  { phase: 'mirror', label: 'Your agent setup', steps: [] },
  // an upgrade puts the release before back when its probe fails; an add writes the registry after its final probe
  { phase: 'probe', label: 'Final check', steps: ['probe', 'rollback', 'registry'] },
] as const;

export type Phase = (typeof PHASES)[number]['phase'] | 'other';
export type PhaseRows = { phase: Phase; label: string; rows: HostStep[] };

// the checks a machine's own doctor adds that no phase names
const OTHER = { phase: 'other' as const, label: 'Other checks' };

const MIRROR = 'mirror:';
const phaseOf = (step: string): Phase => (step.startsWith(MIRROR) ? 'mirror' : PHASES.find((p) => (p.steps as readonly string[]).includes(step))?.phase ?? 'other');

/** Each phase once, in the sheet's order with the unknown checks last, its steps in the order they arrived; `machine` names the sections about it. */
export function groupSteps(steps: HostStep[], machine: string): PhaseRows[] {
  return [...PHASES, OTHER].flatMap((p) => {
    const rows = steps.filter((s) => phaseOf(s.step) === p.phase);
    return rows.length ? [{ phase: p.phase, label: 'on' in p ? `${p.label} on ${machine}` : p.label, rows }] : [];
  });
}

/** One `svall host <op>` the page is watching: its steps so far, and the code it ended with. */
export type HostRun = { op: HostOp; args: HostArgs; steps: HostStep[]; running: boolean; code?: number };

export const beginRun = (op: HostOp, args: HostArgs): HostRun => ({ op, args, steps: [], running: true });

/** A step is announced before it runs and named again when it ends: the row is the same row. */
export function applyStep(run: HostRun, event: HostStep, names: MachineNames = {}): HostRun {
  const row = plainRow(event, names);
  if (event.status === 'start' && run.steps.some((s) => s.step === event.step)) return run;
  const at = run.steps.findIndex((s) => s.step === event.step && s.status === 'start');
  const steps = at < 0 ? [...run.steps, row] : run.steps.map((s, i) => (i === at ? row : s));
  return { ...run, steps };
}

export const endRun = (run: HostRun, code: number): HostRun => ({ ...run, running: false, code });

export const rowToStep = ({ key, ...row }: SetupRow): HostStep => ({ step: `${MIRROR}${key}`, ...row });
/** A setup step by what the protocol asks of a row: its key, tick and gap. */
const stepToRow = (s: HostStep): Pick<SetupRow, 'key' | 'tick' | 'gap'> => ({ key: s.step.slice(MIRROR.length), tick: s.tick, gap: s.gap });
/** Whether a setup step stands aside: it runs only on a Mac, or is ticked as not needed there. */
export const asideStep = (s: HostStep): boolean => s.step.startsWith(MIRROR) && aside(stepToRow(s));

/** The run with its mirror rows swapped for `rows`, worded as a step is, where they stood, or added at its end when it had none. */
export function replaceRows(run: HostRun, rows: HostStep[], names: MachineNames = {}): HostRun {
  const at = run.steps.findIndex((s) => s.step.startsWith(MIRROR));
  const rest = run.steps.filter((s) => !s.step.startsWith(MIRROR));
  const plain = rows.map((r) => plainRow(r, names));
  return { ...run, steps: at < 0 ? [...rest, ...plain] : [...rest.slice(0, at), ...plain, ...rest.slice(at)] };
}

export const runActions = (run: HostRun): string[] => run.steps.flatMap((s) => (s.action ? [s.action] : []));

const STEP_LABEL: Record<string, string> = {
  name: 'Name', machine: 'Machine', relay: 'The home', ssh: 'Login', master: 'Connection', os: 'System', home: 'Home folder', tools: 'Tools',
  space: 'Free space', linger: 'Keeps running', release: 'Release', upload: 'Upload', install: 'Install', uninstall: 'Uninstall',
  service: 'Services', identity: 'Release there', enrol: 'Worker', seed: 'Your agent setup', claude: 'Claude Code',
  codex: 'Codex', opencode: 'OpenCode', versions: 'Agent versions', probe: 'Final check', rollback: 'Rollback', registry: 'Listed here',
  systemd: 'Background service', launchd: 'Background service', 'launchd plist': 'Service file', worker: 'Worker', 'daemon env': 'Service environment',
  'daemon path': 'Service path', 'daemon node': "Service's Node", svalld: 'Background service', node: 'Node', path: 'PATH',
  gh: 'GitHub CLI', git: 'Git', hooks: 'Agent hooks', 'codex hooks': 'Codex hooks', 'codex sandbox': 'Codex sandbox', 'opencode plugin': 'OpenCode plugin',
  'hook receiver': 'Hook receiver', config: 'Fleet config', agents: 'Agents', doctor: 'Checks there', svall: 'Svall', keys: 'Keys',
  mark: 'Hand over', crew: 'Mission control',
  fleet: 'This fleet', tailscale: 'Tailscale', snapshot: 'First copy of the fleet', join: 'This Mac joins', adopt: 'Takes over', pause: 'Pause',
  copy: 'Copy the fleet', mission: 'Mission control', phone: 'Phone link', workers: 'Other workers', abort: 'Call off', check: 'Check',
};

const AGENT_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
// a mirror row's key: a server, by agent or plugin, with the project it belongs to after an @; its login; a variable,
// command or file by itself; a subagent's file or a marketplace's list; an agent's own config
const MIRROR_LABEL: [RegExp, (...m: string[]) => string][] = [
  [/^claude:plugin:(.+?):mcp:(.+?)(?:@\/.*)?$/, (plugin, name) => `${name} (plugin ${plugin.split('@')[0]})`],
  [/^(\w+):mcp:(.+?)(?:@\/.*)?$/, (agent, name) => `${AGENT_LABEL[agent] ?? agent} MCP ${name}`],
  [/^oauth:.*?:mcp:(.+?)(?:@\/.*)?$/, (name) => name],
  [/^edited:.*?:mcp:(.+?)(?:@\/.*)?$/, (name) => `${name} as it stands`],
  [/^(?:var|runtime|unreadable):(.+)$/, (name) => name],
  [/^maconly:\w+:(.+)$/, (name) => name],
  [/^claude:plugin:(.+)$/, (plugin) => `plugin ${plugin}`],
  [/^claude:agent:(.+)$/, (file) => `subagent ${file}`],
  [/^claude:marketplace:(.+)$/, (market) => `marketplace ${market}`],
];
const MIRROR_NAME: Record<string, (home: string) => string> = {
  'claude:settings': () => 'settings.json', 'codex:config': () => 'Codex config.toml', 'opencode:config': () => 'OpenCode config', unchecked: () => 'Not checked',
  phone: (home) => `Phone while ${home} is off`,
};

function mirrorLabel(key: string, home: string): string {
  for (const [pattern, label] of MIRROR_LABEL) {
    const m = pattern.exec(key);
    if (m) return label(...m.slice(1));
  }
  return MIRROR_NAME[key]?.(home) ?? key;
}

/** What a step is called in the sheet; one it does not know, as a check the machine's doctor added, by its own name. `home`: the window's name for the fleet's home. */
export const stepLabel = (step: string, home = 'this Mac'): string => (step.startsWith(MIRROR) ? mirrorLabel(step.slice(MIRROR.length), home) : STEP_LABEL[step] ?? step);

/** How a step stands, without the machine the sheet already names when the sentence starts with it, and what a tool said after it. */
export function stepSaid(row: HostStep, machine: string): { line?: string; raw?: string } {
  const whole = row.detail?.startsWith(`${machine} `) ? row.detail.slice(machine.length + 1) : row.detail;
  return whole ? splitRaw(whole) : {};
}

export const OP_TITLE: Record<HostOp, string> = {
  add: 'Add machine', doctor: 'Check', upgrade: 'Upgrade', rollback: 'Roll back', remove: 'Remove', home: 'Move the home', 'home-retry': 'Finish the move', 'home-abort': 'Call off the move', 'home-crew': 'Bring mission control back', join: 'Join',
};

/** A run under way, as the sheet's foot says it: `Checking studio…`. */
export const runningLine = ({ op, args }: Pick<HostRun, 'op' | 'args'>): string => {
  const doing: Partial<Record<HostOp, string>> = { add: 'Adding', doctor: 'Checking', upgrade: 'Upgrading', rollback: 'Rolling back', remove: args.forget ? 'Forgetting' : 'Removing' };
  return doing[op] ? `${doing[op]} ${args.name}…` : `${OP_TITLE[op]}: running…`;
};

/** `done`: the run did what it was for and left nothing to fix; `next`: the one step the sheet offers; `raw`: what the line rests on, behind details. */
export type RunOutcome = { text: string; raw?: string; done?: true; next?: 'rollback' };

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Where a row of `op` stands for a person: to do, a note, or fine; an add's and a check's rows are the machine's checks, every other op's a step flow's. */
export const stepTier = (s: HostStep, op: HostOp, fleet: FleetAgents | undefined): Tier => tierOf(s, fleet, op !== 'add' && op !== 'doctor');

/** Whether an add put the machine in the registry: it went through, or its last step listed it. */
export const addedBy = (run: HostRun): boolean => run.code === 0 || run.steps.some((s) => s.step === 'registry' && s.status === 'ok');

/** The run's verdict in one line; `fleet`, the agents its rows are tiered by. */
export function outcomeOf(run: HostRun, fleet?: FleetAgents): RunOutcome {
  const name = run.args.name;
  const todo = run.steps.filter((s) => stepTier(s, run.op, fleet) === 'todo').length;
  // an upgrade puts the release before back on its own; only a rollback that failed leaves one to ask for
  const rollback = run.op === 'upgrade' && run.steps.some((s) => s.step === 'rollback' && s.status === 'fail') ? { next: 'rollback' as const } : {};
  if ((run.op === 'add' && addedBy(run)) || run.op === 'doctor' || run.op === 'upgrade') {
    if (todo) return { text: `${name} has ${plural(todo, 'thing')} to fix`, ...rollback };
    if (run.code === 0) return { text: `${name} is ready`, done: true };
  }
  if (run.steps.some((s) => s.status === 'fail')) return { text: `${OP_TITLE[run.op]} did not finish` };
  if (run.code !== 0) return { text: `${OP_TITLE[run.op]} ended without saying why`, raw: `exit ${run.code}` };
  const done: Partial<Record<HostOp, string>> = { rollback: `${name} is rolled back`, remove: `${name} is ${run.args.forget ? 'forgotten' : 'removed'}` };
  return { text: done[run.op] ?? `${OP_TITLE[run.op]}: done`, done: true };
}

export const machineName = (value: string): boolean => MachineRecord.shape.name.safeParse(value).success;
export const sshDestination = (value: string): boolean => MachineRecord.shape.ssh.safeParse(value).success;

/** What a terminal on a far home types to run `run` on a machine of that home: a login's port comes back over each hop, and a `cd` is left with a shell there. */
export const overHome = (ssh: string, run: string, forward?: number): string => {
  const there = run.startsWith('cd ') ? `${run}; exec "$SHELL" -l` : run;
  return `ssh -t ${forward ? `-L ${forward}:localhost:${forward} ` : ''}${ssh} '${there.replaceAll("'", "'\\''")}'`;
};

/** The port a login there waits for the browser on, which a forward from this Mac reaches: the row's own, or Codex's 1455. */
export const loginForward = (run: string, forward?: number): number | undefined => forward ?? (/^codex login\s*$/.test(run) ? 1455 : undefined);
