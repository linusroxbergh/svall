import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { FleetConfig, type FleetId, type MachineId, type MethodName, type OwnerRecord, type OwnershipInfo, type Params, type Result } from '@svall/protocol';
import { patchFleetConfig } from '@svall/svalld/config';
import type { OwnerAnswer } from '@svall/svalld/gateway/client';
import { appendDurable } from '@svall/svalld/handover/durable';
import { HandoverJournal, handoverGeneration } from '@svall/svalld/handover/journal';
import { OwnerCache } from '@svall/svalld/ownership/state';
import { resolvePaths } from '@svall/svalld/paths';
import { authorityOp, Masters, openDaemon } from '../controller/reach.js';
import { fileStore, type ControllerJournal } from '../controller/recovery.js';
import { MachineRegistry, type MachineEntry } from '../controller/registry.js';
import { readRoute, rememberOwner, type CachedRoute } from '../controller/route.js';
import { closeMastersOnSignal } from '../controller/ssh.js';
import { ask } from '../prompt.js';
import type { Target } from '../target.js';
import { provisionCommand } from './fleet-provision.js';

/** One operation on a gateway's authority. It throws when nothing answered. */
export type GatewayPort = (op: 'get' | 'force', fleetId: FleetId, params?: Record<string, unknown>) => Promise<OwnerAnswer>;
/** A daemon of this fleet on one machine. Opening it throws when it cannot be reached. */
export type DaemonPort = { call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>; close(): void };

export type RecoverOptions = { forceOwner: string; confirm?: string; gateway?: string; profile?: string };

export type RecoverDeps = {
  fleetHome: string;
  registry: MachineRegistry;
  gateway(entry: MachineEntry): GatewayPort;
  daemon(entry: MachineEntry): Promise<DaemonPort>;
  /** whether there is a person at a terminal to type the fleet id */
  interactive: boolean;
  ask(question: string): Promise<string>;
  emit(e: RecoverEvent): void;
  now(): Date;
};

/** What a gateway holds of this fleet, or why it could not say. */
export type Held =
  | { state: 'record'; record: OwnerRecord }
  | { state: 'absent' }
  | { state: 'corrupt' | 'refused' | 'unreachable'; message: string };

/** What one machine holds of this fleet: its daemon's word, its own files when that is this machine, or why neither. */
export type MachineView = {
  machineId: MachineId;
  name: string;
  ownership?: OwnershipInfo;
  from?: 'daemon' | 'disk';
  unreachable?: string;
  /** what the gateway and this controller last recorded of a machine whose daemon did not answer */
  lastKnown?: string[];
};

/** One generation the user is shown, and where it was read. */
export type Shown = { source: string; generation: number };

export type Observed = {
  fleetId: FleetId;
  gateway: { machineId: MachineId; name: string } & Held;
  replacement?: { machineId: MachineId; name: string } & Held;
  machines: MachineView[];
  controller?: { transactionId?: string; generation: number; phase: string; source: string; destination: string };
  route?: CachedRoute;
  shown: Shown[];
  /** the record to be written, when there is a gateway to write it at */
  plan?: { ownerMachineId: MachineId; owner: string; generation: number; gatewayMachineId: MachineId; gateway: string };
  risks: string[];
};

export type RecoverEvent =
  | { event: 'recover.observed'; data: Observed }
  | { event: 'recover.forced'; data: { gatewayMachineId: MachineId; record: OwnerRecord } }
  | { event: 'recover.adopted'; data: { machineId: MachineId; name: string; adopted?: boolean; superseded?: string; ownership?: OwnershipInfo; error?: string } }
  | { event: 'recover.result'; data: { result: 'recovered' | 'incomplete' | 'refused'; message: string; actions: string[] } };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
async function readGateway(d: RecoverDeps, entry: MachineEntry, fleetId: FleetId): Promise<Held> {
  let answer: OwnerAnswer;
  try { answer = await d.gateway(entry)('get', fleetId); } catch (e) { return { state: 'unreachable', message: messageOf(e) }; }
  if ('record' in answer) return { state: 'record', record: answer.record };
  const { code, message } = answer.error;
  if (code === 'not_found') return { state: 'absent' };
  // the machine answered, and only its authority did not: that gateway is down, not lost
  if (code === 'disconnected' || code === 'timeout') return { state: 'refused', message: `its machine answered, and its authority did not: ${message}` };
  return { state: code === 'authority_corrupt' ? 'corrupt' : 'refused', message };
}

