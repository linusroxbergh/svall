import { z } from 'zod';
import { Delivery } from './messages.js';
import { Robot } from './state.js';

export const MutationId = z.string().regex(/^mu_[0-9a-z]{10}$/);
/** The calls a worker serves itself while its home is away, journaled as mutations. */
export const MUTATIONS = ['robot.create', 'robot.update', 'robot.close', 'robot.run'] as const;
/** The robot fields an offline `robot update` may change. */
export const UPDATE_FIELDS = ['name', 'note', 'context', 'instructions'] as const;

/** A call a worker served while its home was away, made against the snapshot of `snapshotVersion`; the home applies it once, by id. */
export const Mutation = z.object({
  id: MutationId,
  method: z.enum(MUTATIONS),
  params: z.unknown(),
  snapshotVersion: z.number().int(),
  at: z.number(),
  // robot.create: the record the worker made
  robot: Robot.optional(),
  // robot.update: each named field as the worker held it
  base: z.record(z.string(), z.unknown()).optional(),
  // robot.run: what the worker answered
  delivery: Delivery.optional(),
});
export type Mutation = z.infer<typeof Mutation>;
