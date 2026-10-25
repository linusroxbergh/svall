import type { FleetState, MachineId, Robot } from '@svall/protocol';

type Machines = Pick<FleetState, 'machines'>;

// the fleet lists its workers; the one machine it leaves out is this Mac, the home
export const machineName = (f: Machines, id: MachineId): string => f.machines?.[id]?.name ?? 'this Mac';

// the home never names itself, so a robot that names a machine runs on a worker
export const isPlaced = (c: Pick<Robot, 'machine'>): c is { machine: MachineId } => c.machine !== undefined;

/** The worker a robot runs on, while the home has lost its link to it. */
export const unreachableOf = (f: Machines, c: Pick<Robot, 'machine'>): string | undefined =>
  (isPlaced(c) && f.machines?.[c.machine]?.reachable === false ? machineName(f, c.machine) : undefined);
