import os from 'node:os';
import readline from 'node:readline';
import { z } from 'zod';
import { Enrolment, FleetId, HomeManifest, HomeMoveId, MachineId, MachineRecord, type AdoptAnswer } from '@svall/protocol';
import { readFleetConfig } from '@svall/svalld/config';
import { homeFacts } from '@svall/svalld/fleet/home-freeze';
import { abortAdopt, adoptStatus, carriedWorkers, installAdopt, packFleet, readMarker, settleMove, stageAdopt, type AdoptDeps, type Asker } from '@svall/svalld/fleet/home-move';
import { dialSocket, dialSocketTooLong, resolvePaths } from '@svall/svalld/paths';
import { issueToken, tokenFor } from '@svall/svalld/placement/workers';
import { fleetHomes } from '@svall/svalld/fleet-homes';
import { installPrefix } from '@svall/svalld/release';
import { machineId } from '@svall/svalld/machine';
import { realDeps as realMobileDeps, resolveTailscale, tailnetSelf } from '@svall/svalld/mobile';
import { isWorker, readWorkerFile } from '@svall/svalld/worker/mode';
import { Client, withClient } from '../client.js';
import { connectForwarded } from '../controller/connection.js';
import { abortHome, bringCrewBack, enrolmentFor, joinHome, moveHomeBack, moveHomeOut, realHomeDaemon, resumeHome, thisMachine, type CrewChoice, type MoveDeps, type SeedAsk } from '../controller/home.js';
import type { HostOutcome, StepEvent } from '../controller/host.js';
import { MachineRegistry } from '../controller/registry.js';
import { SshMaster } from '../controller/ssh.js';
import { printResult } from '../format.js';
import { farProfile, type Target } from '../target.js';
import { ended, interactiveSsh, stepLine, tiered } from './host.js';
import { connectChoice } from './limits.js';
import { parseDuration } from './parse.js';
import { enrollHere, realEnrol } from './worker.js';

type Facts = { name: string; platform: string; arch: string; home: string; svallBase: string };

export const seedQuestion = (name: string, platform: NodeJS.Platform = process.platform): string => `${name} has no agent setup yet. Copy ${thisMachine(platform)}'s there first? [Y/n] `;

const askSeed = (): SeedAsk => {
  const ask = async (q: string): Promise<string> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return await new Promise((resolve) => { rl.question(q, resolve); }); } finally { rl.close(); }
  };
  return {
    go: async (name) => /^(y|yes)?$/i.test((await ask(seedQuestion(name))).trim()),
    key: async (said, preview) => /^y(es)?$/i.test((await ask(`${said}? ${[...preview, '[y/N] '].join(' ')}`)).trim()),
  };
};

/**
 * A worker that dials this home: its record in this machine's registry, which the home links by, and a new token, the
 * newest of which the home holds. `keepToken`: the one it holds stands, for a worker that may hold it yet, as an answer can be lost on
 * its way. Answers what that worker's `svall worker enroll` takes, the token only as JSON.
 */
