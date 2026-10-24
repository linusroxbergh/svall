import type { HandoverChoices } from '@svall/protocol';
import type { StateCreator } from 'zustand/vanilla';
import type { ConnectionState, HostArgs, HostOp, HostStep, MachineRow } from '../bridge.js';
import { applyEvent, endFollow, followRun, goOn, needsUser, readable, type HandoverEvent, type HandoverRun } from '../handover.js';
import { applyStep, beginRun, endRun, withoutTokens, type HostRun } from '../host.js';
import type { App } from './index.js';

export type HostConfirm = { name: string; forget: boolean };

// where the fleet runs, the machines panel and the handover sheet: what the shell's helpers report
export type HandoverState = {
  // where the fleet runs, as the shell's connect helper last said; absent in a plain browser
  connection?: ConnectionState;
  // the host operation the machines panel is watching, and the panel itself
  host?: HostRun;
  hostOpen: boolean;
  // the machine the panel opens on, when what opened it named one
  hostMachine?: string;
  // the handover sheet opened the panel, and gets the user back once the machine is this fleet's gateway
  hostForHandover: boolean;
  // the removal the user is being asked about before it runs: uninstalling there, or only forgetting the route
  hostConfirm?: HostConfirm;
  // the terminal the panel shows on its machine, and the command typed in it
  hostTerminal?: { run?: string };
  // the registry as the shell last read it, and why it could not
  machines?: MachineRow[];
  machinesError?: string;
  // the handover the sheet follows, and the sheet itself
  handover?: HandoverRun;
  handoverOpen: boolean;
};

export type HandoverActions = {
  setConnectionState(connection: ConnectionState): void;
  toggleHost(open?: boolean, machine?: string): void;
  // the panel in place of the sheet, on a machine to make the gateway or none to add one, with no earlier run to act on
  hostFromHandover(machine?: string): void;
  openHostTerminal(machine: string, run?: string): void;
  closeHostTerminal(): void;
  hostStarted(op: HostOp, args: HostArgs): void;
  hostStep(op: HostOp, event: HostStep): void;
  hostDone(op: HostOp, code: number): void;
  confirmHost(ask?: HostConfirm): void;
  setMachines(machines: MachineRow[], error?: string): void;
  toggleHandover(open?: boolean): void;
  handoverFollow(to?: string, choices?: HandoverChoices): void;
  // a resume the sheet starts by itself, keeping what the run it goes on from showed
  handoverGoOn(): void;
  // the sheet has asked where a handover stands
  handoverCheck(): void;
  handoverEvent(e: HandoverEvent): void;
  // the last run as the events file kept it, and the status after it: read back at once, never followed
  handoverReplay(events: HandoverEvent[]): void;
  handoverExit(code: number, error?: string): void;
  // what the user has picked so far; sent only when they carry on
  setHandoverChoices(choices: HandoverChoices): void;
  handoverChoose(choices: HandoverChoices): void;
  handoverCancelled(): void;
};

export const createHandoverSlice: StateCreator<App, [], [], HandoverState & HandoverActions> = (set) => ({
  connection: undefined,
  host: undefined,
  hostOpen: false,
  hostMachine: undefined,
  hostForHandover: false,
  hostConfirm: undefined,
  hostTerminal: undefined,
  machines: undefined,
  machinesError: undefined,
  handover: undefined,
  handoverOpen: false,
  // the fleet the page already holds stands while its machine is away: only the report changes
  setConnectionState: (connection) => set({ connection: { ...connection, ...(connection.message ? { message: withoutTokens(connection.message) } : {}) } }),
  toggleHost: (open, machine) => set((s) => { const next = open ?? !s.hostOpen; return { hostOpen: next, hostConfirm: next ? s.hostConfirm : undefined, hostMachine: next ? machine : undefined, hostTerminal: undefined, hostForHandover: next && s.hostForHandover }; }),
  hostFromHandover: (machine) => set({ handoverOpen: false, hostOpen: true, hostMachine: machine, hostConfirm: undefined, hostTerminal: undefined, hostForHandover: true, host: undefined }),
  openHostTerminal: (machine, run) => set({ hostOpen: true, hostMachine: machine, hostConfirm: undefined, hostTerminal: run ? { run } : {} }),
  closeHostTerminal: () => set({ hostTerminal: undefined }),
  // the panel follows the machine its run is about, an add's included
  hostStarted: (op, args) => set({ host: beginRun(op, args), hostConfirm: undefined, hostMachine: args.name }),
  // a step from an operation the page is no longer watching belongs to a run it has forgotten
  hostStep: (op, event) => set((s) => (s.host?.op === op ? { host: applyStep(s.host, event, Object.fromEntries((s.machines ?? []).map((m) => [m.id, m.name]))) } : {})),
  hostDone: (op, code) => set((s) => (s.host?.op === op ? { host: endRun(s.host, code) } : {})),
  confirmHost: (hostConfirm) => set({ hostConfirm }),
  setMachines: (machines, machinesError) => set({ machines, machinesError }),
  toggleHandover: (open) => set((s) => ({ handoverOpen: open ?? !s.handoverOpen })),
  handoverFollow: (to, choices) => set({ handover: followRun(to, choices) }),
  handoverGoOn: () => set((s) => (s.handover ? { handover: goOn(s.handover) } : {})),
  // the status may find a live helper, whose lines then start from nothing, as a follow's do; a resume the sheet started stays its own
  handoverCheck: () => set((s) => (s.handover
    ? { handover: { ...followRun(s.handover.to), checking: true, ...(s.handover.goingOn && { goingOn: true }), stopped: s.handover } }
    : {})),
  handoverEvent: (e) => set((s) => {
    if (!readable(e)) return {};
    const handover = applyEvent(s.handover ?? followRun(), e, { now: Date.now() });
    const asks = e.event === 'handover.blocked' || (e.event === 'handover.status' && needsUser(e.data));
    return { handover, handoverOpen: s.handoverOpen || asks };
  }),
  // folded in one step, so no line of a finished run holds or closes a terminal on its way to the status
  handoverReplay: (events) => set((s) => {
    const rebuilt = events.reduce((run, e) => applyEvent(run, e), followRun(s.handover?.to));
    const asked = s.handover?.checking ? s.handover : undefined;
    const nothingOpen = rebuilt.status?.standing === 'none' && !rebuilt.status.safe.length;
    // with nothing open the run the sheet asked about stands, which the events file lacks when the launcher refused;
    // otherwise the status found another handover, which need not go where that run did
    const handover = asked?.stopped && nothingOpen ? { ...asked.stopped, following: false, status: rebuilt.status, checked: true } : {
      ...rebuilt, following: false, ...(asked?.goingOn && { goingOn: true }), ...(asked && { to: undefined }),
    };
    return { handover, handoverOpen: s.handoverOpen || (!!handover.status && needsUser(handover.status)) };
  }),
  handoverExit: (code, error) => set((s) => (s.handover ? { handover: endFollow(s.handover, code, error) } : {})),
  setHandoverChoices: (choices) => set((s) => (s.handover ? { handover: { ...s.handover, choices } } : {})),
  handoverChoose: (choices) => set((s) => (s.handover ? { handover: { ...s.handover, choices, decision: undefined } } : {})),
  handoverCancelled: () => set((s) => (s.handover ? { handover: { ...s.handover, cancelled: true, decision: undefined } } : {})),
});
