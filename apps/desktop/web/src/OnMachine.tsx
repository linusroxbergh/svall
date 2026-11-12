import { useEffect, useState, type ReactNode } from 'react';
import { aside, asideLine, keyLabel, notNeeded, toTick, type MachineId, type SetupRow } from '@svall/protocol';
import { app } from './boot.js';
import { useApp } from './hooks.js';
import { cdLine, hasRoute } from './host.js';
import { startHost } from './hostRun.js';
import { terminalOn } from './MoveSheet.js';
import { copiedAt, machineOf } from './placement.js';
import { Section } from './Section.js';
import { VarField } from './VarField.js';

export { cdLine, hasRoute };

/** Whether a terminal on `name` can be offered from this Mac; none for no machine. */
export function useRoute(name: string | undefined): boolean {
  const route = useApp((s) => name !== undefined && hasRoute(s, name));
  const known = useApp((s) => !!s.machines && !s.machinesError && s.machines.some((m) => m.name === name));
  // a machine added since the list was read is missing from it, so the list is asked for once more
  useEffect(() => { if (name !== undefined && !known) app.bridge.send({ type: 'host.list' }); }, [name]);
  return route;
}

/**
 * A shell on the machine for what only it can reach, with a `cd` to `dir` typed there; a machine this Mac has no ssh to, such
 * as another Mac, offers none, and one out of reach, `away` saying why, offers it disabled.
 */
export function TerminalThere({ name, dir, className = 'btn sm', testid, label = `Shell on ${name}`, away }: {
  name: string; dir: string; className?: string; testid: string; label?: string; away?: string;
}) {
  if (!useRoute(name)) return null;
  return (
    <button className={className} data-testid={testid} disabled={!!away} data-tip={away ?? `A shell on ${name} in ${dir}`}
      onClick={() => terminalOn(name, cdLine(dir))}>{label}</button>
  );
}

/** A check of a robot's machine, which opens the Machines panel on it; a far home's machine goes by its id, as that home may name it as this Mac names another. */
export function useCheck(name: string, id?: string): () => void {
  const far = useApp((s) => !!id && !!s.machines?.find((m) => m.id === id)?.far);
  return () => { app.store.getState().toggleHost(true, name); startHost('doctor', { name, ...(far && { id }) }); };
}

/**
 * What stands in a far robot's pane while its machine does not answer: `line` says why, then when it shows again and a check
 * of that machine; on this Mac's copy of the fleet, how old the copy is and a try at the home again.
 */
export function Away({ id, line, testid }: { id: string; line: string; testid?: string }) {
  const machine = useApp((s) => s.fleet.robots[id]?.machine);
  const name = useApp((s) => (Object.hasOwn(s.fleet.robots, id) ? machineOf(s.fleet, s.fleet.robots[id], s.via) : undefined));
  const copy = useApp((s) => !!s.via && !s.via.online);
  const at = useApp((s) => (s.via && !s.via.online ? s.fleet.machines?.[s.via.home]?.snapshot?.at : undefined));
  const running = useApp((s) => !!s.host?.running);
  const check = useCheck(name ?? '', machine);
  return (
    <div className="away-says">
      <span data-testid={testid}>{line}</span>
      {copy ? (
        <>
          {at !== undefined && <span className="modal-sub">Showing the fleet as of {copiedAt(at)}.</span>}
          <button className="btn sm" data-testid="away-retry" onClick={() => app.api().retryHome()}>Try again</button>
        </>
      ) : (
        <>
          <span className="modal-sub">Its terminal, files and changes show again when it answers.</span>
          {name && <button className="btn sm" data-testid="away-check" disabled={running} onClick={check}>Check {name}</button>}
        </>
      )}
    </div>
  );
}

// a row by what it is, in the window's words: a key to copy, a login, a variable or a program; any other in the machine's own
function gapWords(r: SetupRow): ReactNode {
  const name = r.gap!.name;
  if (toTick(r) && !notNeeded(r)) return <><b>{keyLabel(r)}</b> not copied</>;
  if (r.key.startsWith('oauth:') && r.status === 'warn') return <><b>{name}</b> not logged in</>;
  if (r.key.startsWith('var:') && r.action) return <><b>{name}</b> not set</>;
  if (r.key.startsWith('runtime:') && toTick(r)) return <><b>{name}</b> not installed</>;
  return <><b>{name}</b> {r.gap!.what}{!r.run && r.action && <em>{r.action}</em>}</>;
}

// a gap's terminal on the card, named apart from the robot's own: what it is opened to do
const TERMINAL_FOR: [string, string][] = [['oauth:', 'Log in'], ['runtime:', 'Install']];

/**
 * What of a placed robot's agent setup will not work on its machine, each with its one way on: copy its keys, a terminal
 * there, or what to do; what runs only on a Mac, or you ticked as not needed there, in one line under them. `away`: why
 * the machine is out of reach, which holds a terminal or a variable there; a tick is saved for when it answers.
 */
export function OnMachine({ id, machine, name, away }: { id: string; machine: MachineId; name: string; away?: string }) {
  const [rows, setRows] = useState<SetupRow[]>([]);
  const read = () => app.api().call('machines.setup', { machine, robot: id }).then((r) => setRows(r.rows.filter((x) => x.gap)), () => {});
  // read again once the Machines panel closes, as a login in a terminal there changes the rows
  const hostOpen = useApp((s) => s.hostOpen);
  useEffect(() => { if (!hostOpen) void read(); }, [id, machine, hostOpen]);
  const tick = ({ item, fields }: NonNullable<SetupRow['tick']>) => app.api().call('machines.consent', { machine, item, fields, on: true })
    .then(read, (e: Error) => { app.store.getState().showToast(e, 'error'); return read(); });
  if (!rows.length) return null;
  const apart = asideLine(rows.filter(aside), true);
  return (
    <Section name="robot.machine" title={`On ${name}`} shut>
      <div className="rows">
        {rows.filter((r) => !aside(r)).map((r) => (
          <div key={r.key} className="side-gap" data-testid={`side-gap-${r.key}`}>
            <span>{gapWords(r)}</span>
            {toTick(r) && !notNeeded(r) ? (
              <button className="btn sm" data-testid={`side-gap-copy-${r.key}`} onClick={() => void tick(r.tick!)}>Copy key</button>
            ) : r.key.startsWith('var:') && r.action ? (
              <VarField machine={machine} name={name} varName={r.key.slice('var:'.length)} here={r.here} testid={`side-gap-var-${r.key}`} away={away}
                take={() => () => void read()} failed={(m) => app.store.getState().showToast(m, 'error')} />
            ) : (
              <>
                {r.run && (
                  <button className="btn sm" data-testid={`side-gap-terminal-${r.key}`} disabled={!!away} data-tip={away ?? `Opens a terminal on ${name} with ${r.run} typed, for you to run`}
                    onClick={() => terminalOn(name, r.run, r.forward)}>{TERMINAL_FOR.find(([k]) => r.key.startsWith(k))?.[1] ?? 'Open terminal'}</button>
                )}
                {toTick(r) && (
                  <button className="btn sm" data-testid={`side-gap-skip-${r.key}`} data-tip={`${name} does not need it; the row then stands aside`} onClick={() => void tick(r.tick!)}>Not needed</button>
                )}
              </>
            )}
          </div>
        ))}
        {apart && <div className="side-gap" data-testid="side-gap-aside"><span>{apart}.</span></div>}
      </div>
    </Section>
  );
}
