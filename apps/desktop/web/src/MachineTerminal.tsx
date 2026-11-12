import { useEffect, useRef, useState } from 'react';
import { app } from './boot.js';
import { rectOf } from './bridge.js';
import { cdDir, loginForward } from './host.js';
import { Caret } from './icons.js';
import { Said } from './Said.js';

// a command longer than this is called the command, and read whole behind details
const SHORT = 48;

/** A terminal on the machine over its own ssh, `run` typed at its prompt and `forward` the port its login waits on there;
 * `asked` the command as asked for, before a far home wraps it in its own ssh, `why` what it is for, and `on` the machine it runs on;
 * `onEnd` once the user is done with it or its shell exits, `back` when that goes back to the machine's checks. */
export function MachineTerminal({ name, on = name, ssh, run, asked, why, forward: port, back, onEnd }: {
  name: string; on?: string; ssh: string; run?: string; asked?: string; why?: string; forward?: number; back: boolean; onEnd: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const end = useRef(onEnd);
  end.current = onEnd;
  const id = `machine:${name}`;
  const forward = run ? loginForward(run, port) : undefined;
  const dir = asked === undefined ? undefined : cdDir(asked);
  // the shell puts the terminal's last line, ssh's own words, after a colon
  const cut = failed?.indexOf(': ') ?? -1;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    app.bridge.send({ type: 'term.show', id, rect: rectOf(el), machine: { ssh, ...(run && { type: run }), ...(forward && { forward }) } });
    app.bridge.send({ type: 'term.focus', id });
    const move = () => app.bridge.send({ type: 'term.move', id, rect: rectOf(el) });
    const ro = new ResizeObserver(move);
    ro.observe(el);
    // the panel scrolls, and is centred in a window that can change size
    const panel = el.closest('.host-body');
    panel?.addEventListener('scroll', move);
    window.addEventListener('resize', move);
    // the dialog rises into place as it opens, which no observer above reports
    const dialog = el.closest('.modal');
    dialog?.addEventListener('animationend', move);
    // the shell lets go of a surface whose ssh ended
    let gone = false;
    const off = app.bridge.onMessage((m) => {
      if (m.type === 'term.exited' && m.id === id) { gone = true; end.current(); }
      if (m.type === 'term.failed' && m.id === id) { gone = true; setFailed(m.reason); }
    });
    return () => {
      ro.disconnect();
      panel?.removeEventListener('scroll', move);
      window.removeEventListener('resize', move);
      dialog?.removeEventListener('animationend', move);
      off();
      if (!gone) app.bridge.send({ type: 'term.close', id });
    };
  }, [id, ssh, run, forward, attempt]);

  return (
    <div className="host-term" data-testid="host-terminal">
      {/* a shell that quit has nothing to press Return in: its failure stands in for the note */}
      {!failed && (
        <div className="host-note" data-testid="host-terminal-note">
          <span>
            {!run ? `A shell on ${on}.` : !asked ? `Press Return to open a shell on ${on}.` : dir !== undefined ? `Press Return to open a shell on ${on} in ${dir}.`
              : why ? `Press Return to ${why} on ${on}.`
              : <>Press Return to run {asked.length > SHORT ? 'the command' : <code>{asked}</code>} on {on}.</>}
            {forward && ` Its sign-in comes back through port ${forward} on this Mac.`}
            {' Click a link to open it in your browser.'}
          </span>
          {run && (
            <details className="modal-more">
              <summary><Caret dir="right" />details</summary>
              <code className="modal-more-body mono">{run}</code>
            </details>
          )}
        </div>
      )}
      {failed && (
        <div className="move-blocker" data-testid="host-terminal-failed">
          <Said line={cut > 0 ? failed.slice(0, cut) : failed} raw={cut > 0 ? failed.slice(cut + 2) : undefined}
            fix={forward && /forwarding/.test(failed) ? `Port ${forward} on this Mac is taken${forward === 1455 ? ', as by a Codex login running here; close that' : '; close what uses it'}, then try again.` : undefined} />
          <button className="btn sm" data-testid="host-terminal-again" onClick={() => { setFailed(undefined); setAttempt((a) => a + 1); }}>Try again</button>
        </div>
      )}
      <div ref={ref} className="host-term-surface" data-testid="host-terminal-surface" />
      <div className="acts">
        <button className="btn" data-testid="host-terminal-done" data-tip={back ? 'Close the terminal and check the machine again' : 'Close the terminal'} onClick={onEnd}>{failed ? 'Close' : 'Done'}</button>
      </div>
    </div>
  );
}
