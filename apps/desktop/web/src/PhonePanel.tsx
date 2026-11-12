import { useEffect, useRef, useState } from 'react';
import type { MobileStatus } from '@svall/protocol';
import { loadMobileStatus, serveFleet } from './actions.js';
import { app, deps } from './boot.js';
import { copyText } from './bridge.js';
import { useApp } from './hooks.js';
import { Copy } from './icons.js';
import { NO_PAGE, OFF, phonesHere, phoneProblem, sayingPhone } from './phoneText.js';
import { homeName } from './placement.js';
import { Said } from './Said.js';

/** Runs mobile.set and keeps the answer, so the switch, the utility dock and the settings row move together. */
export function useMobileSwitch(): { status?: MobileStatus; busy: boolean; flip(): void } {
  const status = useApp((s) => s.mobile);
  const [busy, setBusy] = useState(false);
  const flip = () => {
    if (busy) return;
    setBusy(true);
    void serveFleet(deps(), !status?.serving).finally(() => setBusy(false));
  };
  return { status, busy, flip };
}

/** `sw`: the switch's state as its pane holds it, to say what the switch is doing. */
export function MobileSwitch({ testId, sw }: { testId: string; sw?: ReturnType<typeof useMobileSwitch> }) {
  const own = useMobileSwitch();
  const { status, busy, flip } = sw ?? own;
  const on = !!status?.serving;
  return (
    <button className="set-switch" role="switch" aria-checked={on} data-testid={testId} disabled={busy} onClick={flip}>
      {busy ? '…' : on ? 'on' : 'off'}
    </button>
  );
}

/** What keeps the phone link from serving, with a terminal for its fix on the home that serves it. `settings`: the fix as a Settings note. */
export function PhoneProblem({ settings }: { settings?: boolean }) {
  const status = useApp((s) => s.mobile);
  const home = useApp((s) => s.via && homeName(s.fleet, s.via));
  useEffect(sayingPhone, []);
  const problem = status && phoneProblem(status);
  if (!problem) return null;
  return <div data-testid="mobile-problem"><Said {...problem} on={home} settings={settings} /></div>;
}

/** Once the fleet is served, the link to reach it by; the panel's title carries the switch. Compact shows the QR and link alone, `'qr'` the QR alone. */
export function MobilePanel({ compact = false }: { compact?: boolean | 'qr' }) {
  const status = useApp((s) => s.mobile);
  const redact = useApp((s) => s.phoneRedact);
  const [copied, setCopied] = useState(false);
  const revert = useRef<number>(undefined);
  useEffect(() => { loadMobileStatus(deps()); return () => { window.clearTimeout(revert.current); app.store.getState().setPhoneRedact(undefined); }; }, []);
  const copy = () => {
    if (!status?.url) return;
    // the copied link pairs the phone, as the QR code does
    copyText(app.bridge, status.pair ?? status.url);
    setCopied(true);
    window.clearTimeout(revert.current);
    revert.current = window.setTimeout(() => setCopied(false), 1500);
  };

  if (!status) return null;
  const qr = status.serving && status.qr && <img className="mob-qr" src={redact ?? status.qr} alt={`QR code for ${status.url}`} />;
  const link = status.serving && (
    <>
      {qr}
      <button className="mob-url" data-testid="mobile-url" data-tip={redact ? 'Copy the link' : `Copy ${status.url}`} onClick={copy}>
        <span>{redact ? <><i className="mob-mask" /><i className="mob-mask" /></> : copied ? 'copied' : status.url}</span><Copy />
      </button>
    </>
  );
  if (compact) return <div className="mob" data-testid="mobile-body">{compact === 'qr' ? qr : link}</div>;
  return (
    <div className="mob" data-testid="mobile-body">
      {status.serving && (
        <>
          {link}
          <div className="mob-here" data-testid="mobile-here" data-live={status.phones.length > 0 || undefined}>{phonesHere(status.phones)}</div>
        </>
      )}
      <PhoneProblem />
      {status.serving ? (
        <>
          <div className="use-note">
            {status.pageMissing && <><b data-testid="mobile-nopage">{NO_PAGE}</b>{' '}</>}
            {status.logins.length ? <>Only {redact ? <i className="mob-mask" /> : status.logins.join(', ')} can connect.</> : 'No login can connect yet.'}
            {' '}Settings → Phone says how to add a login.
          </div>
          <ol className="mob-steps" data-testid="mobile-steps">
            <li>Scan the code with your phone's camera.</li>
            <li>Tap Share, then Add to Home Screen.<span className="modal-sub">Safari: the square with an arrow, at the bottom. Chrome: the same mark, right of the address bar.</span></li>
            <li>Open Svall from the new icon and allow notifications.</li>
          </ol>
        </>
      ) : !phoneProblem(status) && <div className="use-note">{OFF}</div>}
    </div>
  );
}
