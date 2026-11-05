import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emptyState, MachineId, migrateState, relabelHome, WorkerFile, type Enrolment, type FleetState, type HomeManifest, type HomeMoveId, type HomeMoving, type Island, type MobileStatus, type Robot } from '@svall/protocol';
import { armHomeFailpoints, HOME_FAILPOINTS, HomeCrash, type HomeFailpoint } from '../../src/failpoints.js';
import { homeGate, installAdopt, packFleet, stageAdopt, writeMarker, type AdoptDeps, type HomeDaemon } from '../../src/fleet/home-move.js';
import { daemonLock } from '../../src/kernel-lock.js';
import { dialSocket, resolvePaths, type Paths } from '../../src/paths.js';
import { issueToken } from '../../src/placement/workers.js';
import { startsAsWorker } from '../../src/worker/mode.js';
import { makeHome } from '../helpers.js';

export const MAC = MachineId.parse('42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
export const STUDIO = MachineId.parse('66666666-7777-8888-9999-aaaaaaaaaaaa');
export const FLEET = '11111111-2222-3333-4444-555555555555';
export const ID = 'hm_abcdefghij' as HomeMoveId;
export const TOKEN = 'b'.repeat(48);

export const robot = (id: string, machine?: MachineId, generation?: number): Robot => ({
  id, islandId: 'i_a', cell: { x: 0, y: 0 }, name: id, portrait: 'fox', note: `note of ${id}`, instructions: '', cwd: '/x', context: [], shell: { lastOutputAt: 0 }, unread: false,
  ...(machine && { machine }), ...(generation !== undefined && { placement: { generation } }),
} as unknown as Robot);

const island = (): Island => ({ id: 'i_a', kind: 'island', name: 'work', description: 'what it is for', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 2, h: 2 }, seed: 1 } as unknown as Island);

/** A daemon that does what the real one does to a fleet home: holds its lock, keeps the state in memory and writes it out as it stops, settles the gate first, and clears what says it was a worker when it starts as a home. */
export class FakeDaemon implements HomeDaemon {
  role?: 'home' | 'worker' | 'frozen';
  held?: FleetState;
  noAnswer = false;
  // why a start fails, as a unit that will not start does, with nothing changed
  startFails?: string;
  starts = 0;
  private unlock?: () => void;

  constructor(readonly paths: Paths, private registryDir: string, private me: MachineId) {}

  async stop(): Promise<void> {
    if (!this.role) return;
    fs.writeFileSync(this.paths.state, JSON.stringify(this.held));
    this.role = undefined;
    this.held = undefined;
    this.unlock?.();
    this.unlock = undefined;
  }

  /** As a crash: nothing flushed, the lock gone. */
  kill(): void {
    this.role = undefined;
    this.held = undefined;
    this.unlock?.();
    this.unlock = undefined;
  }

  async start(): Promise<void> {
    if (this.startFails) throw new Error(this.startFails);
    if (this.role) await this.stop();
    const unlock = await daemonLock(this.paths.home);
    if (!unlock) throw new Error('svalld is already running');
    this.unlock = unlock;
    this.starts++;
    const { frozen } = homeGate(this.paths, this.registryDir);
    const worker = startsAsWorker(this.paths, () => this.me);
    this.held = migrateState(JSON.parse(fs.readFileSync(this.paths.state, 'utf8'))).state;
    if (!worker) {
      for (const m of Object.values(this.held.machines ?? {})) delete m.snapshot;
      fs.rmSync(this.paths.epoch, { force: true });
    }
    this.role = worker ? 'worker' : frozen ? 'frozen' : 'home';
  }

  answersHome(fleetId: string): Promise<boolean> {
    if (this.noAnswer || this.role !== 'home') return Promise.resolve(false);
    return Promise.resolve(JSON.parse(fs.readFileSync(this.paths.fleetConfig, 'utf8')).id === fleetId);
  }
}

export type Side = { paths: Paths; daemon: FakeDaemon; deps: AdoptDeps; registryDir: string };

