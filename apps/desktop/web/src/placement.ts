import { farRootOf, type FleetState, type MachineId, type Robot } from '@svall/protocol';

type Machines = Pick<FleetState, 'machines'>;

// a worker the fleet no longer lists goes by its id
export const machineName = (f: Machines, id: MachineId): string => f.machines?.[id]?.name ?? id;

// the fleet lists its workers, so a move to a machine it does not list is the way back to this Mac
export const destinationName = (f: Machines, to: MachineId): string => f.machines?.[to]?.name ?? 'this Mac';

// the home never names itself, so a robot that names a machine runs on a worker
export const isPlaced = (c: Pick<Robot, 'machine'>): c is { machine: MachineId } => c.machine !== undefined;

/** Whether a workspace id's files are on a worker: a placed robot's, or a worker clone's on the shelf. */
export const readsElsewhere = (f: Pick<FleetState, 'robots'>, id: string): boolean =>
  farRootOf(id) !== undefined || (Object.hasOwn(f.robots, id) && isPlaced(f.robots[id]));

/** The worker a robot runs on, while the home has lost its link to it. */
export const unreachableOf = (f: Machines, c: Pick<Robot, 'machine'>): string | undefined =>
  (isPlaced(c) && f.machines?.[c.machine]?.reachable === false ? machineName(f, c.machine) : undefined);
