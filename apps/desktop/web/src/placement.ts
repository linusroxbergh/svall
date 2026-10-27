import { farRootOf, type FleetState, type MachineId, type Robot } from '@svall/protocol';

type Machines = Pick<FleetState, 'machines'>;

// a worker the fleet no longer lists goes by its id
export const machineName = (f: Machines, id: MachineId): string => f.machines?.[id]?.name ?? id;

// the fleet lists its workers, so a move to a machine it does not list is the way back to this Mac
export const destinationName = (f: Machines, to: MachineId): string => f.machines?.[to]?.name ?? 'this Mac';

// the home never names itself, so a robot that names a machine runs on a worker
export const isPlaced = (c: Pick<Robot, 'machine'>): c is { machine: MachineId } => c.machine !== undefined;

/** The worker a robot runs on, by name; none for one on this Mac. */
export const machineOf = (f: Machines, c: Pick<Robot, 'machine'>): string | undefined => (isPlaced(c) ? machineName(f, c.machine) : undefined);

/** The worker a workspace id's files are on, by name: a placed robot's, or a worker clone's on the shelf. */
export const readsOn = (f: Pick<FleetState, 'robots' | 'machines'>, id: string): string | undefined => {
  const at = farRootOf(id)?.machine ?? (Object.hasOwn(f.robots, id) ? f.robots[id].machine : undefined);
  return at && machineName(f, at);
};

/** The worker a robot runs on, while the home has lost its link to it. */
export const unreachableOf = (f: Machines, c: Pick<Robot, 'machine'>): string | undefined =>
  (isPlaced(c) && f.machines?.[c.machine]?.reachable === false ? machineName(f, c.machine) : undefined);

/** What a robot's terminal and files say in their place while the home has lost its worker: a link in mismatch names the upgrade. */
export function awayLine(f: Machines, c: Pick<Robot, 'machine'>): string | undefined {
  const name = unreachableOf(f, c);
  const mismatch = isPlaced(c) && f.machines?.[c.machine]?.mismatch === true;
  return name && `${name} ${mismatch ? 'runs a different build; upgrade it under Machines' : 'is not reachable'}`;
}
