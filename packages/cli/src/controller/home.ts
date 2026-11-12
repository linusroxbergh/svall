import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AdoptAnswer, ApiError, CONFIG_WORD, crewAway, FleetId, homeMoveStands, INTERRUPT_ACTIONS, keyLabel, keyMask, MachineId, MachineRecord, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, WorkerFile, type Enrolment, type FleetState, type HomeDelivery, type HomeFacts, type HomeManifest, type HomeMoveId, type HomeMoving, type HomeSheet, type Refusal } from '@svall/protocol';
import { readFleetConfig } from '@svall/svalld/config';
import { HomeCrash, homePoint } from '@svall/svalld/failpoints';
import { markedThere } from '@svall/svalld/fleet/home-far';
import { abortAdopt, adoptDir, carriedWorkers, driverAdoptKey, driverKey, enter, installAdopt, journalLines, markKey, MAX_ARCHIVE, mintAdoptKey, moveOutcome, oldHomeName, owe, packFleet, readManifest, readMarker, readOwed, stageAdopt, writeEnrol, type AdoptDeps, type Asker, type HomeDaemon } from '@svall/svalld/fleet/home-move';
import { newHomeMoveId } from '@svall/svalld/ids';
import { kickstart } from '@svall/svalld/launchd';
import { remoteConnectionInfo } from '@svall/svalld/link/connection-info';
import { realRun, stopUnit } from '@svall/svalld/linux/service';
import { serveAsWorker, svalldUnitName, unitDirOf } from '@svall/svalld/linux/setup';
import { dialSocket, dialSocketTooLong, fleetHomeOfSocket, resolvePaths, type Paths } from '@svall/svalld/paths';
import { profileLabel } from '@svall/svalld/profile';
import { installPrefix, svallExe } from '@svall/svalld/release';
import { ownRuntime } from '@svall/svalld/runtime';
import { shq } from '@svall/svalld/text';
import { heldAsHome, isWorker, readWorkerFile } from '@svall/svalld/worker/mode';
import { DEFAULT_PREFIX } from '../../../../scripts/install-release.mjs';
import { Client, withClient } from '../client.js';
import type { Enrol } from '../commands/worker.js';
import { PRIVATE } from '@svall/svalld/profile';
import { workerProfile } from '@svall/svalld/placement/workers';
import { farProfile, type Target } from '../target.js';
import { flow, homeProbe, remoteJson, remotePaths, StepError, tailnetHere, unreached, type HostDeps, type HostOutcome, type Runner } from './host.js';
import type { MachineEntry, MachineRegistry } from './registry.js';
import { classifySsh, inFull, SshError, type SshMaster } from './ssh.js';

const execFileP = promisify(execFile);
const ANSWER_MS = 60_000;
const TOLD_MS = 60_000;

const ENROLL_TIMEOUT = 30_000;
const SNAPSHOT_MS = 90_000;
// a command for this fleet, by the -p that names it
const svallOf = (t: Target, args: string): string => { const p = farProfile(t); return `svall ${p ? `-p ${p} ` : ''}${args}`; };
const WORKERS_MS = 60_000;
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

type JoinOptions = { ssh: string; name?: string; homeProfile?: string };

export type JoinDeps = Pick<HostDeps, 'emit' | 'openMaster' | 'interactiveSsh' | 'tailnet'> & {
  registry: MachineRegistry;
  target: Target;
  me: MachineId;
  /** where svall is installed on this machine, which the home records */
  svallBase: string;
  /** worker.json written with `token`, and this fleet's daemon restarted as the worker of the home named */
  enrol(o: Enrol, token: string): Promise<void>;
  /** this fleet's state as its daemon holds it, undefined while none answers */
  state(): Promise<FleetState | undefined>;
  /** whether to copy this machine's agent setup to the home; none where no person can be asked, whose window offers it */
  ask?: SeedAsk;
  /** the daemon here, and the home's over `master` */
  seedClients(master: SshMaster, home: { id: MachineId; fleetId: FleetId; svallBase: string; ssh: string }): Promise<{ here: SeedClient; far: SeedClient; close(): Promise<void> }>;
};

type SeedClient = Pick<Client, 'call'>;
/** `go` whether to copy at all; `key` whether to send one ticked key row, by what it asks. */
export type SeedAsk = { go(name: string): Promise<boolean>; key(said: string, preview: string[]): Promise<boolean> };

/**
 * A home with no agent setup yet takes this machine's first, through the one Copy there is, with what each key row asks of a person; a home
 * that holds one is left as it is. What this comes to is a step's outcome: the join stands whatever it says.
 */
export async function seedHome(o: { here: SeedClient; far: SeedClient; me: MachineId; name: string; ask?: SeedAsk }): Promise<{ value: undefined; status?: 'warn'; detail: string }> {
  const me = thisMachine();
  if ((await o.far.call('machines.holdsSetup', {})).holds) return { value: undefined, detail: `${o.name} holds an agent setup of its own, which ${me} takes from there` };
  if (!(await o.here.call('machines.holdsSetup', {})).holds) return { value: undefined, detail: 'no agent setup here to copy' };
  if (!o.ask) return { value: undefined, status: 'warn', detail: `${o.name} has no agent setup yet; Svall's window offers to copy ${me}'s there` };
  if (!await o.ask.go(o.name)) return { value: undefined, detail: `${o.name} stays without an agent setup; Settings → Agent setup copies ${me}'s whenever you want` };
  const { rows } = await o.here.call('home.setup', {});
  // a tick stored earlier is asked too, and a no takes it back, as what the Copy sends is what stands ticked as it reads
  for (const r of rows) {
    const t = r.tick!;
    const yes = await o.ask.key(`Send ${o.name} ${keyLabel(r)}`, [keyMask(r)].filter((m) => m !== undefined));
    if (yes !== t.on || (!yes && t.ticked?.length)) await o.here.call('home.setupConsent', { item: t.item, fields: t.fields, on: yes });
  }
  const { sent, backup } = await o.far.call('machines.copySetupFrom', { machine: o.me, seed: true });
  return { value: undefined, detail: `${sent} files of ${me}'s agent setup copied to ${o.name}${backup ? `; what it replaced there is in ${backup}` : ''}` };
}

/** What this fleet holds that the home's first snapshot would erase, as the refusal that stops a join before any write. */
function refuseHeld(o: JoinOptions, d: Pick<JoinDeps, 'target' | 'me'>): string {
  const paths = resolvePaths(d.target.home);
  const again = `svall -p <new fleet> fleet join ${o.ssh}`;
  if (isWorker(paths)) {
    let served: string;
    try { served = readWorkerFile(paths).homeName; } catch (e) { throw new StepError(`${paths.workerFile} cannot be read`, `fix ${paths.workerFile}`, undefined, undefined, (e as Error).message); }
    return served;
  }
  let held: string | undefined;
  try { held = heldAsHome(paths, d.me); } catch (e) { throw new StepError(`${paths.workersFile} cannot be read`, `fix ${paths.workersFile}`, undefined, undefined, (e as Error).message); }
  if (held) throw new StepError(`this fleet holds ${held}, which the home's first snapshot would erase`, again);
  return '';
}

