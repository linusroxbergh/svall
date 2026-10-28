import { useEffect, useState } from 'react';
import { toTick, type MachineId, type SetupRow } from '@svall/protocol';
import { app } from './boot.js';
import { terminalOn } from './MoveSheet.js';
import { Section } from './Section.js';

/** What of a placed robot's agent setup will not work on its machine, each with its one way on: copy its keys, a terminal there, or what to do. */
export function OnMachine({ id, machine, name }: { id: string; machine: MachineId; name: string }) {
  const [rows, setRows] = useState<SetupRow[]>([]);
  const read = () => app.api().call('machines.setup', { machine, robot: id }).then((r) => setRows(r.rows.filter((x) => x.gap)), () => {});
  useEffect(() => { void read(); }, [id, machine]);
  const copy = ({ item, fields }: NonNullable<SetupRow['tick']>) => app.api().call('machines.consent', { machine, item, fields, on: true })
    .then(read, (e: Error) => app.store.getState().showToast(e.message, 'error'));
  if (!rows.length) return null;
  return (
    <Section name="robot.machine" title={`On ${name}`}>
      <div className="rows">
        {rows.map((r) => (
          <div key={r.key} className="row" data-testid={`side-gap-${r.key}`}>
            <span><b>{r.gap!.name}</b> {r.gap!.what}</span>
            {toTick(r) ? (
              <b><button className="btn set-open" data-testid={`side-gap-copy-${r.key}`} onClick={() => void copy(r.tick!)}>Copy keys</button></b>
            ) : r.run ? (
              <b><button className="btn set-open" data-testid={`side-gap-terminal-${r.key}`} title={`Opens a terminal on ${name} with ${r.run} typed, for you to run`}
                onClick={() => terminalOn(name, r.run, r.forward)}>Open terminal</button></b>
            ) : r.action && <b>{r.action}</b>}
          </div>
        ))}
      </div>
    </Section>
  );
}