async function enrollWorker(t: Target, id: string, o: Facts & { keepToken?: boolean }): Promise<{ homeMachineId: MachineId; homeName: string; fleetId: string; socket: string; token: string; homeSvallBase: string; homePlatform: string; homeArch: string; homePath: string }> {
  const paths = resolvePaths(t.home);
  if (isWorker(paths)) throw new Error(`${t.home} is a worker's fleet home; run this on the fleet's home`);
  const moving = readMarker(paths);
  if (moving) throw new Error(`the fleet is moving to ${moving.toName}; take this machine once it has, from there`);
  const fleetId = readFleetConfig(paths).id;
  const parsedId = MachineId.safeParse(id);
  if (!parsedId.success) throw new Error(`${id} is not a machine id: ${z.prettifyError(parsedId.error)}`);
  const parsed = MachineRecord.safeParse({ ...o, dial: 'worker' });
  if (!parsed.success) throw new Error(`${id} is not enrolled: ${z.prettifyError(parsed.error)}`);
  const machine = parsedId.data;
  const record = parsed.data;
  const socket = dialSocket(paths, machine);
  const long = dialSocketTooLong(socket, record.platform);
  if (long) throw new Error(`${long.message}, so no worker can dial into ${t.home}; use an account whose home is ${long.over} bytes shorter`);
  if (socket.includes(':')) throw new Error(`${socket} holds a colon, which ssh reads as a forward's separator, so no worker can dial into ${t.home}`);
  const registry = MachineRegistry.load();
  // the record is the account's, so a machine another fleet here reaches over ssh would lose that route
  const route = registry.get(machine)?.record.ssh;
  const sharing = route ? fleetHomes(os.homedir()).find((h) => h !== t.home && tokenFor(resolvePaths(h), machine)) : undefined;
  if (sharing) throw new Error(`the fleet in ${sharing} reaches ${record.name} over ssh at ${route}, which this would end; svall host remove ${record.name} --forget drops that route for every fleet here and leaves the machine as it is`);
  registry.put(machine, record);
  registry.save();
  const token = (o.keepToken && tokenFor(paths, machine)) || issueToken(paths, machine);
  // a daemon not running links it as it starts
  await withClient(() => Client.connect(t.home), (c) => c.call('machines.refresh', {})).catch(() => undefined);
  const here = registry.localMachine();
  return { homeMachineId: registry.localId, homeName: here.name, fleetId, socket, token, homeSvallBase: installPrefix(), homePlatform: here.platform, homeArch: here.arch, homePath: here.home };
}