// a fleet there other than the private one is named by its profile
const farFlags = (o: JoinOptions): string[] => (o.homeProfile ? ['-p', shq(o.homeProfile)] : []);

async function identifyHome(master: SshMaster, o: JoinOptions, d: Pick<JoinDeps, 'me' | 'target'>): Promise<{ svallBase: string; id: MachineId; fleetId: FleetId; release: string }> {
  const { home } = await homeProbe(master);
  const { svallBase } = remotePaths(home, '');
  const r = await master.run([shq(svallExe(svallBase)), ...farFlags(o), 'version', '--json'], { timeoutMs: ENROLL_TIMEOUT });
  if (r.code === 126 || r.code === 127) throw new StepError(`${o.ssh} has no Svall at ${svallExe(svallBase)}`, `install Svall there and run svall setup, or add it under Machines in Svall's window`);
  const parsed = FarVersion.safeParse(await remoteJson<unknown>(master, svallBase, [...farFlags(o), 'version', '--json'], 'svall version --json'));
  if (!parsed.success) throw new StepError(`${o.ssh} answered svall version --json without a machine or a fleet`, `upgrade Svall there`);
  const far = parsed.data;
  if (far.machineId === d.me) throw new StepError(`${o.ssh} is ${thisMachine()}`, 'give the ssh destination of the fleet\'s home');
  if (far.protocol !== PROTOCOL_VERSION || far.stateSchema !== STATE_SCHEMA_VERSION) {
    throw new StepError(`${o.ssh} runs ${far.release}, which cannot talk to ${thisMachine()}'s`, far.protocol > PROTOCOL_VERSION ? `update Svall on ${thisMachine()}` : `upgrade Svall on ${o.ssh}`,
      undefined, undefined, `protocol ${far.protocol} and state schema ${far.stateSchema} there, ${PROTOCOL_VERSION} and ${STATE_SCHEMA_VERSION} here`);
  }
  if (far.role === 'worker') throw new StepError(`the fleet there is a worker of ${far.worker?.homeName ?? 'another home'}`, `join ${far.worker?.homeName ?? 'its home'} instead`);
  const { tailscale } = await remoteJson<HomeFacts>(master, svallBase, [...farFlags(o), '--json', 'fleet', 'facts'], 'svall fleet facts');
  if (!tailscale?.host) {
    const said = tailscale?.error ?? 'no name on the tailnet';
    if (tailscale?.state === 'stopped') throw new StepError(`Tailscale is not running on ${o.ssh}`, `start it: ssh ${o.ssh}, then sudo systemctl start tailscaled`, 'sudo systemctl start tailscaled', undefined, said);
    throw new StepError(`${o.ssh} is not on the tailnet`, `ssh ${o.ssh}, then install Tailscale from https://tailscale.com/download/linux and sign in with sudo tailscale up`, undefined, undefined, said);
  }
  const info = await remoteConnectionInfo(master, { id: far.machineId, record: { name: o.ssh, svallBase } }, { ...(o.homeProfile && { profile: o.homeProfile }) }).catch((e: Error) => {
    if (e instanceof SshError && e.kind === 'daemon_down') throw new StepError(`Svall's background service is not running on ${o.ssh}`, `start it there: ssh ${o.ssh}, then svall setup`, undefined, undefined, inFull(e));
    throw new StepError(e.message, undefined, undefined, undefined, e instanceof SshError ? e.raw : undefined);
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
      const destination = MachineRecord.shape.ssh.unwrap().safeParse(o.ssh);
      if (!destination.success) throw new StepError(`${o.ssh} is not an ssh destination`, undefined, undefined, undefined, destination.error.issues[0].message);
      const of = refuseHeld(o, d);
      return Promise.resolve({ value: of, detail: of ? `this fleet serves ${of} as a worker, and joins it again` : "this fleet holds no robot, worker or note; its island names and board columns go with the home's first snapshot" });
    });
    await run.step('tailscale', () => tailnetHere(d));
    await run.step('ssh', async () => {
      const { code, stderr } = await d.interactiveSsh(o.ssh);
      if (code !== 0) {
        throw new StepError(['auth', 'host_key'].includes(classifySsh(stderr)) ? `${thisMachine()} cannot log in to ${o.ssh}` : `${o.ssh} is not reachable from ${thisMachine()}`,
          `run ssh ${o.ssh} once in Terminal and answer its host key and login there, then join again`, undefined, undefined, `ssh ${o.ssh} exited ${code}${stderr ? `: ${stderr}` : ''}`);
      }
      return { value: undefined, detail: 'logs in' };
    });
    const master = await run.step('master', async () => {
      try {
        return { value: await d.openMaster(o.ssh), detail: 'connected' };
      } catch (e) {
        // the login above asked its questions; this fleet's own logins there ask none
        throw unreached(e, o.ssh, o.ssh, thisMachine(), `install a key there with ssh-copy-id ${o.ssh}, then join again`);
      }
    });
    try {
      const home = await run.step('home', async () => {
        const found = await identifyHome(master, o, d);
        const paths = resolvePaths(d.target.home);
        if (served && readWorkerFile(paths).fleetId !== found.fleetId) throw new StepError(`this fleet serves ${served} as a worker, whose robots here this home would close`, `svall -p <new fleet> fleet join ${o.ssh}`);
        return { value: found, detail: `${o.ssh} is the fleet's home, on release ${found.release}`, raw: `machine ${found.id}, fleet ${found.fleetId}` };
      });
      const here = d.registry.localMachine();
      const enrolled = await run.step('enrol', async () => {
        const r = await master.run([
          shq(svallExe(home.svallBase)), ...farFlags(o), '--json', 'fleet', 'enroll-worker', shq(d.me), '--keep-token', '--name', shq(o.name ?? here.name),
          '--platform', shq(here.platform), '--arch', shq(here.arch), '--home', shq(here.home), '--svall-base', shq(d.svallBase),
        ], { timeoutMs: ENROLL_TIMEOUT });
        // the answer holds the token, so only what ssh said is quoted back
        if (r.code !== 0) {
          throw new StepError(`${o.ssh} did not take ${thisMachine()} as a worker`, /already in the registry/.test(r.stderr) ? `svall fleet join ${o.ssh} --name <another name>` : undefined,
            undefined, undefined, `svall fleet enroll-worker there exited ${r.code ?? `on ${r.signal}`}: ${r.stderr.trim().replace(/^svall: /, '').slice(0, 400) || 'no output'}`);
        }
        let answer: z.infer<typeof Enrolled>;
        try { answer = Enrolled.parse(JSON.parse(r.stdout)); } catch { throw new StepError('svall fleet enroll-worker there did not answer what a worker enrols with', `upgrade Svall on ${o.ssh}`); }
        if (answer.fleetId !== home.fleetId || answer.homeMachineId !== home.id) throw new StepError(`${o.ssh} issued a token for another fleet or machine than it answered as`, `ssh ${o.ssh} and see which fleet runs there`);
        // this machine's registry names the home where it holds a record, as its window does; the home's own name only where it holds none
        const named = { ...answer, homeName: d.registry.get(answer.homeMachineId)?.record.name ?? answer.homeName };
        return { value: named, detail: `${named.homeName} issued ${thisMachine()} a token` };
      });
      // a join run again finds the last one's snapshot, which says nothing of this one
      const since = Date.now();
      await run.step('worker', async () => {
        // the fleet goes by its home's id from here, which `svall --host` and an upgrade compare; an empty fleet has nothing under its own
        try {
          // a fleet that was a home keeps no record of what a Copy wrote here, which the first push must not read as its own
          if (!served) fs.rmSync(resolvePaths(d.target.home).mirrorState, { force: true });
          await d.enrol({
            homeMachine: enrolled.homeMachineId, homeName: enrolled.homeName, fleetId: enrolled.fleetId, homeSsh: o.ssh, homeSocket: enrolled.socket,
            homeSvallBase: enrolled.homeSvallBase, homePlatform: enrolled.homePlatform, homeArch: enrolled.homeArch, homePath: enrolled.homePath, takesFleetId: true, homeProfile: o.homeProfile ?? PRIVATE,
          }, enrolled.token);
        } catch (e) {
          throw new StepError(`this fleet did not start as a worker of ${enrolled.homeName}`, `${svallOf(d.target, 'doctor')} says why`, undefined, undefined, (e as Error).message);
        }
        return { value: undefined, detail: `this fleet is a worker of ${enrolled.homeName}` };
      });
      await run.step('snapshot', async () => {
        for (const until = Date.now() + SNAPSHOT_MS; Date.now() < until; await new Promise((r) => setTimeout(r, POLL_MS))) {
          const snapshot = (await d.state().catch(() => undefined))?.machines?.[enrolled.homeMachineId]?.snapshot;
          if (snapshot && snapshot.version > 0 && snapshot.at >= since) {
            fs.rmSync(resolvePaths(d.target.home).joining, { force: true });
            return { value: undefined, detail: `${enrolled.homeName}'s fleet is here` };
          }
        }
        throw new StepError(`${enrolled.homeName} sent no snapshot in ${SNAPSHOT_MS / 1000} s`, `${svallOf(d.target, 'doctor')}, and ${svallOf(d.target, `host doctor ${enrolled.homeName}`)}`);
      });
      await run.step('seed', async () => {
        const name = enrolled.homeName;
        try {
          const { here, far, close } = await d.seedClients(master, { id: enrolled.homeMachineId, fleetId: enrolled.fleetId, svallBase: home.svallBase, ssh: o.ssh });
          try {
            return await seedHome({ here, far, me: d.me, name, ...(d.ask && { ask: d.ask }) });
          } finally {
            await close().catch(() => undefined);
          }
        } catch (e) {
          return { value: undefined, status: 'warn' as const, detail: `${thisMachine()}'s agent setup was not copied to ${name}; Settings → Agent setup copies it from there`, raw: (e as Error).message };
        }
      });
    } finally {
      await master.close().catch(() => undefined);
    }
  });
}

