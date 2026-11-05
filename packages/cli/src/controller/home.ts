import fs from 'node:fs';
import { z } from 'zod';
import { FleetId, MachineId, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, type FleetState } from '@svall/protocol';
import { initConfig, patchFleetConfig } from '@svall/svalld/config';
import { remoteConnectionInfo } from '@svall/svalld/link/connection-info';
import { resolvePaths } from '@svall/svalld/paths';
import { svallExe } from '@svall/svalld/release';
import { shq } from '@svall/svalld/text';
import { heldAsHome, isWorker, readWorkerFile } from '@svall/svalld/worker/mode';
import type { Enrol } from '../commands/worker.js';
import type { Target } from '../target.js';
import { flow, homeProbe, remoteJson, remotePaths, StepError, type HostDeps, type HostOutcome } from './host.js';
import type { MachineRegistry } from './registry.js';
import { SshError, type SshMaster } from './ssh.js';

const ENROLL_TIMEOUT = 30_000;
const SNAPSHOT_MS = 90_000;
const POLL_MS = 500;

/** What `svall version --json` says of the fleet home there. */
const FarVersion = z.object({
  release: z.string(), machineId: MachineId, protocol: z.number().int(), stateSchema: z.number().int(), role: z.enum(['home', 'worker']).optional(),
  fleetId: FleetId.optional(), worker: z.object({ homeName: z.string() }).optional(),
});

/** What `svall fleet enroll-worker --json` answers a worker that dials in. */
const Enrolled = z.object({
  homeMachineId: MachineId, homeName: z.string(), fleetId: FleetId, socket: z.string(), token: z.string().min(32),
  homeSvallBase: z.string(), homePlatform: z.string(), homeArch: z.string(), homePath: z.string(),
});

export type JoinOptions = { ssh: string; name?: string; homeProfile?: string };

export type JoinDeps = Pick<HostDeps, 'emit' | 'openMaster' | 'interactiveSsh'> & {
  registry: MachineRegistry;
  target: Target;
  me: MachineId;
  /** where svall is installed on this machine, which the home records */
  svallBase: string;
  /** this machine's Tailscale state; rejects with why a server home cannot work from here */
  tailnet(): Promise<unknown>;
  /** worker.json written with `token`, and this fleet's daemon restarted as the worker of the home named */
  enrol(o: Enrol, token: string): Promise<void>;
  /** this fleet's state as its daemon holds it, undefined while none answers */
  state(): Promise<FleetState | undefined>;
};

/** What this fleet holds that the home's first snapshot would erase, as the refusal that stops a join before any write. */
function refuseHeld(o: JoinOptions, d: Pick<JoinDeps, 'target' | 'me'>): string {
  const paths = resolvePaths(d.target.home);
  const again = `svall -p <new fleet> fleet join ${o.ssh}`;
  if (isWorker(paths)) {
    let served: string;
    try { served = readWorkerFile(paths).homeName; } catch (e) { throw new StepError((e as Error).message, `fix ${paths.workerFile}`); }
    return served;
  }
  let held: string | undefined;
  try { held = heldAsHome(paths, d.me); } catch (e) { throw new StepError((e as Error).message, `fix ${paths.workersFile}`); }
  if (held) throw new StepError(`${d.target.home} holds ${held}, which the home's first snapshot would erase`, again);
  return '';
}

// a fleet there other than the private one is named by its profile
const farFlags = (o: JoinOptions): string[] => (o.homeProfile ? ['-p', shq(o.homeProfile)] : []);

async function identifyHome(master: SshMaster, o: JoinOptions, d: Pick<JoinDeps, 'me' | 'target'>): Promise<{ svallBase: string; id: MachineId; fleetId: FleetId; release: string }> {
  const { home } = await homeProbe(master);
  const { svallBase } = remotePaths(home, '');
  const r = await master.run([shq(svallExe(svallBase)), ...farFlags(o), 'version', '--json'], { timeoutMs: ENROLL_TIMEOUT });
  if (r.code === 126 || r.code === 127) throw new StepError(`${o.ssh} has no Svall at ${svallExe(svallBase)}`, `install Svall there and run svall setup, or add it from this Mac's Add machine`);
  const parsed = FarVersion.safeParse(await remoteJson<unknown>(master, svallBase, [...farFlags(o), 'version', '--json'], 'svall version --json'));
  if (!parsed.success) throw new StepError(`${o.ssh} answered svall version --json without a machine or a fleet`, `upgrade Svall there`);
  const far = parsed.data;
  if (far.machineId === d.me) throw new StepError(`${o.ssh} is this machine`, 'give the ssh destination of the fleet\'s home');
  if (far.protocol !== PROTOCOL_VERSION || far.stateSchema !== STATE_SCHEMA_VERSION) {
    throw new StepError(`${o.ssh} runs ${far.release} on protocol ${far.protocol}, this machine protocol ${PROTOCOL_VERSION}`, far.protocol > PROTOCOL_VERSION ? 'update Svall on this machine' : `upgrade Svall on ${o.ssh}`);
  }
  if (far.role === 'worker') throw new StepError(`the fleet there is a worker of ${far.worker?.homeName ?? 'another home'}`, `join ${far.worker?.homeName ?? 'its home'} instead`);
  const info = await remoteConnectionInfo(master, { id: far.machineId, record: { name: o.ssh, svallBase } }, { ...(o.homeProfile && { profile: o.homeProfile }) }).catch((e: Error) => {
    throw new StepError(e.message, e instanceof SshError && e.kind === 'daemon_down' ? `start the fleet's daemon there: ssh ${o.ssh}, then svall setup` : undefined);
  });
  return { svallBase, id: far.machineId, fleetId: info.fleetId, release: far.release };
}

