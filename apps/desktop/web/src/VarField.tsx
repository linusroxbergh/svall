import { useState } from 'react';
import type { MachineId, SetupRow } from '@svall/protocol';
import { app } from './boot.js';
import { AS_TYPED } from './Field.js';

/**
 * A variable row's way on: its value typed here and sent to the machine's .env, or copied from this Mac when it has one.
 * The value lives in this field alone, shown to no one, and is gone once sent; `take`, asked at the send, says where the
 * rows that come back go.
 */
export function VarField({ machine, name, varName, here, take, failed, testid }: {
  machine: MachineId; name: string; varName: string; here?: boolean; take(): (rows: SetupRow[]) => void; failed(message: string): void; testid: string;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const send = (what: { value: string } | { fromMac: true }) => {
    const show = take();
    setBusy(true);
    setValue('');
    app.api().call('machines.setVar', { machine, name: varName, ...what })
      .then(({ rows }) => show(rows), (e: Error) => failed(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <form className="var-field" data-testid={testid} onSubmit={(e) => { e.preventDefault(); if (value) send({ value }); }}>
      <input type="password" className="fld" {...AS_TYPED} data-testid={`${testid}-value`} aria-label={`value for ${varName} on ${name}`} placeholder={`value for ${varName}`}
        value={value} disabled={busy} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="btn set-open" data-testid={`${testid}-set`} disabled={busy || !value} data-tip={`Sets ${varName} in the fleet's .env on ${name}; robots started there from then on have it`}>
        Set on {name}
      </button>
      {here && (
        <button type="button" className="btn set-open" data-testid={`${testid}-copy`} disabled={busy} data-tip={`This Mac has ${varName}; its value goes to ${name} without being shown`}
          onClick={() => send({ fromMac: true })}>Copy from this Mac</button>
      )}
    </form>
  );
}