// ------------------------------------------------------------------------------------- the machine taking the fleet

/** How a command stops and starts this fleet's daemon: its unit on Linux, its launchd job on a Mac. A fleet with neither is run by hand, which a move does not manage. */
export function realHomeDaemon(t: Target): HomeDaemon {
  const unit = svalldUnitName(t.name);
  const label = `gui/${os.userInfo().uid}/${profileLabel(t.name)}`;
  return {
    stop: async () => {
      if (process.platform === 'linux') await stopUnit(realRun, unit);
      else await execFileP('launchctl', ['kill', 'SIGTERM', label]).catch(() => undefined);
    },
    start: async () => {
      if (process.platform === 'linux') await serveAsWorker({ runtime: ownRuntime(), homedir: os.homedir(), prefix: DEFAULT_PREFIX, unitDir: unitDirOf(os.homedir()), fleet: t.name, home: t.home, run: realRun });
      else await kickstart([profileLabel(t.name)]);
    },
    answersHome: async (fleetId) => {
      for (const until = Date.now() + ANSWER_MS; Date.now() < until; await new Promise((r) => setTimeout(r, POLL_MS))) {
        const home = await withClient(() => Client.connect(t.home), (c) => c.call('fleet.home', {})).catch(() => undefined);
        if (home?.mine && home.fleetId === fleetId) return true;
      }
      return false;
    },
  };
}

/** What the machine taking the fleet tells the one it leaves. `ssh`: the way that machine dials this one; none where this one dials it. */
export function enrolmentFor(paths: Paths, me: MachineId, o: { ssh?: string; home: MachineRecord; profile?: string }): (token: string, m: HomeManifest) => Enrolment {
  return (token, m) => {
    const long = o.ssh && dialSocketTooLong(dialSocket(paths, m.from), m.record.platform);
    if (long) throw new Error(`${long.message}, so ${m.record.name} cannot dial into ${paths.home}; use an account whose home is ${long.over} bytes shorter`);
    return {
      worker: WorkerFile.parse({
        homeMachineId: me, fleetId: m.fleetId, token, homeName: m.toName, homePlatform: o.home.platform, ...(o.profile && { homeProfile: o.profile }),
        ...(o.ssh && { homeSsh: o.ssh, homeSocket: dialSocket(paths, m.from), homeSvallBase: installPrefix() }),
      }),
      // by the name the fleet has known it by
      ...(o.ssh && { home: { ...o.home, name: m.toName, ssh: o.ssh } }),
    };
  };
}

// ------------------------------------------------------------------------------------------------- the move's driver

const STEP_MS = 180_000;
const SETTLE_TRIES = 6;

export type MoveDeps = Pick<HostDeps, 'emit' | 'openMaster'> & {
  registry: MachineRegistry;
  target: Target;
  me: MachineId;
  daemon: HomeDaemon;
  /** this fleet's daemon */
  client(): Promise<Client>;
  /** the far fleet's API over `master`, for the way back */
  farClient(master: SshMaster, entry: MachineEntry, fleetHome: string, fleetId: string): Promise<Client>;
};

const driverJournal = (paths: Paths, id: string, phase: string, data?: object): void => enter(paths, `${id}.driver`, phase, data && JSON.stringify(data));

// who asks a far machine how a move ended, which only the home it still serves can be told `not-adopted` by
const askedBy = (asker: Asker): string[] => ['--asker', asker.machine, '--fleet', asker.fleetId];
const oldHome = (owed: HomeDelivery): Asker => ({ machine: owed.from, fleetId: owed.fleetId });

const farCommand = (svallBase: string, fleetHome: string, args: string[]): string[] => ['env', shq(`SVALL_HOME=${fleetHome}`), shq(svallExe(svallBase)), '--json', ...args.map(shq)];

// what the far machine did not do of a move, by the command it was asked
const FAR_DID: Record<string, string> = { adopt: 'did not take the fleet', status: 'did not say how the move stands', abort: 'did not call the move off' };

