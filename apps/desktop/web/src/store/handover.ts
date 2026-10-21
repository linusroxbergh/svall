import type { HandoverChoices } from '@svall/protocol';
import type { StateCreator } from 'zustand/vanilla';
import type { ConnectionState, HostArgs, HostOp, HostStep } from '../bridge.js';
import { applyEvent, endFollow, followRun, goOn, needsUser, readable, verdictOf, type HandoverEvent, type HandoverRun } from '../handover.js';
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
  // the removal the user is being asked about before it runs: uninstalling there, or only forgetting the route
  hostConfirm?: HostConfirm;
  // the handover the sheet follows, and the sheet itself
  handover?: HandoverRun;
  handoverOpen: boolean;
};

export type HandoverActions = {
  setConnectionState(connection: ConnectionState): void;
  toggleHost(open?: boolean, machine?: string): void;
  hostStarted(op: HostOp, args: HostArgs): void;
  hostStep(op: HostOp, event: HostStep): void;
  hostDone(op: HostOp, code: number): void;
  confirmHost(ask?: HostConfirm): void;
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
  hostConfirm: undefined,
  handover: undefined,
  handoverOpen: false,
  // the fleet the page already holds stands while its machine is away: only the report changes
  setConnectionState: (connection) => set({ connection: { ...connection, ...(connection.message ? { message: withoutTokens(connection.message) } : {}) } }),
  toggleHost: (open, machine) => set((s) => { const next = open ?? !s.hostOpen; return { hostOpen: next, hostConfirm: next ? s.hostConfirm : undefined, hostMachine: next ? machine : undefined }; }),
  hostStarted: (op, args) => set({ host: beginRun(op, args), hostConfirm: undefined }),
  // a step from an operation the page is no longer watching belongs to a run it has forgotten
  hostStep: (op, event) => set((s) => (s.host?.op === op ? { host: applyStep(s.host, event) } : {})),
  hostDone: (op, code) => set((s) => (s.host?.op === op ? { host: endRun(s.host, code) } : {})),
  confirmHost: (hostConfirm) => set({ hostConfirm }),
  toggleHandover: (open) => set((s) => ({ handoverOpen: open ?? !s.handoverOpen })),
  handoverFollow: (to, choices) => set({ handover: followRun(to, choices) }),
  handoverGoOn: () => set((s) => (s.handover ? { handover: goOn(s.handover) } : {})),
  // the status may find a live helper, whose lines then start from nothing, as a follow's do; a resume the sheet started stays its own
  handoverCheck: () => set((s) => (s.handover ? { handover: { ...followRun(s.handover.to), checking: true, ...(s.handover.goingOn && { goingOn: true }) } } : {})),
  handoverEvent: (e) => set((s) => {
    if (!readable(e)) return {};
    const handover = applyEvent(s.handover ?? followRun(), e);
    const asks = e.event === 'handover.blocked' || (e.event === 'handover.status' && needsUser(e.data));
    return { handover, handoverOpen: s.handoverOpen || asks };
  }),
  // folded in one step, so no line of a finished run holds or closes a terminal on its way to the status
  handoverReplay: (events) => set((s) => {
    const rebuilt = events.reduce(applyEvent, followRun(s.handover?.to));
    // a status the sheet asked for after the checks stopped a start is about another handover, which need not go where the start did
    const handover = {
      ...rebuilt, following: false, ...(s.handover?.checking && verdictOf(rebuilt) && { to: undefined }), ...(s.handover?.checking && s.handover.goingOn && { goingOn: true }),
    };
    return { handover, handoverOpen: s.handoverOpen || (!!handover.status && needsUser(handover.status)) };
  }),
  handoverExit: (code, error) => set((s) => (s.handover ? { handover: endFollow(s.handover, code, error) } : {})),
  setHandoverChoices: (choices) => set((s) => (s.handover ? { handover: { ...s.handover, choices } } : {})),
  handoverChoose: (choices) => set((s) => (s.handover ? { handover: { ...s.handover, choices, decision: undefined } } : {})),
  handoverCancelled: () => set((s) => (s.handover ? { handover: { ...s.handover, cancelled: true, decision: undefined } } : {})),
});
