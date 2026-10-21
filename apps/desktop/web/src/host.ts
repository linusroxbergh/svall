import type { ConnectionState, HostArgs, HostOp, HostStep } from './bridge.js';

// a value the shell said was a token is never shown, kept or logged, whatever step carried it
const TOKEN = /(token["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi;
const TOKEN_FLAG = /(--token[ =])[^\s"']+/gi;

export function withoutTokens(text: string): string {
  return text.replace(TOKEN, '$1…').replace(TOKEN_FLAG, '$1…');
}

/** The phases the checklist shows, and the steps `svall host …` emits inside each. */
const PHASES = [
  { phase: 'connect', label: 'Connect', steps: ['name', 'machine', 'ssh', 'master'] },
  { phase: 'prerequisites', label: 'Prerequisites', steps: ['os', 'home', 'tools', 'tmux', 'rsync', 'space', 'linger'] },
  { phase: 'companion', label: 'Companion', steps: ['release', 'upload', 'install', 'uninstall'] },
  { phase: 'service', label: 'Service', steps: ['service', 'identity', 'authority', 'fleet'] },
  { phase: 'agents', label: 'Agent logins', steps: ['claude', 'codex', 'opencode'] },
  // an upgrade puts the release before back when its probe fails
  { phase: 'probe', label: 'Final probe', steps: ['probe', 'rollback'] },
  // an add writes the registry after its final probe, and a removal after its uninstall
  { phase: 'registry', label: 'Registry', steps: ['registry'] },
] as const;

export type Phase = (typeof PHASES)[number]['phase'] | 'other';
export type PhaseRows = { phase: Phase; label: string; rows: HostStep[] };

const OTHER = { phase: 'other' as const, label: 'Setup' };

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
export function applyStep(run: HostRun, event: HostStep): HostRun {
  const row: HostStep = {
    step: event.step, status: event.status,
    ...(event.detail ? { detail: withoutTokens(event.detail) } : {}),
    ...(event.action ? { action: withoutTokens(event.action) } : {}),
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
  space: 'Free space', linger: 'Lingering', release: 'Release', upload: 'Upload', install: 'Install', uninstall: 'Uninstall',
  service: 'Services', identity: 'Installed release', authority: 'Ownership record', fleet: 'Fleets', claude: 'Claude Code',
  codex: 'Codex', opencode: 'OpenCode', probe: 'Final check', rollback: 'Rollback', registry: 'Machine list',
};

/** What a step is called in the panel; one it does not know, as a check the machine's doctor added, by its own name. */
export const stepLabel = (step: string): string => STEP_LABEL[step] ?? step;

export const OP_TITLE: Record<HostOp, string> = {
  add: 'Add machine', doctor: 'Check', upgrade: 'Upgrade', rollback: 'Roll back', remove: 'Remove', enable: "Make it this fleet's gateway",
};

/** How a finished run ends: what it did, what is left, and the one step the panel offers next. */
export type RunOutcome = { text: string; list?: string[]; next?: 'gateway' | 'handover' | 'rollback' };

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** `gateway`: the machine this fleet names as its gateway, before which nothing is ready for handover. */
export function outcomeOf(run: HostRun, gateway: string | undefined): RunOutcome {
  const name = run.args.name;
  const actions = runActions(run);
  const list = actions.length ? { list: actions } : {};
  const theGateway = gateway === name;
  const onward = theGateway ? { next: 'handover' as const } : { next: 'gateway' as const };
  if (run.op === 'doctor') {
    const failed = run.steps.filter((s) => s.status === 'fail');
    if (failed.length) return { text: `${plural(failed.length, 'check')} block${failed.length === 1 ? 's' : ''} a handover:`, list: failed.map((s) => `${stepLabel(s.step)}: ${s.detail ?? 'failed'}`) };
    const warned = run.steps.filter((s) => s.status === 'warn').length;
    const ready = theGateway ? 'ready for handover' : "ready to be this fleet's gateway";
    if (run.code === 0) return { text: `${ready}${warned ? `; ${plural(warned, 'warning')}` : ''}`, ...list, ...onward };
  }
  const failed = run.steps.find((s) => s.status === 'fail');
  // an upgrade puts the release before back on its own; only a rollback that failed leaves one to ask for
  const rollback = run.op === 'upgrade' && run.steps.some((s) => s.step === 'rollback' && s.status === 'fail') ? { next: 'rollback' as const } : {};
  if (failed) return { text: `${OP_TITLE[run.op]} stopped at ${stepLabel(failed.step)}${failed.detail ? `: ${failed.detail}` : ''}`, ...list, ...rollback };
  // an add is done once its machine is in the registry, whatever it left to do; a stopped one never got there
  if (run.op === 'add' && run.steps.some((s) => s.step === 'registry' && s.status === 'ok')) {
    return { text: `${name} is added${actions.length ? '; still to do:' : theGateway ? ': ready for handover' : ''}`, ...list, ...onward };
  }
  if (run.code !== 0) return { text: actions.length ? 'still to do:' : `${OP_TITLE[run.op]} ended with exit ${run.code}`, ...list, ...rollback };
  const done: Partial<Record<HostOp, string>> = {
    upgrade: `${name} is upgraded`, rollback: `${name} is rolled back`, remove: `${name} is ${run.args.forget ? 'forgotten' : 'removed'}`,
    enable: `${name} is this fleet's gateway: ready for handover`,
  };
  return { text: done[run.op] ?? `${OP_TITLE[run.op]}: done`, ...list, ...(run.op === 'enable' ? { next: 'handover' as const } : {}) };
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SSH = /^[A-Za-z0-9][A-Za-z0-9._@:[\]-]*$/;

export const machineName = (value: string): boolean => NAME.test(value);
export const sshDestination = (value: string): boolean => SSH.test(value);

const who = (owner: string) => (owner === 'local' ? 'this machine' : owner);

export type BannerAction = 'reconnect' | 'check' | 'upgrade';
/** One plain sentence, what the helper said folded away, the machine it is about, and what the banner offers. `ssh`: the destination to run ssh to once. */
export type Banner = { text: string; detail?: string; machine?: string; ssh?: string; actions: BannerAction[] };

/** `machine`: the one that did not answer. */
function errorText(c: ConnectionState, machine: string): Pick<Banner, 'text' | 'ssh'> {
  const name = machine === 'local' ? 'this Mac' : machine;
  switch (c.kind) {
    case 'auth': return { text: `${name} did not let ssh log in.`, ssh: c.destination ?? machine };
    case 'host_key': return { text: `ssh does not trust ${name}'s host key.`, ssh: c.destination ?? machine };
    case 'version': return { text: `${name} is on another version of Svall.` };
    case 'unreachable': return { text: `${name} is not reachable; trying again.` };
    case 'daemon_down': return { text: machine === 'local' ? 'svalld is not running on this Mac; trying again.' : `${name}'s svalld is not running; trying again.` };
    default: return { text: `${name} could not be reached.` };
  }
}

/**
 * What the banner says while the fleet is not answering here, and what it offers; nothing once it is online. A fleet
 * on this Mac reports its connection only once it asks for handover, which the Machines panel waits on too.
 */
export function connectionBanner(c: ConnectionState | undefined, o: { handoverEnabled: boolean }): Banner | undefined {
  if (!c || (c.owner === 'local' && !o.handoverEnabled)) return undefined;
  const remote = (machine: string) => o.handoverEnabled && machine !== 'local';
  switch (c.state) {
    case 'online': return undefined;
    case 'connecting': return { text: `connecting to ${who(c.owner)}…`, actions: [] };
    case 'owner-changed': return { text: `the fleet moved to ${who(c.owner)}; reconnecting…`, actions: [] };
    case 'error': {
      const machine = c.machine ?? c.owner;
      const { text, ssh } = errorText(c, machine);
      const actions: BannerAction[] = [
        ...(c.kind === 'version' && remote(machine) ? ['upgrade' as const] : []),
        ...((c.kind === 'daemon_down' || c.kind === 'other' || !c.kind) && remote(machine) ? ['check' as const] : []),
        'reconnect',
      ];
      return {
        text, ...(c.message ? { detail: withoutTokens(c.message) } : {}), ...(machine !== 'local' ? { machine } : {}), ...(ssh ? { ssh } : {}), actions,
      };
    }
  }
}