async function farAnswer(master: SshMaster, o: { svallBase: string; fleetHome: string; name: string }, args: string[], input?: string): Promise<AdoptAnswer> {
  const r = await master.run(farCommand(o.svallBase, o.fleetHome, args), { timeoutMs: STEP_MS, ...(input !== undefined && { input }) });
  if (r.code === 255 || r.code === null) throw new SshError('unreachable', `the connection to ${o.name} went away`);
  const parsed = AdoptAnswer.safeParse((() => { try { return JSON.parse(r.stdout) as unknown; } catch { return undefined; } })());
  if (!parsed.success) {
    const did = args.includes('--stage') ? "did not stage the fleet's files" : FAR_DID[args[1]] ?? 'did not answer';
    throw new StepError(`${o.name} ${did}`, undefined, undefined, undefined, `svall fleet ${args[1]} there exited ${r.code}: ${r.stderr.trim().replace(/^svall: /, '').slice(0, 400) || 'no answer'}`);
  }
  return parsed.data;
}

// what the machine taking the fleet says of the move, as a sentence on `name`; a word for where it stands never shows bare
const standing = (a: AdoptAnswer, name: string): string => (a.status === 'not-adopted' ? `${name} called the move off` : homeMoveStands(a.status === 'pending' ? a.phase : a.status, name).replace(/\.$/, ''));
// what it said beside the phase, which goes to raw
const farSaid = (a: AdoptAnswer): string | undefined => (a.status === 'pending' || a.status === 'not-adopted' ? a.detail : undefined);

// a refusal outside any step would read as a flow that ended well
const refuse = (run: Runner, why: string, action?: string, say?: string): Promise<never> => run.step<never>('check', () => Promise.reject(new StepError(why, action, undefined, say)));

const refusalStep = (refusal: Refusal): StepError => new StepError([refusal.reason, ...(refusal.more ?? []).map((m) => m.reason)].join('; '), refusal.action, refusal.run, undefined,
  [refusal.raw, ...refusal.details].filter(Boolean).join('\n') || undefined);

// a terminal's word for what the sheet says of a path the machine taking the fleet does not have yet
const lacking = (sheet: HomeSheet, name: string): string => sheet.rewrites.filter((r) => r.lacks).map((r) => `; ${CONFIG_WORD[r.key] ?? r.key} ${r.kept ? 'is' : 'becomes'} ${r.to}, which ${name} does not have yet`).join('');
/** This machine, as its own terminal and window say it. */
export const thisMachine = (platform: NodeJS.Platform = process.platform): string => (platform === 'darwin' ? 'this Mac' : 'this machine');
// the workers that do not answer, in the sheet's words
const waiting = (sheet: HomeSheet, name: string): string => (sheet.waits ?? []).map((w) => `; ${w.name} does not answer; it joins ${name} when it does`).join('');

// the old home served the phone, as its freeze read its own records, so the new one turns the link on, which a window waits for
const servesPhone = (run: Runner, name: string): Promise<void> => run.step('phone', async () => ({ value: undefined, detail: `${name} turns the phone link on once it holds the fleet` }));

const CREW_BACK = 'svall fleet home crew-back';
// what a window says of a move left standing, where a terminal is given the commands that end it; the window's buttons end it
const NOT_FINISHED = 'The move is not finished';
const isInterrupt = (action: string): boolean => (Object.values(INTERRUPT_ACTIONS) as string[]).includes(action);

const CARRIED = 'carried';
// what the move's copy wrote down it carried, as the worker list has gone aside by the time a retry asks
const carriedBy = (paths: Paths, id: string): string[] => {
  try { return z.object({ workers: z.array(z.string()) }).parse(JSON.parse(journalLines(paths, `${id}.driver`).find((r) => r.phase === CARRIED)?.detail ?? '')).workers; } catch { return []; }
};

const crewFor = (state: FleetState, to: MachineId): FleetState['robots'][string][] => Object.values(state.robots).filter((r) => state.islands[r.islandId]?.kind === 'home' && r.machine !== to);

/** What a person chose for what a robot of mission control is running: until then, it is not interrupted. */
export type CrewChoice = { interruptAfterMs?: number };
const chosen = (o: CrewChoice): CrewChoice => (o.interruptAfterMs === undefined ? {} : { interruptAfterMs: o.interruptAfterMs });

// what each of mission control's robots answers a move there, so a refusal comes here, with nothing moved
async function checkCrew(c: Client, id: HomeMoveId, to: MachineId, o: CrewChoice, again: string): Promise<void> {
  const state = await c.call('state.get', {});
  const refused: { reason: string; action: string }[] = [];
  for (const r of crewFor(state, to)) {
    const a = await c.call('robot.moveCheck', { id: r.id, machine: to, homeMove: id, ...chosen(o) });
    if (a.ok) continue;
    for (const f of [a.refusal, ...(a.refusal.more ?? [])]) refused.push({ reason: f.reason.startsWith(r.name) ? f.reason : `${r.name}: ${f.reason}`, action: f.action });
  }
  if (!refused.length) return;
  const asks = refused.some((f) => isInterrupt(f.action));
  throw new StepError(refused.map((f) => f.reason).join('; '), asks ? `${again} --interrupt-after 0, which ends what it runs` : refused[0].action, undefined, asks ? 'Check again to choose what happens to what it runs' : undefined);
}

// mission control's robots go first, each journaled before its move, so a retry sees which landed; the daemon opens the move
// first, as its id is what lets them move, and only for this caller. `again`: what `svall fleet home set` takes to run it again
async function moveMission(run: Runner, c: Client, paths: Paths, id: HomeMoveId, to: MachineId, name: string, again: string, o: CrewChoice): Promise<void> {
  await run.step('mission', async () => {
    await c.call('fleet.homeMove', { op: 'open', id });
    const crew = crewFor(await c.call('state.get', {}), to);
    driverJournal(paths, id, 'mission', { robots: crew.map((r) => r.id) });
    for (const r of crew) {
      const moved = await c.call('robot.moveTo', { id: r.id, machine: to, homeMove: id, ...chosen(o) }).catch((e: Error) => {
        throw new StepError(`${r.name} did not move to ${name}`, `fix it, and svall fleet home set ${again} again; ${CREW_BACK} brings back the crew that moved`, undefined, 'Fix it and try again; the crew that moved can be brought back', e.message);
      });
      driverJournal(paths, id, 'mission.moved', { robot: r.id, move: moved.moveId });
    }
    return { value: undefined, ...(crew.length ? { detail: `${crew.length} of mission control's robots moved to ${name}` } : { status: 'skip' as const, detail: 'mission control runs no robot' }) };
  });
}

// a move that stopped before the mark leaves the crew that went ahead on `name`, the machine it went to, which a person may want back
async function offerCrew(run: Runner, home: Client, name: string): Promise<void> {
  const away = crewAway(await home.call('state.get', {}));
  const names = away.map((r) => r.name).join(', ');
  const say = `Mission control's ${names} ${away.length === 1 ? 'is' : 'are'} still on ${name}`;
  if (away.length) await run.step('crew', () => Promise.resolve({ value: undefined, status: 'warn' as const, detail: `mission control's ${names} stayed where the move sent them`, action: CREW_BACK, say }));
}

