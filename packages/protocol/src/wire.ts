import { z } from 'zod';
import type { MethodName } from './messages.js';

// what a client needs for every call to a daemon, without the schemas of the calls themselves

// how long the daemon waits for a fresh agent to attach before it answers robot.create with a run
export const RUN_TIMEOUT_MS = 30_000;
/** How long robot.create may clone a remote into its folder: svalld's clone git gives up then. */
export const CLONE_TIMEOUT_MS = 600_000;

// how long enabling the phone link may take, since a checkout with no phone bundle builds one first
const MOBILE_SET_TIMEOUT_MS = 3 * 60_000;

const SWEEP_TIMEOUT_MS = 15 * 60_000;

// how long a retro plan may take to index a month of transcripts and fetch the PR threads its reviews join
const RETRO_PLAN_TIMEOUT_MS = 10 * 60_000;

// how long starting another fleet may take: its daemon gets 15 s to answer, after its home is set up
const FLEET_START_TIMEOUT_MS = 20_000;

// how long robot.wait waits when not told, and the most it may: past 2^31-1 ms a timer fires at once, and a client waits a little longer
export const WAIT_DEFAULT_MS = 600_000;
export const WAIT_MAX_MS = 2_000_000_000;
// how long a move may take to rest, carry and commit a robot, past the interrupt it was asked to wait for
const MOVE_TIMEOUT_MS = 15 * 60_000;
// a check asks the worker its agents and probes its clone (an ls-remote of up to 20 s), and builds the bundle to size it
const MOVE_CHECK_TIMEOUT_MS = 3 * 60_000;
// a retry waits for the worker to take the snapshot (60 s), to start the robot (two minutes) and for the release
const MOVE_RETRY_TIMEOUT_MS = 5 * 60_000;
// how long the home waits for each of a worker's answers about its agent configuration while it builds the setup rows
export const REPORT_MS = 10_000;
// the setup rows past the wait for the link: the worker's two answers
const SETUP_REPORT_MS = 2 * REPORT_MS;
// a tick waits for the push already under way and its own, each of up to the 200 MB tree, then for the setup rows
const CONSENT_TIMEOUT_MS = 15 * 60_000;
// an agent's own update downloads its release
export const AGENT_UPDATE_MS = 5 * 60_000;
// a drop crosses the link to the robot's machine in 1 MiB parts
const DROP_TIMEOUT_MS = 10 * 60_000;

const HOME_CONNECTION_MS = 60_000;
const FREEZE_MS = 60_000;

// how long the daemon may hold a call before it answers, which a client adds to its own timeout
export const serverWait = (method: MethodName, params: unknown): number => {
  if (method === 'robot.wait') return (params as { timeoutMs?: number }).timeoutMs ?? WAIT_DEFAULT_MS;
  if (method === 'robot.create') return ((params as { run?: string }).run ? RUN_TIMEOUT_MS : 0) + ((params as { remote?: string }).remote ? CLONE_TIMEOUT_MS : 0);
  if (method === 'scribe.sweep') return SWEEP_TIMEOUT_MS;
  // a far command, its forward and a greeting through it, each with a timeout of its own
  if (method === 'home.connection' || method === 'fleet.homeCheck' || method === 'fleet.homeMove') return HOME_CONNECTION_MS;
  if (method === 'fleet.freeze') return FREEZE_MS;
  if (method === 'retro.plan') return RETRO_PLAN_TIMEOUT_MS;
  // each fix may start a robot, which waits for its agent as robot.create with a run does
  if (method === 'retro.mark') return ((params as { marks?: { action?: string }[] }).marks ?? []).filter((m) => m.action === 'fix').length * RUN_TIMEOUT_MS;
  if (method === 'mobile.set') return MOBILE_SET_TIMEOUT_MS;
  if (method === 'fleets.create' || method === 'fleets.start') return FLEET_START_TIMEOUT_MS;
  if (method === 'robot.moveTo') return MOVE_TIMEOUT_MS + ((params as { interruptAfterMs?: number }).interruptAfterMs ?? 0);
  if (method === 'robot.moveCheck') return MOVE_CHECK_TIMEOUT_MS;
  if (method === 'robot.moveRetry') return MOVE_RETRY_TIMEOUT_MS;
  if (method === 'machines.setup') return ((params as { waitMs?: number }).waitMs ?? 0) + SETUP_REPORT_MS;
  if (method === 'machines.consent' || method === 'machines.setVar' || method === 'machines.copySetupFrom') return CONSENT_TIMEOUT_MS;
  // the worker runs each update in turn, and the link takes 30 s beside them
  if (method === 'machines.updateAgents') return ((params as { kinds?: unknown[] }).kinds ?? []).length * AGENT_UPDATE_MS + 30_000;
  if (method === 'robot.drop') return DROP_TIMEOUT_MS;
  return 0;
};

export class ApiError extends Error {
  constructor(public code: string, message: string, public data?: Record<string, unknown>) { super(message); }
}

/** The raw bytes of a request each part carries, before base64; one part stays well under the daemon's 8 MiB message cap. */
export const PART_BYTES = 4 * 1024 * 1024;
/** The most a request sent in parts may come to, and an answer a client reads. */
export const MAX_REQUEST_BYTES = 256 * 1024 * 1024;

export const HelloResult = z.object({ ok: z.literal(true), protocol: z.number().int() });
export type HelloResult = z.infer<typeof HelloResult>;
// the daemon's answer to a socket it admits, which a client checks the protocol by
export const HelloReply = z.object({ id: z.literal(0), result: HelloResult });
export type HelloReply = z.infer<typeof HelloReply>;
// bump on any change an older app or daemon would misread; the handshake reply carries it
export const PROTOCOL_VERSION = 49;