/** This machine's owner.json and journal as they lie, read without its daemon and without changing either. */
function onDisk(fleetHome: string): OwnershipInfo | undefined {
  const paths = resolvePaths(fleetHome);
  const read = (file: string): unknown => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
  const owner = OwnerCache.safeParse(read(paths.owner));
  if (!owner.success) return undefined;
  const { frozen, surrendered, ...record } = owner.data;
  const j = HandoverJournal.safeParse(read(paths.journal));
  return {
    ...record, frozen: frozen === true || surrendered === true, ...(surrendered && { surrendered }),
    ...(j.success && { journal: { role: j.data.role, transactionId: j.data.transactionId, generation: handoverGeneration(j.data), phase: j.data.phase } }),
  };
}

async function look(d: RecoverDeps, m: MachineEntry): Promise<MachineView> {
  const base = { machineId: m.id, name: m.record.name };
  try {
    const daemon = await d.daemon(m);
    try { return { ...base, ownership: await daemon.call('ownership.get', {}), from: 'daemon' }; } finally { daemon.close(); }
  } catch (e) {
    const disk = m.id === d.registry.localId ? onDisk(d.fleetHome) : undefined;
    return { ...base, unreachable: messageOf(e), ...(disk && { ownership: disk, from: 'disk' as const }) };
  }
}

// read without moving one it cannot parse aside; one it cannot read at all is none to show
function controllerJournal(fleetHome: string): ControllerJournal | undefined {
  try { return fileStore(path.join(fleetHome, 'controller')).read(); } catch { return undefined; }
}

function lastKnown(id: MachineId, held: Held, c: ControllerJournal | undefined, route: CachedRoute | undefined): string[] {
  const tx = c?.transactionId ?? '(not begun)';
  return [
    ...(held.state === 'record' && held.record.ownerMachineId === id ? [`owner at generation ${held.record.generation} (the gateway's record)`] : []),
    ...(route?.ownerMachineId === id ? [`owner at generation ${route.generation} (route cache, ${route.at})`] : []),
    ...(c?.source.machineId === id ? [`source of handover ${tx} at generation ${c.generation}, at ${c.phase} (controller journal)`] : []),
    ...(c?.destination.machineId === id ? [`destination of handover ${tx}, taking generation ${c.generation + 1} at ${c.phase} (controller journal)`] : []),
  ];
}

/** Every generation read anywhere; a journal, or a handover the gateway holds open, counts at the generation it would move the fleet to. */
function generations(gateways: { name: string; held?: Held }[], machines: MachineView[], c: ControllerJournal | undefined, route: CachedRoute | undefined): Shown[] {
  const out: Shown[] = [];
  for (const g of gateways) {
    if (g.held?.state !== 'record') continue;
    const { generation, transaction: tx } = g.held.record;
    out.push({ source: `gateway ${g.name}`, generation });
    if (tx && tx.phase !== 'committed') out.push({ source: `gateway ${g.name} handover ${tx.id}`, generation: generation + 1 });
  }
  for (const m of machines) {
    if (!m.ownership) continue;
    out.push({ source: `${m.name} owner.json${m.from === 'disk' ? ' on disk' : ''}`, generation: m.ownership.generation });
    const j = m.ownership.journal;
    if (j) out.push({ source: `${m.name} ${j.role} journal ${j.transactionId}`, generation: j.generation });
  }
  if (c) out.push({ source: `controller journal ${c.transactionId ?? '(not begun)'}`, generation: c.generation + 1 });
  if (route) out.push({ source: 'route cache', generation: route.generation });
  return out;
}

const risks = (o: { owner: string; gateway: string; lost?: string }): string[] => [
  `${o.lost ? `This machine asks ${o.gateway} who owns this fleet when its daemon next starts` : `This machine and ${o.gateway} ask ${o.gateway} who owns this fleet when their daemons next start`}; any other machine not reached here never asks on its own, and one that still runs this fleet goes on running it until this command is run again once it answers.`,
  `Work done since the last handover on a machine that loses the fleet stays on that machine's disk only; none of it is carried to ${o.owner}.`,
  'A machine reached here that loses the fleet closes its terminals now, and a handover this record supersedes never activates what it prepared.',
  ...(o.lost ? [`A machine not reached here still names ${o.lost} as the gateway, so it does not learn of this record by itself.`] : []),
];