/** `svall fleet home crew-back`: mission control's robots a move left away from the home go back to it through the move engine; each that cannot says why. */
export function bringCrewBack(d: MoveDeps, o: CrewChoice = {}): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    const paths = resolvePaths(d.target.home);
    let master: SshMaster | undefined;
    const worker = isWorker(paths) ? readWorkerFile(paths) : undefined;
    const entry = worker && d.registry.get(worker.homeMachineId);
    const home = await run.step('check', async () => {
      if (!worker) return { value: await d.client(), detail: `${thisMachine()} is the home` };
      if (!worker.homeSsh || !worker.homeSocket || !entry) throw new StepError(`${worker.homeName} dials ${thisMachine()}, so its crew is moved from there`);
      const ssh = worker.homeSsh;
      master = await d.openMaster(ssh).catch((e: Error) => { throw unreached(e, worker.homeName, ssh, thisMachine()); });
      return { value: await d.farClient(master, entry, fleetHomeOfSocket(worker.homeSocket), worker.fleetId), detail: `asked ${worker.homeName}` };
    });
    try {
      await run.step('crew', async () => {
        const away = crewAway(await home.call('state.get', {}));
        if (!away.length) return { value: undefined, status: 'skip' as const, detail: 'mission control\'s robots are all on the home' };
        const id = newHomeMoveId() as HomeMoveId;
        await home.call('fleet.homeMove', { op: 'open', id });
        const { machine } = await home.call('fleet.home', {});
        const stuck: { name: string; why: string }[] = [];
        // the interrupt a robot at work asks for, which a window offers as the choice its next press carries
        let asks: string | undefined;
        for (const r of away) {
          await home.call('robot.moveTo', { id: r.id, machine, homeMove: id, ...chosen(o) }).catch((e: Error) => {
            stuck.push({ name: r.name, why: e.message });
            const refusal = e instanceof ApiError ? e.data?.refusal as Refusal | undefined : undefined;
            asks ??= refusal && [refusal, ...refusal.more ?? []].find((b) => isInterrupt(b.action))?.action;
          });
        }
        if (stuck.length) {
          throw new StepError(`${stuck.map((s) => s.name).join(', ')} cannot come back`, `try again once what they name is fixed; ${CREW_BACK} --interrupt-after 0 ends what they run`, undefined, asks ?? 'Try again once what they name is fixed',
            stuck.map((s) => `${s.name}: ${s.why}`).join('\n'));
        }
        return { value: undefined, detail: `${away.map((r) => r.name).join(', ')} came back` };
      });
    } finally {
      home.close();
      await master?.close().catch(() => undefined);
    }
  });
}

/** `svall fleet home set <machine>`: this home's fleet moves to the machine, and this machine becomes its worker that dials in. */
export function moveHomeOut(machine: string, d: MoveDeps, o: CrewChoice = {}): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    const paths = resolvePaths(d.target.home);
    const entry = d.registry.get(machine);
    if (!entry || !entry.record.ssh) return refuse(run, `no machine ${machine} with an ssh destination in the registry`, 'add it under Machines first');
    const name = entry.record.name;
    const to = entry.id;
    const ssh = entry.record.ssh;
    const toHome = entry.record.home;
    const id = newHomeMoveId() as HomeMoveId;
    const fleetId = readFleetConfig(paths).id;
    const asking = askedBy({ machine: d.me, fleetId });
    const client = await d.client();
    let marked = false;
    let master: SshMaster | undefined;
    let farHome = '';
    const far = (args: string[], input?: string): Promise<AdoptAnswer> => farAnswer(master!, { svallBase: entry.record.svallBase, fleetHome: farHome, name }, args, input);
    try {
      await run.step('check', async () => {
        const c = await client.call('fleet.homeCheck', { to });
        if (!c.ok) throw refusalStep(c.refusal);
        // before anything moves: a machine this one cannot log in to stops here, with mission control where it is
        master = await d.openMaster(ssh).catch((e: Error) => { throw unreached(e, name, ssh, thisMachine()); });
        // the fleet there by the folder it answers from: its profile there need not be the one it has here
        const there = workerProfile(paths, to) ?? farProfile(d.target);
        farHome = (await remoteConnectionInfo(master, entry, { ...(there && there !== PRIVATE && { profile: there }) })).fleetHome;
        await checkCrew(client, id, to, o, `svall fleet home set ${name}`);
        return { value: undefined, detail: `${c.sheet.here} robots stay here, ${c.sheet.there} on ${name}${lacking(c.sheet, name)}${waiting(c.sheet, name)}` };
      });
      driverJournal(paths, id, 'check');
      await moveMission(run, client, paths, id, to, name, name, o);
      driverJournal(paths, id, 'pause');
      const { phone } = await run.step('pause', async () => ({ value: await client.call('fleet.freeze', { id, to }), detail: 'paused' }));
      if (phone.serving) await servesPhone(run, name);
      homePoint('move.paused');
      const adoptKeySha256 = mintAdoptKey(paths, id);
      driverJournal(paths, id, 'copy');
      await run.step('copy', async () => {
        const here = d.registry.localMachine();
        const carried = carriedWorkers(paths, d.registry.list(), d.target.name);
        if (!carried) throw new StepError(`${paths.workersFile} cannot be read, so which workers this move carries is not known`, `fix ${paths.workersFile}`);
        driverJournal(paths, id, CARRIED, { workers: carried.filter((w) => w.id !== to).map((w) => w.id) });
        const manifest: HomeManifest = { id, fleetId, from: d.me, to, toName: name, toHome: toHome as HomeManifest['toHome'], record: { ...here, svallBase: installPrefix(), dial: 'worker' }, phone, adoptKeySha256, ...(d.target.managed && { fromProfile: d.target.name }), workers: carried.filter((w) => w.id !== to) };
        const { bytes, sha256 } = await packFleet(paths, manifest);
        const a = await far(['fleet', 'adopt', id, '--stage', '--sha256', sha256], bytes.toString('base64'));
        if (a.status !== 'pending' || a.phase !== 'staged') throw new StepError(`${name} did not stage the fleet's files: ${standing(a, name)}`, undefined, undefined, undefined, farSaid(a));
        return { value: undefined, detail: `the fleet's files are on ${name}`, raw: `${bytes.length} bytes checked and staged` };
      });
      homePoint('move.copied');
      const keySha256 = markKey(paths, id);
      await run.step('mark', async () => {
        const here = d.registry.localMachine();
        await client.call('fleet.homeMove', { op: 'mark', marker: {
          id, fleetId, from: d.me, fromName: here.name, fromHome: here.home as HomeMoving['fromHome'], to, toName: name, toHome: toHome as HomeMoving['toHome'], at: Date.now(), keySha256,
          ask: { ssh, svallBase: entry.record.svallBase as never, fleetHome: farHome as never },
        } });
        marked = true;
        return { value: undefined, detail: 'handed over' };
      });
      homePoint('move.marked');
      await finishOut(run, d, client, paths, id, { to, name, ssh, asking, ends: NOT_FINISHED }, far);
    } catch (e) {
      // before the marker nothing can be adopted, so this home thaws whatever the far side heard; from the marker on, only that side's answer does
      if (!marked && !(e instanceof HomeCrash)) {
        await client.call('fleet.thaw', { id }).catch(() => undefined);
        // no folder named yet: nothing went there to call off, and no env would name a fleet
        if (master && farHome) await far(['fleet', 'abort', id, ...asking]).catch(() => undefined);
        fs.rmSync(adoptDir(paths, id), { recursive: true, force: true });
        driverJournal(paths, id, 'aborted');
        await offerCrew(run, client, name).catch(() => undefined);
      }
      throw e;
    } finally {
      client.close();
      await master?.close().catch(() => undefined);
    }
  });
}

