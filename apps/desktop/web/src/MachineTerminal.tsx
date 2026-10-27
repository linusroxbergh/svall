import { useEffect, useRef, useState } from 'react';
import { app } from './boot.js';
import { loginForward } from './host.js';

/**
 * A terminal on the machine, over an ssh of its own, with `run` typed at its prompt for the user to run or change, and
 * `forward` the port its login waits on there. `onEnd` once the user is done with it or its shell exits.
 */
export function MachineTerminal({ name, ssh, run, forward: port, onEnd }: { name: string; ssh: string; run?: string; forward?: number; onEnd: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const end = useRef(onEnd);
  end.current = onEnd;
  const id = `machine:${name}`;
  const forward = run ? loginForward(run, port) : undefined;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = () => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
    app.bridge.send({ type: 'term.show', id, rect: rect(), machine: { ssh, ...(run && { type: run }), ...(forward && { forward }) } });
    app.bridge.send({ type: 'term.focus', id });
    const move = () => app.bridge.send({ type: 'term.move', id, rect: rect() });
    const ro = new ResizeObserver(move);
    ro.observe(el);
    // the panel scrolls, and is centred in a window that can change size
    const panel = el.closest('.host-body');
    panel?.addEventListener('scroll', move);
    window.addEventListener('resize', move);
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
      off();
      if (!gone) app.bridge.send({ type: 'term.close', id });
    };
  }, [id, ssh, run, forward, attempt]);

  return (
    <div className="host-term" data-testid="host-terminal">
      <div className="host-note" data-testid="host-terminal-note">
        <span>
          {run ? <>On {name}, <code>{run}</code> is typed for you: press Return to run it.</> : <>A terminal on {name}.</>}
          {forward && ` Its sign-in comes back from your browser through port ${forward} on this Mac.`}
          {' ⌘-click a link to open it in your browser.'}
        </span>
      </div>
      {failed && (
        <div className="host-note" data-testid="host-terminal-failed">
          <span className="host-term-failed">
            {failed}
            {forward && /forwarding/.test(failed) && ` Port ${forward} on this Mac is taken${forward === 1455 ? ', as by a Codex login running here; close that' : '; close what uses it'}, then try again.`}
          </span>
          <div className="acts">
            <button className="btn" data-testid="host-terminal-again" onClick={() => { setFailed(undefined); setAttempt((a) => a + 1); }}>Try again</button>
          </div>
        </div>
      )}
      <div ref={ref} className="host-term-surface" data-testid="host-terminal-surface" />
      <div className="acts">
        <button className="btn" data-testid="host-terminal-done" title="Close the terminal and go back to the checks" onClick={onEnd}>Done</button>
      </div>
    </div>
  );
}