function describeHeld(h: Held, name: (id: MachineId) => string): string {
  switch (h.state) {
    case 'record': {
      const tx = h.record.transaction;
      const open = tx ? `, in handover ${tx.id} from ${name(tx.fromMachineId)} to ${name(tx.toMachineId)} (${tx.phase})` : '';
      return `${name(h.record.ownerMachineId)} owns this fleet at generation ${h.record.generation}${open}`;
    }
    case 'absent': return 'holds no record of this fleet';
    case 'corrupt': return `cannot read its record of this fleet: ${h.message}`;
    case 'refused': return `refused: ${h.message}`;
    case 'unreachable': return `did not answer: ${h.message}`;
  }
}

/**
 * `svall fleet recover --force-owner`: shows what every party holds of the fleet, then, confirmed by the fleet id,
 * writes a record naming the chosen owner at the gateway above every generation shown, audits it on both sides,
 * and hands it to every machine that answers. A gateway that is gone for good can be replaced by one that holds none.
 */
export async function recoverFleet(o: RecoverOptions, d: RecoverDeps): Promise<boolean> {
  const refuse = (message: string, actions: string[] = []): false => {
    d.emit({ event: 'recover.result', data: { result: 'refused', message, actions } });
    return false;
  };
  const svall = `svall${o.profile ? ` -p ${o.profile}` : ''}`;
  const file = resolvePaths(d.fleetHome).fleetConfig;
  let fleet: FleetConfig;
  try {
    fleet = FleetConfig.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    return refuse(`${file} is not a fleet config: ${messageOf(e)}`);
  }
  const gatewayId = fleet.gatewayMachineId;
  if (!gatewayId) return refuse(`${file} names no gateway: no other machine can hold this fleet, so there is nothing to recover`);
  const owner = d.registry.get(o.forceOwner);
  if (!owner) return refuse(`no machine ${o.forceOwner} in the registry${d.registry.setAside()}`, ['svall host list names every machine this controller knows']);
  const current = d.registry.get(gatewayId);
  const replacement = o.gateway === undefined ? undefined : d.registry.get(o.gateway);
  if (o.gateway !== undefined && !replacement) return refuse(`no machine ${o.gateway} in the registry${d.registry.setAside()}`, ['svall host list names every machine this controller knows']);
  if (replacement?.id === gatewayId) return refuse(`${replacement.record.name} is already this fleet's gateway; leave out --gateway`);

  const [held, replaced, looked] = await Promise.all([
    current ? readGateway(d, current, fleet.id) : Promise.resolve<Held>({ state: 'unreachable', message: `${gatewayId} is not a machine in the registry${d.registry.setAside()}` }),
    replacement ? readGateway(d, replacement, fleet.id) : Promise.resolve(undefined),
    Promise.all(d.registry.list().map((m) => look(d, m))),
  ]);
  const c = controllerJournal(d.fleetHome);
  const route = readRoute(d.fleetHome);
  const machines = looked.map((m) => (m.from === 'daemon' ? m : { ...m, lastKnown: lastKnown(m.machineId, held, c, route) }));
  const gatewayName = current?.record.name ?? gatewayId;
  const shown = generations([{ name: gatewayName, held }, ...(replacement ? [{ name: replacement.record.name, held: replaced }] : [])], machines, c, route);
  const generation = Math.max(0, ...shown.map((s) => s.generation)) + 1;
  const nameOf = (id: MachineId): string => d.registry.get(id)?.record.name ?? id;

  // the record the write is swapped against, or why there is no gateway to write it at
  let expected: OwnerRecord | null | undefined;
  let refusal: [string, string[]] = ['', []];
  const replaceStep = `if ${gatewayName} is gone for good, name a machine from the registry to take its place: ${svall} fleet recover --force-owner ${o.forceOwner} --gateway <machine>`;
  if (replacement) {
    const name = replacement.record.name;
    if (held.state !== 'unreachable' && held.state !== 'corrupt') refusal = [`${gatewayName} is not lost, since it answered (${describeHeld(held, nameOf)}): recover through it and leave out --gateway`, []];
    else if (replaced?.state === 'absent') expected = null;
    else if (replaced?.state === 'record') refusal = [`${name} already holds a record of this fleet (${describeHeld(replaced, nameOf)}); a replacement gateway must hold none`, []];
    else if (replaced) refusal = [`${name} ${describeHeld(replaced, nameOf)}`, []];
  } else if (held.state === 'record') {
    expected = held.record;
  } else if (held.state === 'absent') {
    expected = null;
  } else if (held.state === 'unreachable') {
    refusal = [`the gateway ${gatewayName} did not answer: ${held.message}`, [replaceStep]];
  } else if (held.state === 'corrupt') {
    refusal = [`the gateway ${gatewayName} cannot read its record of this fleet: ${held.message}`, [`put a readable record back on ${gatewayName}, then run this again`, replaceStep]];
  } else {
    refusal = [`the gateway ${gatewayName} refused: ${held.message}`, []];
  }
  const into = replacement ?? current;
  const plan = expected !== undefined && into
    ? { ownerMachineId: owner.id, owner: owner.record.name, generation, gatewayMachineId: into.id, gateway: into.record.name }
    : undefined;

  d.emit({
    event: 'recover.observed',
    data: {
      fleetId: fleet.id,
      gateway: { machineId: gatewayId, name: gatewayName, ...held },
      ...(replacement && replaced && { replacement: { machineId: replacement.id, name: replacement.record.name, ...replaced } }),
      machines,
      ...(c && { controller: { ...(c.transactionId && { transactionId: c.transactionId }), generation: c.generation, phase: c.phase, source: c.source.name, destination: c.destination.name } }),
      ...(route && { route }),
      shown,
      ...(plan && { plan }),
      risks: plan ? risks({ owner: plan.owner, gateway: plan.gateway, ...(replacement && { lost: gatewayName }) }) : [],
    },
  });
  if (!plan || !into || expected === undefined) return refuse(...refusal);

  const typed = o.confirm ?? (d.interactive ? await d.ask('Type the fleet id to write this record: ') : undefined);
  if (typed === undefined) return refuse('nothing was written: a run with no terminal to ask in names the fleet with --confirm <fleet id>');
  if (typed !== fleet.id) return refuse('nothing was written: that is not this fleet\'s id');

  const situation = replacement
    ? `${gatewayName} ${describeHeld(held, nameOf)}; ${replacement.record.name} replaces it`
    : `${gatewayName} held: ${describeHeld(held, nameOf)}`;
  const reason = `svall fleet recover --force-owner ${owner.record.name}: ${situation}`;
  let forced: OwnerRecord;
  try {
    const answer = await d.gateway(into)('force', fleet.id, {
      expected, ownerMachineId: owner.id, generation, requestingMachineId: d.registry.localId, reason, shown,
    });
    if ('error' in answer) {
      return answer.error.code === 'record_changed'
        ? refuse(`nothing was written: ${into.record.name}'s record of this fleet changed while this ran (${answer.error.message})`, ['run this again to see the record as it stands now'])
        : refuse(`${into.record.name} refused the record: ${answer.error.message}`);
    }
    forced = answer.record;
  } catch (e) {
    return refuse(`${into.record.name} did not answer the write, so whether it landed is unknown: ${messageOf(e)}`, ['run this again: it shows the record the gateway holds']);
  }
  d.emit({ event: 'recover.forced', data: { gatewayMachineId: into.id, record: forced } });

  const actions: string[] = [];
  try {
    appendDurable(path.join(d.fleetHome, 'controller', 'recoveries.ndjson'), {
      at: d.now().toISOString(), fleetId: fleet.id, gatewayMachineId: into.id, before: expected, after: forced,
      requestingMachineId: d.registry.localId, reason, shown,
    });
  } catch (e) {
    actions.push(`the record is written, and this machine's audit of it could not be: ${messageOf(e)}`);
  }
  // the controller finds the fleet's gateway here whether or not this machine's daemon answers
  if (replacement) {
    try { patchFleetConfig(file, { gatewayMachineId: replacement.id }); } catch (e) {
      actions.push(`${file} could not be changed to name ${replacement.record.name} the gateway (${messageOf(e)}); set its gatewayMachineId to ${replacement.id}`);
    }
  }
  rememberOwner(d.fleetHome, forced, d.now());

  const tell = async (m: MachineView): Promise<{ ownership?: OwnershipInfo; adopted?: boolean; error?: string }> => {
    try {
      const daemon = await d.daemon(d.registry.get(m.machineId)!);
      try {
        const r = await daemon.call('ownership.adopt', { record: forced, gatewayMachineId: into.id });
        d.emit({ event: 'recover.adopted', data: { machineId: m.machineId, name: m.name, adopted: r.adopted, ...(r.superseded && { superseded: r.superseded }), ownership: r.ownership } });
        return r;
      } finally {
        daemon.close();
      }
    } catch (e) {
      d.emit({ event: 'recover.adopted', data: { machineId: m.machineId, name: m.name, error: messageOf(e) } });
      return { error: messageOf(e) };
    }
  };
  const behind = machines.filter((m) => m.from !== 'daemon');
  const reached = machines.filter((m) => m.from === 'daemon');
  // the machines the record does not name let go first, so the one it names never starts beside them
  const stillRunning: string[] = [];
  for (const m of reached.filter((x) => x.machineId !== owner.id)) {
    const r = await tell(m);
    if (r.adopted) continue;
    behind.push(m);
    const now = r.ownership ?? m.ownership;
    if (now?.ownerMachineId === m.machineId && !now.frozen) stillRunning.push(m.name);
  }
  const chosen = reached.find((m) => m.machineId === owner.id);
  let notTaken: string | undefined = 'its daemon did not answer';
  if (chosen && stillRunning.length) {
    notTaken = `${stillRunning.join(' and ')} ran this fleet and could not be told, so ${owner.record.name} was not told to run it`;
    behind.push(chosen);
  } else if (chosen) {
    const r = await tell(chosen);
    notTaken = r.adopted ? undefined : r.error ?? 'it took nothing';
    if (notTaken) behind.push(chosen);
  }

  const again = `${svall} fleet recover --force-owner ${o.forceOwner}`;
  // only this machine, through this controller's registry and the fleet.json written above, and the gateway's own
  // machine, through its socket, ask the gateway when their daemons start
  const asksAtStart = (id: MachineId): boolean => id === d.registry.localId || (!replacement && id === into.id);
  actions.push(...behind.map(({ machineId, name }) => {
    if (stillRunning.includes(name)) return `${name} still runs this fleet: stop it there or get its daemon to answer, then run \`${again}\` again`;
    if (machineId === owner.id && stillRunning.length && asksAtStart(machineId)) {
      return `${name} takes this record when its daemon next starts, whether or not ${stillRunning.join(' and ')} still runs this fleet: stop it on ${stillRunning.join(' and ')} first, or it runs on both`;
    }
    if (asksAtStart(machineId)) return `${name} takes this record when its daemon next starts and reaches ${into.record.name}; until then it may still be running the fleet`;
    return replacement
      ? `${name}'s daemon still names ${gatewayName} as the gateway: once it answers, run \`${again}\` again before it starts this fleet`
      : `${name} does not ask ${into.record.name} on its own: once it answers, run \`${again}\` again, before it runs this fleet`;
  }));
  if (notTaken) {
    d.emit({ event: 'recover.result', data: { result: 'incomplete', message: `the record is written on ${into.record.name}, and ${owner.record.name} has not taken it: ${notTaken}`, actions } });
    return false;
  }
  d.emit({ event: 'recover.result', data: { result: 'recovered', message: `${owner.record.name} owns this fleet at generation ${forced.generation}, as ${into.record.name} now records`, actions } });
  return true;
}