/**
 * `svall fleet join`: this fleet, empty, becomes a worker of the home at `ssh`, which dials nothing back. Refuses a fleet that
 * holds anything before any write; the token the home issues goes to worker.json alone, and the join ends on the first snapshot.
 */
export function joinHome(o: JoinOptions, d: JoinDeps): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    const served = await run.step('fleet', () => {
      const of = refuseHeld(o, d);
      return Promise.resolve({ value: of, detail: of ? `${d.target.home} serves ${of} as a worker, whose token this renews` : `${d.target.home} holds nothing a snapshot would erase` });
    });
    await run.step('tailscale', async () => {
      await d.tailnet().catch((e: Error) => { throw new StepError(`a fleet on a server needs Tailscale on both machines: ${e.message}`, 'install Tailscale from https://tailscale.com/download and sign in'); });
      return { value: undefined, detail: 'connected' };
    });
    await run.step('ssh', async () => {
      const { code, stderr } = await d.interactiveSsh(o.ssh);
      if (code !== 0) throw new StepError(`ssh ${o.ssh} exited ${code}${stderr ? `: ${stderr}` : ''}`, `run ssh ${o.ssh} once in Terminal and answer its host key and login there, then join again`);
      return { value: undefined, detail: `${o.ssh} accepted an interactive login` };
    });
    const master = await run.step('master', async () => {
      try {
        return { value: await d.openMaster(o.ssh), detail: `connected to ${o.ssh}` };
      } catch (e) {
        if (e instanceof SshError && e.kind === 'auth') throw new StepError(`ssh refused the login to ${o.ssh}: this Mac's daemon logs in without a password or passphrase prompt`, `install a key there with ssh-copy-id ${o.ssh}, then join again`);
        throw new StepError((e as Error).message, `ssh ${o.ssh} and see what it answers`);
      }
    });
    try {
      const home = await run.step('home', async () => {
        const found = await identifyHome(master, o, d);
        const paths = resolvePaths(d.target.home);
        if (served && readWorkerFile(paths).fleetId !== found.fleetId) throw new StepError(`${d.target.home} serves ${served} as a worker, whose robots here this home would close`, `svall -p <new fleet> fleet join ${o.ssh}`);
        return { value: found, detail: `${o.ssh} is machine ${found.id}, the home of fleet ${found.fleetId}, on ${found.release}` };
      });
      const here = d.registry.localMachine();
      const enrolled = await run.step('enrol', async () => {
        const r = await master.run([
          shq(svallExe(home.svallBase)), ...farFlags(o), '--json', 'fleet', 'enroll-worker', shq(d.me), '--name', shq(o.name ?? here.name),
          '--platform', shq(here.platform), '--arch', shq(here.arch), '--home', shq(here.home), '--svall-base', shq(d.svallBase),
        ], { timeoutMs: ENROLL_TIMEOUT });
        // the answer holds the token, so only what ssh said is quoted back
        if (r.code !== 0) throw new StepError(`svall fleet enroll-worker there exited ${r.code ?? `on ${r.signal}`}: ${r.stderr.trim().replace(/^svall: /, '').slice(0, 400) || 'no output'}`, /already in the registry/.test(r.stderr) ? `svall fleet join ${o.ssh} --name <another name>` : undefined);
        let answer: z.infer<typeof Enrolled>;
        try { answer = Enrolled.parse(JSON.parse(r.stdout)); } catch { throw new StepError('svall fleet enroll-worker there did not answer what a worker enrols with', `upgrade Svall on ${o.ssh}`); }
        if (answer.fleetId !== home.fleetId || answer.homeMachineId !== home.id) throw new StepError(`${o.ssh} issued a token for another fleet or machine than it answered as`, `ssh ${o.ssh} and see which fleet runs there`);
        return { value: answer, detail: `${answer.homeName} issued this machine a token` };
      });
      await run.step('worker', async () => {
        const paths = resolvePaths(d.target.home);
        // the fleet goes by its home's id from here, which `svall --host` and an upgrade compare; an empty fleet has nothing under its own
        try {
          fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
          initConfig(paths);
          patchFleetConfig(paths.fleetConfig, { id: enrolled.fleetId });
          await d.enrol({
            homeMachine: enrolled.homeMachineId, homeName: enrolled.homeName, fleetId: enrolled.fleetId, homeSsh: o.ssh, homeSocket: enrolled.socket,
            homeSvallBase: enrolled.homeSvallBase, homePlatform: enrolled.homePlatform, homeArch: enrolled.homeArch, homePath: enrolled.homePath,
          }, enrolled.token);
        } catch (e) {
          throw new StepError((e as Error).message);
        }
        return { value: undefined, detail: `this fleet's daemon runs as a worker of ${enrolled.homeName}` };
      });
      await run.step('snapshot', async () => {
        for (const until = Date.now() + SNAPSHOT_MS; Date.now() < until; await new Promise((r) => setTimeout(r, POLL_MS))) {
          const state = await d.state().catch(() => undefined);
          if ((state?.machines?.[enrolled.homeMachineId]?.snapshot?.version ?? 0) > 0) return { value: undefined, detail: `${enrolled.homeName}'s fleet is here` };
        }
        throw new StepError(`${enrolled.homeName} sent no snapshot in ${SNAPSHOT_MS / 1000} s`, `svall doctor, and svall host doctor ${enrolled.homeName}`);
      });
    } finally {
      await master.close().catch(() => undefined);
    }
  });
}