// the far machine's adopt, this home's join and the first snapshot that proves it: the end of a move, on its first run and on a
// retry. `ends`: what a window says of a move left standing
async function finishOut(run: Runner, d: MoveDeps, client: Client, paths: Paths, id: HomeMoveId, o: { to: MachineId; name: string; ssh: string; asking: string[]; ends: string }, far: (args: string[], input?: string) => Promise<AdoptAnswer>): Promise<void> {
  driverJournal(paths, id, 'adopt');
  const enrol = await run.step('adopt', async () => {
    const key = driverAdoptKey(paths, id);
    if (!key) throw new StepError(`${thisMachine()}'s journal holds no key of this move, so ${o.name} cannot take the fleet`, 'svall fleet home abort', undefined, o.ends, id);
    // the key on stdin, and only now that this home is marked
    const answer = await far(['fleet', 'adopt', id, '--home-ssh', o.ssh], key).catch(async (e: Error) => settleAcross(far, id, o, e));
    if (answer.status === 'adopted') return { value: answer.enrol, detail: `${o.name} runs the fleet` };
    // a start of this daemon took the outcome first, and has joined
    if (answer.status === 'done') return { value: undefined, detail: `${o.name} runs the fleet` };
    throw new StepError(`${o.name} did not take the fleet: ${standing(answer, o.name)}`, 'svall fleet home abort, or svall fleet home retry', undefined, o.ends, farSaid(answer));
  });
  driverJournal(paths, id, 'join');
  await run.step('join', async () => {
    if (enrol) {
      const key = driverKey(paths, id);
      if (!key) throw new StepError(`${thisMachine()}'s journal holds no key of this move; Svall's background service asks ${o.name} itself`, undefined, undefined, undefined, id);
      await client.call('fleet.homeMove', { op: 'join', id, enrol, key }).catch(() => writeEnrol(paths, id, enrol, key));
      await d.daemon.start();
    }
    return { value: undefined, detail: `${thisMachine()} is its worker` };
  });
  homePoint('move.joined');
  await run.step('probe', async () => {
    const state = await firstSnapshot(d.client, o.to);
    if (!state) {
      throw new StepError(`${o.name} sent ${thisMachine()} no snapshot in ${SNAPSHOT_MS / 1000} s`, `svall doctor; ${thisMachine()}'s robots are safe and keep running`, undefined, `${thisMachine()}'s robots are safe and keep running; Check under Machines says what is wrong`);
    }
    driverJournal(paths, id, 'done');
    return { value: undefined, detail: `The fleet runs on ${o.name}. Open the phone from its new QR code once.` };
  });
  await workersJoin(run, d, carriedBy(paths, id), o.name);
}

// the fleet has moved whatever this finds: a worker still out is its new home's, and its row says why. A move that carried none has nothing to wait for
async function workersJoin(run: Runner, d: Pick<MoveDeps, 'client'>, carried: string[], home: string): Promise<void> {
  await run.step('workers', async () => {
    if (!carried.length) return { value: undefined, status: 'skip' as const, detail: 'this move carried no other worker' };
    // what the fleet says of each, and none where that cannot be read
    const out = async () => {
      const machines = (await withClient(d.client, (c) => c.call('state.get', {})).catch(() => undefined))?.machines;
      return machines && carried.flatMap((m) => (machines[m as MachineId]?.reachable ? [] : [machines[m as MachineId]?.name ?? m]));
    };
    let left = await out();
    for (const until = Date.now() + WORKERS_MS; (left === undefined || left.length > 0) && Date.now() < until; left = await out()) await new Promise((r) => setTimeout(r, POLL_MS));
    if (left === undefined) return { value: undefined, status: 'warn' as const, detail: `the fleet did not say whether the other workers have joined ${home}; their rows under Machines say` };
    return left.length
      ? { value: undefined, status: 'warn' as const, detail: `${left.join(', ')} has not joined ${home} yet; its row under Machines says why` }
      : { value: undefined, detail: `every other worker runs under ${home}` };
  });
}

// the far side's word, after a connection that went away during its adopt
async function settleAcross(far: (args: string[]) => Promise<AdoptAnswer>, id: string, o: { name: string; asking: string[]; ends: string }, first: Error): Promise<AdoptAnswer> {
  let last = first;
  for (let n = 0; n < SETTLE_TRIES; n++) {
    await new Promise((r) => setTimeout(r, 2000 * (n + 1)));
    try {
      const a = await far(['fleet', 'status', id, ...o.asking]);
      if (a.status !== 'pending' || a.phase !== 'running') return a;
    } catch (e) { last = e as Error; }
  }
  throw new StepError(`${o.name} does not answer`, 'svall fleet home retry once it does; until then this home stays frozen', undefined, o.ends, last.message);
}

async function firstSnapshot(client: () => Promise<Client>, home: MachineId): Promise<FleetState | undefined> {
  for (const until = Date.now() + SNAPSHOT_MS; Date.now() < until; await new Promise((r) => setTimeout(r, POLL_MS))) {
    const state = await withClient(client, (c) => c.call('state.get', {})).catch(() => undefined);
    if ((state?.machines?.[home]?.snapshot?.version ?? 0) > 0) return state;
  }
  return undefined;
}