function describeMachine(m: MachineView, name: (id: MachineId) => string): string {
  const parts: string[] = [];
  const own = m.ownership;
  if (own) {
    const marks = [own.frozen && 'frozen', own.surrendered && 'surrendered'].filter(Boolean).join(', ');
    parts.push(`${name(own.ownerMachineId)} owns this fleet at generation ${own.generation}${marks ? ` (${marks})` : ''}`);
    const j = own.journal;
    if (j) parts.push(`journal: ${j.role} of handover ${j.transactionId} at ${j.phase}, moving the fleet to generation ${j.generation}`);
  }
  if (m.unreachable) parts.push(own ? `read from disk, since its daemon did not answer: ${m.unreachable}` : `unreachable: ${m.unreachable}`);
  if (m.lastKnown?.length) parts.push(`last known: ${m.lastKnown.join('; ')}`);
  return `  ${m.name}: ${parts.join('; ')}`;
}

/** One event as the lines a person reads. */
export function render(e: RecoverEvent, name: (id: MachineId) => string): string {
  switch (e.event) {
    case 'recover.observed': {
      const o = e.data;
      return [
        `fleet ${o.fleetId}`,
        `gateway ${o.gateway.name}: ${describeHeld(o.gateway, name)}`,
        ...(o.replacement ? [`replacement gateway ${o.replacement.name}: ${describeHeld(o.replacement, name)}`] : []),
        'machines:',
        ...o.machines.map((m) => describeMachine(m, name)),
        ...(o.controller ? [`controller journal: handover ${o.controller.transactionId ?? '(not begun)'} from ${o.controller.source} to ${o.controller.destination} at ${o.controller.phase}, from generation ${o.controller.generation}`] : []),
        ...(o.route ? [`route cache: ${name(o.route.ownerMachineId)} at generation ${o.route.generation} (${o.route.at})`] : []),
        `generations seen: ${o.shown.map((s) => `${s.source} ${s.generation}`).join(', ') || 'none'}`,
        ...(o.plan ? [
          '',
          `This writes a new authority on ${o.plan.gateway}: ${o.plan.owner} owns this fleet at generation ${o.plan.generation}.`,
          'risks:',
          ...o.risks.map((r) => `  - ${r}`),
        ] : []),
      ].join('\n');
    }
    case 'recover.forced':
      return `written on ${name(e.data.gatewayMachineId)}: ${name(e.data.record.ownerMachineId)} owns this fleet at generation ${e.data.record.generation}`;
    case 'recover.adopted': {
      const a = e.data;
      if (a.error) return `  ${a.name}: not told (${a.error})`;
      const role = a.ownership?.ownerMachineId === a.machineId ? 'runs the fleet' : 'is a read-only replica';
      return `  ${a.name}: ${a.adopted ? `took the record and ${role}` : 'took nothing: it holds this record or a newer one, or a handover the record does not supersede'}${a.superseded ? `; handover ${a.superseded} is let go` : ''}`;
    }
    case 'recover.result':
      return [e.data.message, ...(e.data.actions.length ? ['next:', ...e.data.actions.map((a) => `  ${a}`)] : [])].join('\n');
  }
}

