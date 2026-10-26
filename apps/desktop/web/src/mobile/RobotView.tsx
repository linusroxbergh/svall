import { FitAddon } from '@xterm/addon-fit';
import { Terminal as Xterm } from '@xterm/xterm';
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { useApp } from '../hooks.js';
import { awayLine } from '../placement.js';
import { statusOf } from '../selectors.js';
import { phone } from './boot.js';
import { RobotMenu } from './RobotMenu.js';
import { statusLabel } from './list.js';
import { dragToScroll, holdScroll, scrollTerm, withoutClicks } from './scroll.js';
import { linkTerminal, type TerminalLink } from './term.js';

// smaller type means more columns; Claude Code's TUI only lays out narrow when the window itself is
const SIZES = [9, 10, 11, 13];
const SIZE_KEY = 'svall.mobile.fontSize';

const tokenOf = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// xterm parses its own colours, so the selection's alpha rides as a hex byte on the token
const theme = () => ({
  background: tokenOf('--surface-0'), foreground: tokenOf('--ink'), cursor: tokenOf('--sel'),
  selectionBackground: `${tokenOf('--sel')}4d`,
});

const KEYS: [string, string][] = [
  ['esc', '\x1b'], ['tab', '\t'], ['^C', '\x03'],
  ['←', '\x1b[D'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['→', '\x1b[C'], ['⏎', '\r'],
];

// the page reloads itself when svalld moves to a newer protocol, so a prompt not yet sent is kept for the tab
const DRAFT = 'svall.mobile.draft.';

// a browser with site data switched off throws rather than returning nothing
const readSize = (): number => {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    return SIZES.includes(v) ? v : 11;
  } catch { return 11; }
};

