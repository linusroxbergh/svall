import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineId, MachineRecord } from '@svall/protocol';
import { writeDurable } from '@svall/svalld/durable';
import { configDir, machineId, Registry, registryFile } from '@svall/svalld/machine';
import { svallHome } from '@svall/svalld/paths';

export type MachineEntry = { id: MachineId; record: MachineRecord };

/** The alias for the machine the command runs on; ownership is written with ids, so it is never stored. */
export const LOCAL = 'local';

// `svall handover` reads these as its own words before a machine's name
const HANDOVER_WORDS = ['on', 'off', 'status', 'attach'];

/** Why `name` can never be a machine's: it is `local` or a word of `svall handover`'s. */
export function reservedName(name: string): string | undefined {
  if (name === LOCAL) return 'local is an alias for the machine in hand, not a name';
  if (HANDOVER_WORDS.includes(name)) return `${name} is a word svall handover takes as its own, not a name`;
  return undefined;
}

const NAME = MachineRecord.shape.name;

function localName(hostname: string, taken: string[]): string {
  const short = hostname.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
  const base = NAME.safeParse(short).success && !reservedName(short) ? short : (process.platform === 'linux' ? 'linux' : 'mac');
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}

function localRecord(hostname: string, taken: string[]): MachineRecord {
  return {
    name: localName(hostname, taken),
    platform: process.platform === 'linux' ? 'linux' : 'darwin',
    arch: process.arch,
    home: os.homedir(),
    svallBase: svallHome(),
    gateway: false,
  };
}

/** Every machine this controller can reach, kept beside the machine id in `~/.config/svall`. */
export class MachineRegistry {
  private constructor(
    private readonly file: string,
    readonly localId: MachineId,
    private readonly machines: Map<MachineId, MachineRecord>,
    /** the latest copy a registry that could not be read was kept as, now or at an earlier load, for the CLI to name */
    readonly recovered?: string,
  ) {}

  static load(dir: string = configDir(), o: { hostname?: string; warn?: (line: string) => void } = {}): MachineRegistry {
    const id = machineId(dir);
    const file = registryFile(dir);
    let machines = new Map<MachineId, MachineRecord>();
    if (fs.existsSync(file)) {
      try {
        machines = new Map(Object.entries(Registry.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).machines) as [MachineId, MachineRecord][]);
      } catch (e) {
        const aside = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.renameSync(file, aside);
        (o.warn ?? ((l) => { process.stderr.write(`svall: ${l}\n`); }))(`${file} could not be read (${e instanceof SyntaxError ? e.message : 'it is not a registry of machines'}), so it was moved to ${aside} and a registry of this machine alone begins`);
      }
    }
    // an ISO time in the name sorts the latest last
    const recovered = fs.readdirSync(dir).filter((f) => f.startsWith('machines.json.broken-')).sort().map((f) => path.join(dir, f)).at(-1);
    const registry = new MachineRegistry(file, id, machines, recovered);
    if (!machines.has(id)) {
      machines.set(id, localRecord(o.hostname ?? os.hostname(), [...machines.values()].map((m) => m.name)));
      registry.save();
    }
    return registry;
  }

  save(): void {
    writeDurable(this.file, { machines: Object.fromEntries(this.machines) });
  }

  /** What a lookup that found no machine adds: where a registry that could not be read went, with every machine it named. */
  setAside(): string {
    return this.recovered
      ? `; the registry could not be read once and was moved to ${this.recovered}, with every machine it named: fix that file and move it back to ${this.file}, or add each machine again with \`svall host add\``
      : '';
  }

  localMachine(): MachineRecord {
    return this.machines.get(this.localId) as MachineRecord;
  }

  list(): MachineEntry[] {
    return [...this.machines].map(([id, record]) => ({ id, record }));
  }

  get(idOrName: string): MachineEntry | undefined {
    if (idOrName === LOCAL) return { id: this.localId, record: this.localMachine() };
    const held = this.machines.get(idOrName as MachineId);
    if (held) return { id: idOrName as MachineId, record: held };
    return this.list().find((m) => m.record.name === idOrName);
  }

  add(record: MachineRecord, id: string = crypto.randomUUID()): MachineEntry {
    const parsed = MachineRecord.parse(record);
    this.claimName(parsed.name);
    const machine = MachineId.parse(id);
    if (this.machines.has(machine)) throw new Error(`the machine ${machine} is already in the registry`);
    this.machines.set(machine, parsed);
    return { id: machine, record: parsed };
  }

  rename(idOrName: string, name: string): void {
    const entry = this.need(idOrName);
    this.claimName(NAME.parse(name));
    this.machines.set(entry.id, { ...entry.record, name });
  }

  clearGateway(idOrName: string): void {
    const entry = this.need(idOrName);
    this.machines.set(entry.id, { ...entry.record, gateway: false });
  }

  remove(idOrName: string): void {
    const entry = this.need(idOrName);
    if (entry.id === this.localId) throw new Error('the local machine cannot be removed from the registry');
    this.machines.delete(entry.id);
  }

  private need(idOrName: string): MachineEntry {
    const entry = this.get(idOrName);
    if (!entry) throw new Error(`no machine ${idOrName} in the registry${this.setAside()}`);
    return entry;
  }

  private claimName(name: string): void {
    const reserved = reservedName(name);
    if (reserved) throw new Error(reserved);
    if (this.list().some((m) => m.record.name === name)) throw new Error(`a machine named ${name} is already in the registry`);
  }
}