const side = (me: MachineId): Side => {
  const home = path.join(makeHome(), 'fleet');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const paths = resolvePaths(home);
  const registryDir = makeHome();
  const daemon = new FakeDaemon(paths, registryDir, me);
  return { paths, daemon, registryDir, deps: { paths, me, daemon, registryDir } };
};

export const MAC_RECORD = { name: 'mac', platform: 'darwin', arch: 'arm64', home: '/Users/ada', svallBase: '/opt/svall', dial: 'worker' } as const;
export const STUDIO_RECORD = { name: 'studio', ssh: 'ada@studio', platform: 'linux', arch: 'x64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall' } as const;

/**
 * A Mac home with robots, an island that holds something, the old workers.json and what no move carries, and studio its worker with a
 * robot of its own, a worker's copy and the phone's record. `sameId`: studio goes by the fleet's id, as a joined worker or a way back's destination does.
 */
export async function world(o: { sameId?: boolean } = {}): Promise<{ mac: Side; studio: Side; manifest: HomeManifest; archive: { bytes: Buffer; sha256: string }; enrolment: (t: string, m: HomeManifest) => Enrolment }> {
  const mac = side(MAC);
  const studio = side(STUDIO);
  const state: FleetState = {
    ...emptyState(),
    islands: { i_a: island() },
    robots: { here: robot('here'), placed: robot('placed', STUDIO, 3) },
    machines: { [STUDIO]: { name: 'studio', reachable: true, since: 1, home: '/home/ada', replayed: { epoch: 'e1', seq: 4 } } },
  };
  const write = (s: Side, name: string, data: string | object) => {
    const file = path.join(s.paths.home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
  };
  write(mac, 'state.json', state);
  write(mac, 'fleet.json', { id: FLEET });
  write(mac, 'push.json', { subscriptions: ['phone'] });
  write(mac, 'mobile-pass', 'the-pass');
  write(mac, 'docs/fleet/note.md', 'a note');
  write(mac, 'docs/repos/x/note.md', 'a repo note');
  // none of these goes with the fleet
  write(mac, 'token', 'the-api-token');
  write(mac, '.env', 'SECRET=1\n');
  write(mac, 'node.json', {});
  write(mac, 'cache/mirror-state.json', { from: 'a Copy' });
  write(mac, 'journal/outbox.ndjson', `${JSON.stringify({ seq: 1, kind: 'mutation', data: { method: 'robot.update' } })}\n`);
  write(mac, 'journal/acked', '1\n');
  issueToken(mac.paths, STUDIO);
  // the worker's: its own copy with its home's stamp, its own fields of the robot it runs, and its own id until the fleet's comes
  const copy: FleetState = { ...structuredClone(state), robots: { placed: { ...robot('placed', STUDIO, 3), unread: true } }, machines: { [MAC]: { name: 'mac', reachable: true, since: 1, home: '/Users/ada', snapshot: { version: 7, at: 1 } } } };
  write(studio, 'state.json', copy);
  write(studio, 'fleet.json', { id: o.sameId ? FLEET : '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70' });
  write(studio, 'phone.json', { serving: false });
  write(studio, 'worker.json', { homeMachineId: MAC, fleetId: FLEET, token: TOKEN, homeName: 'mac' });
  write(studio, 'journal/epoch', 'e1\n');
  write(studio, 'journal/acked', '4\n');
  write(studio, 'journal/outbox.ndjson', '');
  await mac.daemon.start();
  await studio.daemon.start();
  await mac.daemon.stop();
  const manifest: HomeManifest = { id: ID, fleetId: FLEET as never, from: MAC, to: STUDIO, toName: 'studio', toHome: '/home/ada' as never, record: MAC_RECORD as never, phone: { serving: true, logins: ['ada@tailnet'] }, at: 5 };
  const packed = await packFleet(mac.paths, manifest);
  await mac.daemon.start();
  const enrolment = (token: string, m: HomeManifest): Enrolment => ({
    worker: WorkerFile.parse({ homeMachineId: STUDIO, fleetId: m.fleetId, token, homeName: 'studio', homeSsh: 'ada@studio', homeSocket: dialSocket(studio.paths, m.from).replace(/^.*\/w\//, '/home/ada/.svall/w/'), homeSvallBase: '/home/ada/.local/share/svall' }),
    home: STUDIO_RECORD as never,
  });
  return { mac, studio, manifest, archive: { bytes: packed.bytes, sha256: packed.sha256 }, enrolment };
}

/** The fleet moved out for real: studio its home, the Mac a worker of it that took the join at a start. */
export async function movedOut(): Promise<Awaited<ReturnType<typeof world>>> {
  const w = await world();
  await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
  await w.mac.daemon.stop();
  writeMarker(w.mac.paths, marker());
  const out = await installAdopt(w.studio.deps, ID, w.enrolment);
  if (out.status !== 'adopted') throw new Error(out.status);
  writeMarker(w.mac.paths, { ...marker(), enrol: out.enrol });
  await w.mac.daemon.start();
  if (w.mac.daemon.role !== 'worker' || w.studio.daemon.role !== 'home') throw new Error(`${w.mac.daemon.role}, ${w.studio.daemon.role}`);
  return w;
}

/** What the real link answers: never a rejection, its failures in `error`. */
export const phoneAt = (serving: boolean, logins: string[] = [], error?: string): MobileStatus => ({ serving, url: serving ? 'https://mac.tail:8443/' : '', port: 8443, logins, phones: [], ...(error && { error }) });

/** The key a move's driver holds, of which `marker()` holds the hash. */
export const KEY = 'k'.repeat(43);
export const marker = (): HomeMoving => ({
  id: ID, from: MAC, fromName: 'mac', fromHome: '/Users/ada' as never, to: STUDIO, toName: 'studio', toHome: '/home/ada' as never, at: 5, keySha256: crypto.createHash('sha256').update(KEY).digest('hex'),
  ask: { ssh: 'ada@studio' as never, svallBase: '/home/ada/.local/share/svall' as never, fleetHome: '/home/ada/.svall' as never },
});

/** Which suite crashes at each failpoint of a move, each failing at its end on one it never fired, and the list on a failpoint no suite takes. */
export const POINTS_OF = {
  move: ['adopt.staging', 'adopt.staged', 'adopt.stopped', 'adopt.installing', 'adopt.file', 'adopt.dropped', 'adopt.registry', 'adopt.installed', 'adopt.started', 'restore.restarting', 'adopt.committed', 'restore.file', 'restore.done', 'abort.recorded', 'join.kept', 'join.state', 'join.docs', 'join.worker', 'join.done', 'mark.written'],
  back: ['enrol.written', 'deliver.owed', 'deliver.told'],
  driver: ['move.marked'],
} as const satisfies Record<string, readonly HomeFailpoint[]>;
export const pointsOf = Object.values(POINTS_OF).flat() as HomeFailpoint[];
if (pointsOf.length !== HOME_FAILPOINTS.length || HOME_FAILPOINTS.some((p) => !pointsOf.includes(p))) throw new Error('POINTS_OF does not name every failpoint once');

let disarm: (() => void) | undefined;
const fired = new Set<HomeFailpoint>();
/** What crashed in this file so far, for its last check. */
export const crashesFired = (): ReadonlySet<HomeFailpoint> => fired;
export const disarmCrash = (): void => { disarm?.(); disarm = undefined; };
/** A crash at the `n`th time `point` is reached; answers whether it has fallen. */
export function crashAt(point: HomeFailpoint, n = 1): () => boolean {
  let hit = 0;
  let fell = false;
  disarm?.();
  disarm = armHomeFailpoints((name) => {
    if (name === point && ++hit === n) { fell = true; fired.add(point); disarmCrash(); throw new HomeCrash(point); }
  });
  return () => fell;
}

export const stateOf = (s: Side): FleetState => migrateState(JSON.parse(fs.readFileSync(s.paths.state, 'utf8'))).state;
export const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export { relabelHome };