export function RobotView({ id, onBack }: { id: string; onBack(): void }): JSX.Element {
  const robot = useApp((s) => s.fleet.robots[id]);
  const robotStatus = useApp((s) => (s.fleet.robots[id] ? statusOf(s.fleet.robots[id], s.fleet) : undefined));
  const island = useApp((s) => s.fleet.islands[s.fleet.robots[id]?.islandId ?? '']);
  // what stands over the terminal while the home has lost the worker it runs on; the terminal holds the last screen the home saw
  const unreachable = useApp((s) => { const r = s.fleet.robots[id]; return r && awayLine(s.fleet, r); });
  const status = useApp((s) => s.status);
  const online = status === 'online';
  const host = useRef<HTMLDivElement>(null);
  const link = useRef<TerminalLink>(undefined);
  const xterm = useRef<Xterm>(undefined);
  const refit = useRef<() => void>(() => {});
  const field = useRef<HTMLTextAreaElement>(null);
  const [fontSize, setFontSize] = useState(readSize);
  const sizeRef = useRef(fontSize);
  sizeRef.current = fontSize;
  const [failed, setFailed] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [prompt, setPrompt] = useState(() => { try { return sessionStorage.getItem(DRAFT + id) ?? ''; } catch { return ''; } });
  const [menu, setMenu] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string>();
  const [sendError, setSendError] = useState<string>();

  useEffect(() => {
    const term = new Xterm({ fontSize: sizeRef.current, fontFamily: '"JetBrains Mono", ui-monospace, monospace', theme: theme(), cursorBlink: true, scrollback: 4000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    xterm.current = term;
    refit.current = () => { try { fit.fit(); } catch { /* laid out with no size yet */ } };
    const l = linkTerminal({ api: phone.api(), subscribe: phone.onTermEvent }, id, {
      get cols() { return term.cols; },
      get rows() { return term.rows; },
      ...holdScroll(term),
    });
    const lineHeight = () => (host.current?.querySelector('.xterm-screen')?.clientHeight ?? 0) / term.rows || 16;
    const stopScroll = dragToScroll(host.current!, (n) => scrollTerm(term, n), lineHeight);
    link.current = l;
    // the wheel steps of one drag move go as one input
    let typed = '';
    term.onData((d) => {
      if (!typed) queueMicrotask(() => { const data = withoutClicks(typed); typed = ''; if (data) l.input(data); });
      typed += d;
    });

    const resize = () => { refit.current(); l.resize(); };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    return () => {
      stopScroll();
      observer.disconnect();
      l.close();
      term.dispose();
      link.current = undefined;
      xterm.current = undefined;
    };
  }, [id]);

  // the type size only reflows the existing terminal; rebuilding it would drop the daemon's stream
  useEffect(() => {
    const term = xterm.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    refit.current();
    link.current?.resize();
  }, [fontSize]);

  // Safari drops the socket on lock and discards backgrounded tabs; every return repaints the pane. A worker out of
  // reach shows the last screen the home saw of the pane, and the terminal opens once it is back
  const away = !!unreachable;
  useEffect(() => {
    if (!online) return;
    let left = false;
    setFailed(undefined);
    setSendError(undefined);
    if (away) {
      phone.api().call('term.lastScreen', { id }).then((r) => {
        if (left || !r.text) return;
        xterm.current?.reset();
        xterm.current?.write(r.text);
      }, () => {});
    } else {
      // opening a dormant robot wakes it, as on the desktop
      const woken = robot && !robot.tmux ? phone.api().call('robot.revive', { id }) : Promise.resolve();
      woken.then(() => { if (!left) return link.current?.open(); }).catch((e: Error) => { if (!left) setFailed(e.message); });
    }
    phone.api().fire('robot.seen', { id });
    return () => { left = true; };
  }, [id, online, attempt, away]);

  // a window lost while the view is open waits for revive, as on the desktop; one that comes back clears it
  const windowId = robot?.tmux?.windowId;
  useEffect(() => {
    if (!windowId) return;
    setFailed(undefined);
    return () => setFailed('The terminal closed.');
  }, [windowId]);

  // an answer stays in flight until the daemon reports the agent unblocked or on another question, so one tap answers once
  const blocked = robot?.agent?.status === 'blocked';
  const promptId = robot?.agent?.promptId;
  const asking = useRef(promptId);
  useEffect(() => { asking.current = promptId; setAnswering(false); setAnswerError(undefined); }, [blocked, promptId]);

  useEffect(() => {
    try { if (prompt) sessionStorage.setItem(DRAFT + id, prompt); else sessionStorage.removeItem(DRAFT + id); } catch { /* site data switched off */ }
  }, [id, prompt]);

  // the field is as tall as its text, up to the cap the stylesheet sets; past that it scrolls
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [prompt]);

  const size = (step: 1 | -1) => {
    const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, SIZES.indexOf(fontSize) + step))];
    try { localStorage.setItem(SIZE_KEY, String(next)); } catch { /* site data switched off */ }
    setFontSize(next);
  };

  const answer = async (a: 'approve' | 'deny') => {
    if (answering) return;
    setAnswering(true);
    setAnswerError(undefined);
    try {
      await phone.api().call('robot.answer', { id, answer: a, promptId });
    } catch (e) {
      // a refusal that comes back after a newer question is up is not that question's
      if (asking.current !== promptId) return;
      setAnswerError((e as Error).message);
      setAnswering(false);
    }
  };

  // a prompt the fleet does not take comes back to the field, unless something new was typed meanwhile
  const send = () => {
    const text = prompt;
    if (!text.trim()) return;
    xterm.current?.scrollToBottom();
    setPrompt('');
    setSendError(undefined);
    phone.api().call('robot.run', { id, text, enter: true })
      .catch((e: Error) => { setPrompt((p) => p || text); setSendError(e.message); });
  };

  return (
    <div className="robot">
      <header className="top">
        <button className="back" onClick={onBack}>‹ fleet</button>
        <span className="title">
          {robot?.name ?? 'gone'}
          {island && <small>{island.name}</small>}
        </span>
        {/* without svalld the robot's status is stale, so the header says so instead */}
        <span className="conn" data-status={!online ? status : robotStatus ?? 'gone'}>
          {!online ? status : robotStatus ? statusLabel(robotStatus) : 'gone'}
        </span>
        <button type="button" className="ahead" aria-haspopup="dialog" onClick={() => setMenu(true)}>context ›</button>
      </header>
      <div className="stage">
        <div className="screen" ref={host} />
        {unreachable && (
          <p className="unreachable" data-testid="phone-unreachable">{unreachable}</p>
        )}
        {failed && (
          <div className="failed">
            <p>{failed}</p>
            <span>
              {robot && !robot.tmux && (
                <button onClick={() => { phone.api().call('robot.revive', { id }).then(() => setAttempt((n) => n + 1), (e: Error) => setFailed(e.message)); }}>revive</button>
              )}
              <button onClick={() => setAttempt((n) => n + 1)}>retry</button>
            </span>
          </div>
        )}
      </div>
      {blocked && robot && (
        <div className="ask" role="status">
          <p>{robot.agent?.prompt ?? `${robot.name} is waiting on you`}</p>
          <span>
            <button type="button" disabled={answering} onClick={() => void answer('approve')}>approve</button>
            <button type="button" disabled={answering} onClick={() => void answer('deny')}>deny</button>
          </span>
          {answerError && <p className="sheet-error">{answerError}</p>}
        </div>
      )}
      <div className="keys">
        {KEYS.map(([label, seq]) => (
          <button key={label} onClick={() => { xterm.current?.scrollToBottom(); link.current?.input(seq); }}>{label}</button>
        ))}
        <button onClick={() => size(-1)}>A−</button>
        <button onClick={() => size(1)}>A+</button>
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        {sendError && <p className="sheet-error">{sendError}</p>}
        <textarea
          ref={field}
          value={prompt}
          rows={2}
          placeholder="prompt…"
          enterKeyHint="enter"
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button type="submit" disabled={!prompt.trim()}>send</button>
      </form>
      {menu && <RobotMenu id={id} onClose={() => setMenu(false)} onClosed={onBack} />}
    </div>
  );
}
