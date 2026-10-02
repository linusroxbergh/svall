import { useEffect, useState, type JSX } from 'react';
import type { PushStatus } from '@svall/protocol';
import { phone } from './boot.js';
import { disablePush, enablePush, readPush, setPushStatuses, type PushState } from './push.js';
import { Sheet } from './Sheet.js';

const ABOUT: Record<PushStatus, string> = { blocked: 'an agent needs you', done: 'an agent finishes' };

export function Settings({ onClose }: { onClose(): void }): JSX.Element {
  const [push, setPush] = useState<PushState>();
  const [error, setError] = useState<string>();
  const apply = (p: Promise<PushState>) => { setError(undefined); p.then(setPush, (e: Error) => setError(e.message)); };

  useEffect(() => { apply(readPush(phone.api())); }, []);

  const toggle = (s: PushStatus) => {
    if (push?.kind !== 'on') return;
    apply(setPushStatuses(phone.api(), push.statuses.includes(s) ? push.statuses.filter((x) => x !== s) : [...push.statuses, s]));
  };

  return (
    <Sheet title="This phone" onClose={onClose}>
      <div className="sheet-form">
        {push?.kind === 'unsupported' && <p className="sheet-note">This browser cannot receive notifications.</p>}
        {push?.kind === 'install' && <p className="sheet-note">Notifications need the Home Screen app: Share → Add to Home Screen.</p>}
        {push?.kind === 'denied' && <p className="sheet-note">Turn on notifications for Svall in the phone's Settings.</p>}
        {push?.kind === 'off' && <button type="button" className="pri" onClick={() => apply(enablePush(phone.api(), push.publicKey))}>Notify this phone</button>}
        {push?.kind === 'on' && (
          <>
            {(Object.keys(ABOUT) as PushStatus[]).map((s) => (
              <label key={s} className="choice">
                <input type="checkbox" checked={push.statuses.includes(s)} onChange={() => toggle(s)} />
                <span>when {ABOUT[s]}</span>
              </label>
            ))}
            <button type="button" onClick={() => apply(disablePush(phone.api()))}>Stop notifying this phone</button>
          </>
        )}
        {error && <p className="sheet-error">{error}</p>}
      </div>
    </Sheet>
  );
}