/** `svall fleet home set local`: the fleet comes back to this machine from the home it dials; the old home joins it. */
export function moveHomeBack(d: MoveDeps, o: CrewChoice = {}): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    const paths = resolvePaths(d.target.home);
    if (!isWorker(paths)) return refuse(run, `${thisMachine()} is the fleet's home already`);
    const worker = readWorkerFile(paths);
    const entry = d.registry.get(worker.homeMachineId);
    if (!worker.homeSsh || !worker.homeSocket || !worker.homeSvallBase || !entry) return refuse(run, `${worker.homeName} dials ${thisMachine()}, so the fleet is moved from there`);
    const [ssh, fleetHome, svallBase] = [worker.homeSsh, fleetHomeOfSocket(worker.homeSocket), worker.homeSvallBase];
    const [from, name] = [worker.homeMachineId, worker.homeName];
    const id = newHomeMoveId() as HomeMoveId;
    const local = await d.client();
    let master: SshMaster | undefined;
    let home: Client | undefined;
    let marked = false;
    const adoption: AdoptDeps = { paths, me: d.me, daemon: d.daemon };
    const delivery: HomeDelivery = { id, ssh, svallBase: svallBase as never, fleetHome: fleetHome as never, from, fleetId: worker.fleetId };
    try {
      await run.step('check', async () => {
        const c = await local.call('fleet.homeCheck', { to: d.me });
        if (!c.ok) throw refusalStep(c.refusal);
        master = await d.openMaster(ssh).catch((e: Error) => { throw unreached(e, name, ssh, thisMachine()); });
        home = await d.farClient(master, entry, fleetHome, worker.fleetId);
        await checkCrew(home, id, d.me, o, 'svall fleet home set local');
        return { value: undefined, detail: `${c.sheet.here} robots stay on ${name}, ${c.sheet.there} here${lacking(c.sheet, thisMachine())}${waiting(c.sheet, thisMachine())}` };
      });
      driverJournal(paths, id, 'check');
      await moveMission(run, home!, paths, id, d.me, thisMachine(), 'local', o);
      driverJournal(paths, id, 'pause');
      const { phone } = await run.step('pause', async () => ({ value: await home!.call('fleet.freeze', { id, to: d.me }), detail: 'paused' }));
      if (phone.serving) await servesPhone(run, thisMachine());
      // from here a kill leaves what this machine holds of the move for a person to finish or call off
      owe(paths, delivery);
      const adoptKeySha256 = mintAdoptKey(paths, id);
      driverJournal(paths, id, 'copy');
      const here = d.registry.localMachine();
      await run.step('copy', async () => {
        const manifest: HomeManifest = { id, fleetId: worker.fleetId, from, to: d.me, toName: here.name, toHome: here.home as HomeManifest['toHome'], record: { ...entry.record, ssh, dial: undefined }, phone, adoptKeySha256, ...(worker.homeProfile && { fromProfile: worker.homeProfile }) };
        // on stdin, as an argv is seen by every account there, and the manifest holds who the phone lets in
        const r = await master!.run(farCommand(svallBase, fleetHome, ['fleet', 'export', id]), { timeoutMs: STEP_MS, maxOutputBytes: MAX_ARCHIVE, input: JSON.stringify(manifest) });
        if (r.code !== 0) throw new StepError(`${name} did not pack the fleet's files`, undefined, undefined, undefined, `svall fleet export there exited ${r.code}: ${r.stderr.trim().slice(0, 400)}`);
        const packed = z.object({ sha256: z.string(), archive: z.string() }).safeParse((() => { try { return JSON.parse(r.stdout) as unknown; } catch { return undefined; } })());
        if (!packed.success) throw new StepError(`svall fleet export there did not answer a whole archive, as the fleet may have grown past what a move carries`, 'check again, and it says what to do');
        const { sha256, archive } = packed.data;
        const bytes = Buffer.from(archive, 'base64');
        const a = await stageAdopt(adoption, id, sha256, bytes);
        if (a.status !== 'pending' || a.phase !== 'staged') throw new StepError(`${thisMachine()} did not stage the fleet's files: ${standing(a, thisMachine())}`, undefined, undefined, undefined, farSaid(a));
        return { value: undefined, detail: `the fleet's files are on ${thisMachine()}`, raw: `${bytes.length} bytes checked and staged` };
      });
      const keySha256 = markKey(paths, id);
      await run.step('mark', async () => {
        await home!.call('fleet.homeMove', { op: 'mark', marker: {
          id, fleetId: worker.fleetId, from, fromName: name, fromHome: entry.record.home as HomeMoving['fromHome'], to: d.me, toName: here.name, toHome: here.home as HomeMoving['toHome'], at: Date.now(), keySha256,
        } });
        marked = true;
        // an abort and a delivery in the mark's flight found no marker there and cleared this
        owe(paths, delivery);
        return { value: undefined, detail: 'handed over' };
      });
      homePoint('move.marked');
      await finishBack(run, d, adoption, id, { from, name, ends: NOT_FINISHED });
    } catch (e) {
      // an abort is what the old home is told, if it has heard of this move at all
      if (!marked && !(e instanceof HomeCrash)) {
        await home?.call('fleet.thaw', { id }).catch(() => undefined);
        await abortAdopt(adoption, id, oldHome(delivery)).catch(() => undefined);
        driverJournal(paths, id, 'aborted');
        // a mark that landed with its answer lost ends only by this debt, which a delivery in the mark's flight may have cleared
        if (driverKey(paths, id)) owe(paths, delivery);
        if (home) await offerCrew(run, home, thisMachine()).catch(() => undefined);
      }
      throw e;
    } finally {
      local.close();
      home?.close();
      await master?.close().catch(() => undefined);
    }
  });
}

// this machine's install, the old home told by this machine's daemon, and that home's link: the end of the way back, on its first run and on a retry
async function finishBack(run: Runner, d: MoveDeps, adoption: AdoptDeps, id: HomeMoveId, o: { from: MachineId; name: string; ends: string }): Promise<void> {
  // ahead of the old home's landing, which takes the manifest
  let carried: string[] = [];
  try { carried = (readManifest(adoption.paths, id).workers ?? []).map((w) => w.id); } catch { /* one that cannot be read has nothing to wait for */ }
  const { paths } = adoption;
  driverJournal(paths, id, 'adopt');
  await run.step('adopt', async () => {
    const a = await installAdopt(adoption, id, driverAdoptKey(paths, id), enrolmentFor(paths, d.me, { home: d.registry.localMachine(), ...(d.target.managed && { profile: d.target.name }) }));
    if (a.status === 'adopted' || a.status === 'done') return { value: undefined, detail: `${thisMachine()} runs the fleet` };
    throw new StepError(`${thisMachine()} did not take the fleet: ${standing(a, thisMachine())}`, a.status === 'not-adopted' ? undefined : 'svall fleet home abort, or svall fleet home retry', undefined, a.status === 'not-adopted' ? undefined : o.ends, farSaid(a));
  });
  driverJournal(paths, id, 'join');
  await run.step('join', async () => {
    if (!await told(paths)) throw new StepError(`${o.name} was not told it is a worker now`, `${thisMachine()} keeps telling it; it stays frozen until it hears`);
    return { value: undefined, detail: `${o.name} is its worker` };
  });
  await run.step('probe', async () => {
    driverJournal(paths, id, 'done');
    for (const until = Date.now() + SNAPSHOT_MS; Date.now() < until; await new Promise((r) => setTimeout(r, POLL_MS))) {
      const state = await withClient(d.client, (c) => c.call('state.get', {})).catch(() => undefined);
      if (state?.machines?.[o.from]?.reachable) return { value: undefined, detail: `The fleet runs on ${thisMachine()}. Open the phone from its new QR code once.` };
    }
    return { value: undefined, status: 'warn' as const, detail: `the fleet runs on ${thisMachine()}; ${o.name} has not linked yet`, action: svallOf(d.target, `host doctor ${o.name}`), say: `Check ${o.name} under Machines` };
  });
  await workersJoin(run, d, carried, thisMachine());
}