const readStdin = async (): Promise<string> => {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

const Settle = z.object({ key: z.string().optional(), enrol: Enrolment.optional() });

const adoptDeps = (t: Target): AdoptDeps => ({ paths: resolvePaths(t.home), me: machineId(), daemon: realHomeDaemon(t) });

// a timer holds at most 2^31 - 1 ms
const MAX_INTERRUPT_MS = 24 * 3_600_000;
const crewChoice = (o: { interruptAfter?: string }): CrewChoice => {
  if (o.interruptAfter === undefined) return {};
  const ms = parseDuration(o.interruptAfter);
  if (ms > MAX_INTERRUPT_MS) throw new Error(`--interrupt-after takes at most 24h, not ${o.interruptAfter}`);
  return { interruptAfterMs: ms };
};

// each step as it comes, kept for the lines the run ends on
const flowReporter = (json: boolean, steps: StepEvent[]) => (e: StepEvent): void => {
  steps.push(e);
  if (json) process.stdout.write(`${JSON.stringify(e)}\n`);
  else if (e.status !== 'start') process.stdout.write(`${stepLine(e)}\n`);
};

function moveDeps(t: Target, json: boolean, steps: StepEvent[]): MoveDeps {
  return {
    emit: flowReporter(json, steps), openMaster: (destination) => SshMaster.open({ destination }), registry: MachineRegistry.load(), target: t, me: machineId(), daemon: realHomeDaemon(t),
    client: () => Client.connect(t.home),
    farClient: async (master, entry, fleetHome, fleetId) => (await connectForwarded(master, entry, { fleetId: FleetId.parse(fleetId), fleetHome, here: { profile: farProfile(t) } })).client,
  };
}

/**
 * A flow that went through ends 0 on its own line, one that stopped 1 on `stopped`; a terminal is shown first the rows that
 * need a person, then the notes and the rows that went well counted.
 */
export function finishFlow(out: HostOutcome, json: boolean, steps: StepEvent[], said: { done: string; stopped: string }): void {
  if (json) process.stdout.write(`${JSON.stringify(out)}\n`);
  else process.stdout.write(`${[...tiered(ended(steps), undefined, true).lines, out.stopped ? said.stopped : said.done].join('\n')}\n`);
  if (out.stopped) process.exitCode = 1;
}

/** The line a join that went through ends on, the home by the name this machine knows it by. */
export const joinedLine = (home: string, platform: NodeJS.Platform = process.platform): string => `This fleet runs on ${home} now, and ${thisMachine(platform)} is its worker.`;

export function fleetActions(target: () => Target, json: () => boolean) {
  const idOf = (id: string): HomeMoveId => {
    const parsed = HomeMoveId.safeParse(id);
    if (!parsed.success) throw new Error(`${id} is not a home move's id`);
    return parsed.data;
  };
  const answer = (a: AdoptAnswer): void => printResult(a, true);
  const askerOf = (o: { asker?: string; fleet?: string }): Asker | undefined => (o.asker && o.fleet ? { machine: MachineId.parse(o.asker), fleetId: FleetId.parse(o.fleet) } : undefined);
  return {
    enrollWorker: async (id: string, o: Facts & { keepToken?: boolean }) => {
      if (!json()) throw new Error('fleet enroll-worker prints a new token for svall worker enroll to read; run it with --json');
      printResult(await enrollWorker(target(), id, o), true);
    },
    join: async (ssh: string, { limits, ...o }: { name?: string; homeProfile?: string; limits?: string | false }) => {
      const t = target();
      const steps: StepEvent[] = [];
      const emit = flowReporter(json(), steps);
      const out = await joinHome({ ssh, ...o, ...connectChoice({ limits }, !json() && process.stdin.isTTY === true && process.stdout.isTTY === true) }, {
        emit, openMaster: (destination) => SshMaster.open({ destination }), interactiveSsh, registry: MachineRegistry.load(), target: t, me: machineId(), svallBase: installPrefix(),
        tailnet: async () => { const m = realMobileDeps(); await tailnetSelf(m, await resolveTailscale(m)); },
        enrol: (e, token) => enrollHere(t, e, { ...realEnrol, token: () => Promise.resolve(token), out: (line) => { if (!json()) process.stdout.write(`${line}\n`); } }),
        state: () => withClient(() => Client.connect(t.home), (c) => c.call('state.get', {})),
        ...(!json() && process.stdin.isTTY && process.stdout.isTTY && { ask: askSeed() }),
        seedClients: async (master, home) => {
          const here = await Client.connect(t.home);
          try {
            const { client: far, forward } = await connectForwarded(master, { id: home.id, record: { name: home.ssh, svallBase: home.svallBase } }, { fleetId: home.fleetId, ...(o.homeProfile && { profile: o.homeProfile }) });
            return { here, far, close: async () => { here.close(); far.close(); await forward.cancel(); } };
          } catch (e) {
            here.close();
            throw e;
          }
        },
      });
      // a join that went through left this fleet a worker of the home, by the name this machine knows it by
      finishFlow(out, json(), steps, { done: out.stopped ? '' : joinedLine(readWorkerFile(resolvePaths(t.home)).homeName), stopped: `${thisMachine()} did not join the fleet.` });
    },
    facts: async () => {
      const t = target();
      const paths = resolvePaths(t.home);
      const worker = isWorker(paths);
      // the fleet this folder holds: a worker's own fleet.json may go by an id of its own
      printResult(await homeFacts(paths, { me: machineId(), role: worker ? 'worker' : 'home', fleetId: worker ? readWorkerFile(paths).fleetId : readFleetConfig(paths).id, ...(!worker && { carried: carriedWorkers(paths, MachineRegistry.load().list(), t.name) ?? [] }) }), json());
    },
    adopt: async (raw: string, o: { stage?: boolean; sha256?: string; homeSsh?: string }) => {
      const t = target();
      const id = idOf(raw);
      const d = adoptDeps(t);
      // an ssh that goes away leaves this to finish
      process.on('SIGHUP', () => undefined);
      process.stdout.on('error', () => undefined);
      if (o.stage) {
        if (!o.sha256) throw new Error('--stage takes --sha256');
        return answer(await stageAdopt(d, id, o.sha256, Buffer.from(await readStdin(), 'base64')));
      }
      const key = process.stdin.isTTY ? undefined : (await readStdin()).trim();
      const registry = MachineRegistry.load();
      answer(await installAdopt(d, id, key, enrolmentFor(d.paths, d.me, { ...(o.homeSsh && { ssh: o.homeSsh }), home: { ...registry.localMachine(), svallBase: installPrefix() }, ...(t.managed && { profile: t.name }) })));
    },
    status: async (raw: string, o: { asker?: string; fleet?: string }) => answer(await adoptStatus(adoptDeps(target()), idOf(raw), askerOf(o))),
    abort: async (raw: string, o: { asker?: string; fleet?: string }) => answer(await abortAdopt(adoptDeps(target()), idOf(raw), askerOf(o))),
    export: async (raw: string) => {
      const m = HomeManifest.parse(JSON.parse(await readStdin()));
      if (m.id !== idOf(raw)) throw new Error('the manifest is of another move');
      const t = target();
      const paths = resolvePaths(t.home);
      const workers = carriedWorkers(paths, MachineRegistry.load().list(), t.name);
      if (!workers) throw new Error(`${paths.workersFile} cannot be read, so which workers this move carries is not known; fix it, then try again`);
      const { bytes, sha256 } = await packFleet(paths, { ...m, workers: workers.filter((w) => w.id !== m.to) });
      printResult({ sha256, archive: bytes.toString('base64') }, true);
    },
    settle: async (raw: string, o: { outcome: string }) => {
      const t = target();
      const id = idOf(raw);
      if (o.outcome !== 'adopted' && o.outcome !== 'not-adopted') throw new Error(`--outcome takes adopted or not-adopted, not ${o.outcome}`);
      const sent = Settle.parse(process.stdin.isTTY ? {} : JSON.parse((await readStdin()) || '{}'));
      if (o.outcome === 'adopted' && sent.key && !sent.enrol) throw new Error('--outcome adopted takes the enrolment on stdin');
      // without the key the settle refuses before it reads the enrolment
      const told = o.outcome === 'adopted' ? { status: 'adopted' as const, enrol: sent.enrol! } : { status: 'not-adopted' as const };
      printResult(await settleMove(resolvePaths(t.home), id, told, sent.key, {
        join: (enrol, key) => withClient(() => Client.connect(t.home), (c) => c.call('fleet.homeMove', { op: 'join', id, enrol, key })),
        thaw: (key) => withClient(() => Client.connect(t.home), (c) => c.call('fleet.homeMove', { op: 'told', id, key })),
        start: () => realHomeDaemon(t).start(),
      }), true);
    },
    home: async () => {
      const t = target();
      const h = await withClient(() => Client.connect(t.home), (c) => c.call('fleet.home', {}));
      printResult(h, json(), () => (h.mine ? `the fleet runs here, on ${h.name}` : `the fleet runs on ${h.name}, and this machine is its worker`));
    },
    homeSet: async (machine: string, o: { interruptAfter?: string }) => {
      const t = target();
      const steps: StepEvent[] = [];
      const d = moveDeps(t, json(), steps);
      const out = await (machine === 'local' ? moveHomeBack(d, crewChoice(o)) : moveHomeOut(machine, d, crewChoice(o)));
      finishFlow(out, json(), steps, { done: `The fleet runs on ${machine === 'local' ? thisMachine() : machine}. Open the phone from its new QR code once.`, stopped: 'The move did not finish.' });
    },
    homeRetry: async () => {
      const steps: StepEvent[] = [];
      finishFlow(await resumeHome(moveDeps(target(), json(), steps)), json(), steps, { done: 'The move has gone through. Open the phone from its new QR code once.', stopped: 'The move did not finish.' });
    },
    homeAbort: async () => {
      const steps: StepEvent[] = [];
      // mission control's robots stay where the move sent them unless a person brings them back
      finishFlow(await abortHome(moveDeps(target(), json(), steps)), json(), steps, {
        done: 'mission control\'s robots that went ahead stay there: svall fleet home crew-back brings them back', stopped: 'The move was not called off.',
      });
    },
    crewBack: async (o: { interruptAfter?: string }) => {
      const steps: StepEvent[] = [];
      finishFlow(await bringCrewBack(moveDeps(target(), json(), steps), crewChoice(o)), json(), steps, { done: 'Mission control\'s robots are on the home.', stopped: 'Mission control\'s robots did not all come back.' });
    },
  };
}
