import { z } from 'zod';
import { ErrorFrame } from './messages.js';

/** One line of the stream between the home daemon and a worker daemon. */
export const LinkFrame = z.discriminatedUnion('t', [
  z.looseObject({ t: z.literal('hello') }),
  z.looseObject({ t: z.literal('inventory') }),
  z.object({ t: z.literal('call'), id: z.number(), method: z.string(), params: z.unknown() }),
  z.object({ t: z.literal('reply'), id: z.number(), result: z.unknown().optional(), error: ErrorFrame.optional() }),
  z.object({ t: z.literal('event'), seq: z.number(), kind: z.string(), data: z.unknown() }),
  z.object({ t: z.literal('ack'), seq: z.number() }),
  // worker to home, never journaled: one sent while the link is down is dropped
  z.object({ t: z.literal('notify'), kind: z.string(), data: z.unknown() }),
  z.object({ t: z.literal('snapshot'), version: z.number(), data: z.unknown() }),
  z.object({ t: z.literal('snapshot.ack'), version: z.number() }),
  z.object({ t: z.literal('blob'), id: z.string(), index: z.number().int().nonnegative(), count: z.number().int().positive(), data: z.string() }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('pong'), release: z.string(), bootId: z.string() }),
]);
export type LinkFrame = z.infer<typeof LinkFrame>;
