import { useEffect, useRef, useState } from 'react';
import type { MobileStatus } from '@svall/protocol';
import { loadMobileStatus, serveFleet } from './actions.js';
import { app, deps } from './boot.js';
import { copyText } from './bridge.js';
import { useApp } from './hooks.js';
import { NO_PAGE, OFF, phonesHere } from './phoneText.js';

/** Runs mobile.set and keeps the answer, so the switch, the utility dock and the settings row move together. */
function useMobileSwitch(): { status?: MobileStatus; busy: boolean; flip(): void } {
  const status = useApp((s) => s.mobile);
  const [busy, setBusy] = useState(false);
  const flip = () => {
    if (busy) return;
    setBusy(true);
    void serveFleet(deps(), !status?.serving).finally(() => setBusy(false));
  };
  return { status, busy, flip };
}

export function MobileSwitch({ testId }: { testId: string }) {
  const { status, busy, flip } = useMobileSwitch();
  const on = !!status?.serving;
  return (
    <button className="set-switch" role="switch" aria-checked={on} data-testid={testId} disabled={busy} onClick={flip}>
      {busy ? '…' : on ? 'on' : 'off'}
    </button>
  );
}

/** The switch and, once the fleet is served, the link to reach it by. */
export function MobilePanel() {
  const status = useApp((s) => s.mobile);
  const [copied, setCopied] = useState(false);
  const revert = useRef<number>(undefined);
  useEffect(() => { loadMobileStatus(deps()); return () => window.clearTimeout(revert.current); }, []);
  const copy = () => {
    if (!status?.url) return;
    copyText(app.bridge, status.url);
    setCopied(true);
    window.clearTimeout(revert.current);
    revert.current = window.setTimeout(() => setCopied(false), 1500);
  };

  if (!status) return null;
  return (
    <div className="mob" data-testid="mobile-body">
      <div className="mob-head">
        <span className="use-label">phone</span>
        <MobileSwitch testId="mobile-switch" />
      </div>
      {status.serving && (
        <>
          {status.qr && <img className="mob-qr" src={status.qr} alt={`QR code for ${status.url}`} />}
          <button className="mob-url" data-testid="mobile-url" title="Copy the link" onClick={copy}>
            {copied ? 'copied' : status.url}
          </button>
          <div className="mob-here" data-testid="mobile-here" data-live={status.phones.length > 0 || undefined}>{phonesHere(status.phones)}</div>
        </>
      )}
      <div className="use-note">
        {status.serving ? <>
          {status.pageMissing && <><b data-testid="mobile-nopage">{NO_PAGE}</b>{' '}</>}
          {status.logins.length ? `Only ${status.logins.join(', ')} can connect. To add others, list everyone in mobile.logins in config.json and restart the daemon.` : 'No login can connect yet. Add one to mobile.logins in config.json and restart the daemon.'}
          {' '}On the phone: open the link, then Share → Add to Home Screen.
        </> : OFF}
      </div>
    </div>
  );
}