// whether this machine's daemon has told the old home what it owes it
async function told(paths: Paths): Promise<boolean> {
  for (const until = Date.now() + TOLD_MS; Date.now() < until; await new Promise((r) => setTimeout(r, POLL_MS))) if (!readOwed(paths)) return true;
  return false;
}

// a daemon a kill left down, as the app or a person would start it
async function daemonClient(d: Pick<MoveDeps, 'client' | 'daemon'>): Promise<Client> {
  const first = await d.client().catch(() => undefined);
  if (first) return first;
  await d.daemon.start();
  for (const until = Date.now() + ANSWER_MS; ; await new Promise((r) => setTimeout(r, POLL_MS))) {
    const c = await d.client().catch((e: Error) => { if (Date.now() >= until) throw e; return undefined; });
    if (c) return c;
  }
}

/** `svall fleet home retry`: the move this machine holds goes on from what stays staged, on the side that has to act. */
export function resumeHome(d: MoveDeps): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    const paths = resolvePaths(d.target.home);
    const owed = readOwed(paths);
    if (owed) {
      const adoption: AdoptDeps = { paths, me: d.me, daemon: d.daemon };
      await daemonClient(d).then((c) => c.close());
      const said = moveOutcome(paths, owed.id);
      const old = oldHomeName(paths, owed.id) ?? 'the old home';
      if (said?.status === 'not-adopted') return refuse(run, 'this move was called off here', await told(paths) ? undefined : `${thisMachine()} keeps telling ${old}`);
      let staged: HomeManifest | undefined;
      try { staged = readManifest(paths, owed.id); } catch { /* its driver died before the archive came */ }
      // a home its driver left before the mark went on taking writes, so this machine must not take the fleet too
      const marked = said || !staged ? true : await run.step('check', async () => {
        const master = await d.openMaster(owed.ssh).catch((e: Error) => {
          const u = unreached(e, staged.record.name, owed.ssh, thisMachine());
          throw new StepError(u.detail, `${u.action}, then svall fleet home retry`, undefined, 'Finish the move once it answers', u.raw);
        });
        try {
          return { value: await markedThere(master, owed), detail: `asked ${staged.record.name}` };
        } finally { await master.close().catch(() => undefined); }
      });
      if (!staged || !marked) {
        await abortAdopt(adoption, owed.id, oldHome(owed));
        await told(paths);
        return refuse(run, `${old} is not frozen for this move and goes on as the home`, 'svall fleet home set local to start again', 'Bring the fleet back again from Machines');
      }
      const { from, record } = staged;
      return finishBack(run, d, adoption, owed.id, { from, name: record.name, ends: NOT_FINISHED });
    }
    const marker = readMarker(paths);
    if (!marker) return refuse(run, `no move of the fleet waits on ${thisMachine()}`);
    if (!marker.ask) return refuse(run, `${marker.toName} has the only route here, and tells ${thisMachine()} how the move ended`, `svall fleet home retry on ${marker.toName}`, `Finish the move on ${marker.toName}`);
    const { ask, id, to, toName: name } = marker;
    const client = await daemonClient(d);
    const master = await d.openMaster(ask.ssh).catch((e: Error) => {
      client.close();
      const u = unreached(e, name, ask.ssh, thisMachine());
      const stays = new StepError(u.detail, `${u.action}, then svall fleet home retry; until then this home stays frozen`, undefined, 'Finish the move once it answers; until then this home takes no changes', u.raw);
      return run.step<never>('check', () => Promise.reject(stays));
    });
    try {
      await finishOut(run, d, client, paths, id, { to, name, ssh: ask.ssh, asking: askedBy({ machine: marker.from, fleetId: marker.fleetId }), ends: NOT_FINISHED }, (args, input) => farAnswer(master, { svallBase: ask.svallBase, fleetHome: ask.fleetHome, name }, args, input));
    } finally {
      client.close();
      await master.close().catch(() => undefined);
    }
  });
}

/** `svall fleet home abort` on the machine that owes the outcome: the move is off here for good, unless it has gone through, and its daemon tells the old home. `said`: what a move still under way here says, and `raw` what it said beside. */
export async function abortBack(d: Pick<MoveDeps, 'client' | 'daemon' | 'me' | 'target'>): Promise<{ status: AdoptAnswer['status']; told: boolean; said?: string; raw?: string } | undefined> {
  const paths = resolvePaths(d.target.home);
  const owed = readOwed(paths);
  if (!owed) return undefined;
  const a = await abortAdopt({ paths, me: d.me, daemon: d.daemon }, owed.id, oldHome(owed));
  if (a.status === 'pending') return { status: a.status, told: false, said: standing(a, thisMachine()), raw: farSaid(a) };
  await daemonClient(d).then((c) => c.close());
  return { status: a.status, told: await told(paths) };
}

/** `svall fleet home abort`: the move this machine waits on is called off where that can still be done, in one step that says how it went. */
export function abortHome(d: MoveDeps): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    await run.step('abort', async () => {
      const owed = readOwed(resolvePaths(d.target.home));
      const old = (owed && oldHomeName(resolvePaths(d.target.home), owed.id)) ?? 'the old home';
      const back = await abortBack(d);
      if (back?.status === 'not-adopted') return { value: undefined, detail: back.told ? `the move is off, and ${old} takes writes again` : `the move is off; ${old} thaws once ${thisMachine()} reaches it` };
      if (back?.status === 'pending') throw new StepError(`the move is still under way here: ${back.said}`, 'svall fleet home abort again in a moment', undefined, 'Call it off again in a moment', back.raw);
      if (back) throw new StepError('the move has gone through here, so it cannot be called off');
      if (!(await withClient(d.client, (c) => c.call('fleet.homeMove', { op: 'status' }))).moving) throw new StepError(`no move of the fleet waits on ${thisMachine()}`, 'one still running stops with the command or sheet that runs it');
      const { moving } = await withClient(d.client, (c) => c.call('fleet.homeMove', { op: 'abort' }));
      if (!moving) return { value: undefined, detail: 'the move is off, and this home takes writes again' };
      if (!moving.asks) throw new StepError(`${moving.name} holds this move, and tells ${thisMachine()} how it ended`, `svall fleet home abort on ${moving.name}`, undefined, `Call it off on ${moving.name}`);
      if (moving.phase === 'adopted' || moving.phase === 'done') throw new StepError(`${moving.name} has taken the fleet, so the move cannot be called off`, 'svall fleet home retry', undefined, 'Finish the move');
      // the last answer is a word for where the move stands there, or what stopped the asking, which goes behind
      const answer = moving.answer;
      const word = answer !== undefined && /^[a-z-]+$/.test(answer);
      throw new StepError(`${moving.name} has not let go of it: ${word ? homeMoveStands(answer, moving.name).replace(/\.$/, '') : answer ? 'it did not answer' : 'no answer yet'}`,
        'svall fleet home abort again once it answers, or svall fleet home retry', undefined, 'Call it off again once it answers, or finish the move', word ? undefined : answer);
    });
  });
}