export function fleetCommands(home: () => string, json: () => boolean, profile: () => string | undefined, target: () => Target): Command {
  const fleet = new Command('fleet').description('the fleet as a whole, across the machines it can run on');
  fleet.addCommand(provisionCommand(target, json));
  fleet.command('recover')
    .description('disaster recovery: write a new ownership record at the gateway, after showing every generation and the risks; never part of an ordinary retry')
    .requiredOption('--force-owner <machine>', 'the machine that is to own the fleet, or local for this one')
    .option('--confirm <fleet id>', 'the fleet id, typed out: how a run with no terminal to ask in confirms')
    .option('--gateway <machine>', 'a machine from the registry, holding no record of this fleet, to take over from a gateway that is gone for good')
    .action(async (o: { forceOwner: string; confirm?: string; gateway?: string }) => {
      // the masters this opens must not outlive a Ctrl-C
      closeMastersOnSignal();
      const registry = MachineRegistry.load();
      const masters = new Masters();
      const fleetHome = home();
      const name = (id: MachineId): string => registry.get(id)?.record.name ?? id;
      const out = json()
        ? (e: RecoverEvent) => { process.stdout.write(`${JSON.stringify(e)}\n`); }
        : (e: RecoverEvent) => { process.stdout.write(`${render(e, name)}\n`); };
      let fleetId: FleetId | undefined;
      try { fleetId = FleetConfig.parse(JSON.parse(fs.readFileSync(resolvePaths(fleetHome).fleetConfig, 'utf8'))).id; } catch { /* recoverFleet names the problem */ }
      const daemon = async (entry: MachineEntry): Promise<DaemonPort> => {
        if (!fleetId) throw new Error('no fleet here');
        const { client } = await openDaemon(entry, { localId: registry.localId, fleetHome, fleetId, profile: profile(), masters });
        return { call: (m, p) => client.call(m, p), close: () => client.close() };
      };
      try {
        const ok = await recoverFleet({ ...o, profile: profile() }, {
          fleetHome, registry,
          gateway: (entry) => authorityOp(entry, registry.localId, masters),
          daemon,
          interactive: !json() && process.stdin.isTTY === true,
          ask: (q) => ask(q),
          emit: out,
          now: () => new Date(),
        });
        process.exitCode = ok ? 0 : 1;
      } finally {
        await masters.close();
      }
    });
  return fleet;
}
