import { z } from 'zod';

export const MachineId = z.guid().brand<'MachineId'>();
export type MachineId = z.infer<typeof MachineId>;
export const FleetId = z.guid().brand<'FleetId'>();
export type FleetId = z.infer<typeof FleetId>;

/** A sha256 digest as lowercase hex: what names a transfer manifest on the wire. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 hex digest');

/** A path a command can be built from: an absolute one, naming itself and nothing else. */
export const MachinePath = z.string()
  .regex(/^\/[^\0\n]*$/, 'an absolute path with no NUL or newline')
  .refine((p) => !p.split('/').includes('..'), 'an absolute path that climbs nowhere');

/** A Git object by its full name, SHA-1 or SHA-256, which git never reads as an option. */
export const ObjectName = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'a full hex object name');
