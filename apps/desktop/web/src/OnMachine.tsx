import { useEffect, useState } from 'react';
import { aside, asideLine, notNeeded, toTick, type MachineId, type SetupRow } from '@svall/protocol';
import { app } from './boot.js';
import { useApp } from './hooks.js';
import { terminalOn } from './MoveSheet.js';
import { Section } from './Section.js';
import { VarField } from './VarField.js';

/**
 * What of a placed robot's agent setup will not work on its machine, each with its one way on: copy its keys, a terminal
 * there, or what to do; what runs only on a Mac, or you ticked as not needed there, in one line under them.
 */
export function OnMachine({ id, machine, name }: { id: string; machine: MachineId; name: string }) {
  const [rows, setRows] = useState<SetupRow[]>([]);
  const read = () => app.api().call('machines.setup', { machine, robot: id }).then((r) => setRows(r.rows.filter((x) => x.gap)), () => {});
  // read again once the Machines panel closes, as a login in a terminal there changes the rows
  const hostOpen = useApp((s) => s.hostOpen);
  useEffect(() => { if (!hostOpen) void read(); }, [id, machine, hostOpen]);
  const tick = ({ item, fields }: NonNullable<SetupRow['tick']>) => app.api().call('machines.consent', { machine, item, fields, on: true })
    .then(read, (e: Error) => app.store.getState().showToast(e.message, 'error'));
  if (!rows.length) return null;
  const apart = asideLine(rows.filter(aside), true);
  return (
    <Section name="robot.machine" title={`On ${name}`} shut>
      <div className="rows">
        {rows.filter((r) => !aside(r)).map((r) => (
          <div key={r.key} className="side-gap" data-testid={`side-gap-${r.key}`}>
            <span><b>{r.gap!.name}</b> {r.gap!.what}{(!toTick(r) || notNeeded(r)) && !r.run && r.action && <em>{r.action}</em>}</span>
            {toTick(r) && !notNeeded(r) ? (
              <button className="btn set-open" data-testid={`side-gap-copy-${r.key}`} onClick={() => void tick(r.tick!)}>Copy keys</button>
            ) : r.key.startsWith('var:') && r.action ? (
              <VarField machine={machine} name={name} varName={r.key.slice('var:'.length)} here={r.here} testid={`side-gap-var-${r.key}`}
                take={() => () => void read()} failed={(m) => app.store.getState().showToast(m, 'error')} />
            ) : (
              <>
                {r.run && (
                  <button className="btn set-open" data-testid={`side-gap-terminal-${r.key}`} data-tip={`Opens a terminal on ${name} with ${r.run} typed, for you to run`}
                    onClick={() => terminalOn(name, r.run, r.forward)}>Open terminal</button>
                )}
                {toTick(r) && (
                  <button className="btn set-open" data-testid={`side-gap-skip-${r.key}`} data-tip={`${name} does not need it; the row then stands aside`} onClick={() => void tick(r.tick!)}>Not needed</button>
                )}
              </>
            )}
          </div>
        ))}
        {apart && <div className="side-gap" data-testid="side-gap-aside"><span>{apart}</span></div>}
      </div>
    </Section>
  );
}
