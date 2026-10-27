import type { StateCreator } from 'zustand/vanilla';
import type { HostArgs, HostOp, HostStep, MachineRow } from '../bridge.js';
import { applyStep, beginRun, endRun, machineNames, replaceRows, type HostRun } from '../host.js';
import type { App } from './index.js';

export type HostConfirm = { name: string; forget: boolean };

// the machines panel: what the shell's helpers report
export type HostState = {
  // the host operation the machines panel is watching, and the panel itself
  host?: HostRun;
  hostOpen: boolean;
  // the machine the panel opens on, when what opened it named one
  hostMachine?: string;
  // the removal the user is being asked about before it runs: uninstalling there, or only forgetting the route
  hostConfirm?: HostConfirm;
  // the terminal the panel shows on its machine, the command typed in it, and the port its login waits on there
  hostTerminal?: { run?: string; forward?: number };
  // the panel shows only the agent setup rows of what will not work on the machine, until the panel closes or shows every step
  hostNarrow?: boolean;
  // the registry as the shell last read it, and why it could not
  machines?: MachineRow[];
  machinesError?: string;
};

export type HostActions = {
  toggleHost(open?: boolean, machine?: string): void;
  openHostTerminal(machine: string, run?: string, forward?: number): void;
  closeHostTerminal(): void;
  hostStarted(op: HostOp, args: HostArgs): void;
  hostStep(op: HostOp, event: HostStep): void;
  hostDone(op: HostOp, code: number): void;
  // the mirror's rows as a tick left them, in place of the run's own
  hostRows(rows: HostStep[]): void;
  confirmHost(ask?: HostConfirm): void;
  narrowHost(narrow: boolean): void;
  setMachines(machines: MachineRow[], error?: string): void;
};

export const createHostSlice: StateCreator<App, [], [], HostState & HostActions> = (set) => ({
  host: undefined,
  hostOpen: false,
  hostMachine: undefined,
  hostConfirm: undefined,
  hostTerminal: undefined,
  hostNarrow: undefined,
  machines: undefined,
  machinesError: undefined,
  toggleHost: (open, machine) => set((s) => {
    const next = open ?? !s.hostOpen;
    return { hostOpen: next, hostConfirm: next ? s.hostConfirm : undefined, hostMachine: next ? machine : undefined, hostTerminal: undefined, hostNarrow: undefined };
  }),
  openHostTerminal: (machine, run, forward) => set({
    hostOpen: true, hostMachine: machine, hostConfirm: undefined, hostTerminal: run ? { run, ...(forward !== undefined && { forward }) } : {},
  }),
  closeHostTerminal: () => set({ hostTerminal: undefined }),
  // the panel follows the machine its run is about, an add's included
  hostStarted: (op, args) => set({ host: beginRun(op, args), hostConfirm: undefined, hostMachine: args.name, hostNarrow: undefined }),
  // a step from an operation the page is no longer watching belongs to a run it has forgotten
  hostStep: (op, event) => set((s) => (s.host?.op === op ? { host: applyStep(s.host, event, machineNames(s.machines)) } : {})),
  hostDone: (op, code) => set((s) => (s.host?.op === op ? { host: endRun(s.host, code) } : {})),
  hostRows: (rows) => set((s) => (s.host ? { host: replaceRows(s.host, rows, machineNames(s.machines)) } : {})),
  confirmHost: (hostConfirm) => set({ hostConfirm }),
  narrowHost: (narrow) => set({ hostNarrow: narrow || undefined }),
  setMachines: (machines, machinesError) => set({ machines, machinesError }),
});
