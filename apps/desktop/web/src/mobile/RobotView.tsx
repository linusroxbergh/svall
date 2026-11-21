import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as Xterm } from '@xterm/xterm';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react';
import { shownAgent } from '@svall/protocol';
import { useApp, useFitHeight } from '../hooks.js';
import { Arrow, Backspace, Caret, Enter, Keyboard, More, ShiftTab, Tab } from '../icons.js';
import { MachineLine } from '../indicators.js';
import { awayLine, elsewhere, machineOf } from '../placement.js';
import { statusOf } from '../selectors.js';
import { useAnswer } from './answer.js';
import { phone } from './boot.js';
import { readDraft, writeDraft } from './draft.js';
import { KEY_ROW, keepFocus } from './keys.js';
import { KeysSheet } from './KeysSheet.js';
import { RobotMenu } from './RobotMenu.js';
import { nextWaiting, statusLabel } from './list.js';
import { dragToScroll, holdScroll, onHold, scrollTerm, withoutClicks } from './scroll.js';
import { linkTerminal, type TerminalLink } from './term.js';
import { linkText, type Piece } from './urls.js';

// smaller type means more columns; Claude Code's TUI only lays out narrow when the window itself is
// the keys the row draws as icons, with the names they read as
const FACE: Record<string, [ReactNode, string]> = {
  'tab': [<Tab size="md" />, 'Tab'], '⇧tab': [<ShiftTab size="md" />, 'Shift-Tab'],
  '↑': [<Arrow dir="up" size="md" />, 'Up'], '↓': [<Arrow dir="down" size="md" />, 'Down'],
  '⌫': [<Backspace size="md" />, 'Backspace'], '↩': [<Enter size="md" />, 'Return'],
};

const SIZES = [9, 10, 11, 13];
const SIZE_KEY = 'svall.mobile.fontSize';
const FONT = '"JetBrains Mono", ui-monospace, monospace';

// the terminal's text as it stood at a long press, laid over its cells so the phone's own selection and Copy take it
type Frozen = { text: Piece[]; scroll: number; style: CSSProperties };

const tokenOf = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
// xterm parses its own colours, so the selection's alpha rides as a hex byte on the token: 40 is the editor's 25%
const theme = () => ({
  background: tokenOf('--surface-0'), foreground: tokenOf('--ink'), cursor: tokenOf('--sand'),
  selectionBackground: `${tokenOf('--sel')}40`,
  ...Object.fromEntries(ANSI.flatMap((c) => [
    [c, tokenOf(`--ansi-${c}`)], [`bright${c[0].toUpperCase()}${c.slice(1)}`, tokenOf(`--ansi-bright-${c}`)],
  ])),
});

// a browser with site data switched off throws rather than returning nothing
const readSize = (): number => {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    return SIZES.includes(v) ? v : 11;
  } catch { return 11; }
};

export function RobotView({ id, backTo, onBack, onNext }: { id: string; backTo: string; onBack(): void; onNext(id: string): void }): JSX.Element {
  const robot = useApp((s) => s.fleet.robots[id]);
  const robotStatus = useApp((s) => (s.fleet.robots[id] ? statusOf(s.fleet.robots[id], s.fleet, s.via) : undefined));
  const island = useApp((s) => s.fleet.islands[s.fleet.robots[id]?.islandId ?? '']);
  const on = useApp((s) => { const r = s.fleet.robots[id]; return r && machineOf(s.fleet, r, s.via); });
  const next = useApp((s) => nextWaiting(s.fleet, id, s.via));
  // what stands over the terminal while the machine it runs on is out of reach; the terminal holds the last screen it showed
  const unreachable = useApp((s) => { const r = s.fleet.robots[id]; return r && awayLine(s.fleet, r, s.via); });
  const via = useApp((s) => s.via);
  // through a worker, a robot running elsewhere keeps its draft and takes no prompt
  const here = !robot || !elsewhere(robot, via);
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
  // a worker out of reach takes no keys and no size
  const awayRef = useRef(!!unreachable);
  awayRef.current = !!unreachable;
  const [failed, setFailed] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [prompt, setPrompt] = useState(() => readDraft(id));
  const [menu, setMenu] = useState(false);
  const [keys, setKeys] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [frozen, setFrozen] = useState<Frozen>();
  const frozenText = useRef<HTMLPreElement>(null);
  // the finger whose long press laid the text over lifts onto it, and must not open a link there
  const touchedFrozen = useRef(false);
  // keys typed straight into the terminal rather than the composer
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    const term = new Xterm({ fontSize: sizeRef.current, fontFamily: FONT, theme: theme(), cursorBlink: true, scrollback: 4000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    term.open(host.current!);
    xterm.current = term;
    // a tap on the terminal raises no keyboard: text goes through the composer, or here once raw typing is on
    const input = term.textarea;
    input?.setAttribute('inputmode', 'none');
    const endRaw = () => { input?.setAttribute('inputmode', 'none'); setRaw(false); };
    input?.addEventListener('blur', endRaw);
    refit.current = () => { try { fit.fit(); } catch { /* laid out with no size yet */ } };
    const l = linkTerminal({ api: phone.api, subscribe: phone.onTermEvent }, id, {
      get cols() { return term.cols; },
      get rows() { return term.rows; },
      ...holdScroll(term),
    });
    const lineHeight = () => (host.current?.querySelector('.xterm-screen')?.clientHeight ?? 0) / term.rows || 16;
    const stopScroll = dragToScroll(host.current!, (n) => scrollTerm(term, n), lineHeight);
    const stopHold = onHold(host.current!, () => {
      const cells = host.current?.querySelector('.xterm-screen');
      const rows = host.current?.querySelector('.xterm-rows');
      const stage = host.current?.parentElement;
      if (!cells || !rows || !stage) return;
      const b = term.buffer.active;
      const at = cells.getBoundingClientRect();
      const origin = stage.getBoundingClientRect();
      const top = at.top - origin.top;
      const line = at.height / term.rows;
      touchedFrozen.current = false;
      setFrozen({
        // a row that wraps on keeps its trailing blanks, so a URL is not joined across them
        text: linkText(Array.from({ length: b.length }, (_, i) => ({
          text: b.getLine(i)?.translateToString(!b.getLine(i + 1)?.isWrapped) ?? '', wrapped: !!b.getLine(i)?.isWrapped,
        }))),
        scroll: b.viewportY * line,
        style: {
          top, left: at.left - origin.left, width: at.width, height: at.height, maxHeight: `calc(100% - ${top}px)`,
          font: `${term.options.fontSize}px/${line}px ${FONT}`, letterSpacing: getComputedStyle(rows).letterSpacing,
        },
      });
    });
    link.current = l;
    // the wheel steps of one drag move go as one input
    let typed = '';
    term.onData((d) => {
      if (!typed) queueMicrotask(() => { const data = withoutClicks(typed); typed = ''; if (data && !awayRef.current) l.input(data); });
      typed += d;
    });

    const resize = () => { refit.current(); if (!awayRef.current) l.resize(); };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    return () => {
      input?.removeEventListener('blur', endRaw);
      setRaw(false);
      stopScroll();
      stopHold();
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
    if (!awayRef.current) link.current?.resize();
  }, [fontSize]);

  // Safari drops the socket on lock and discards backgrounded tabs; every return repaints the pane. A worker out of
  // reach shows the last screen the home saw of the pane, and the terminal opens once it is back
  const away = !!unreachable;
  // a worker out of reach takes no keys, so typing into its terminal ends
  useEffect(() => { if (away) xterm.current?.textarea?.blur(); }, [away]);
  // the machine the terminal was last opened on
  const openedOn = useRef(robot?.machine);
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
      openedOn.current = robot?.machine;
      woken.then(() => { if (!left) return link.current?.open(); }).catch((e: Error) => { if (!left) setFailed(e.message); });
    }
    if (here) phone.api().fire('robot.seen', { id });
    return () => { left = true; };
  }, [id, online, attempt, away, via?.machine]);

  // a window lost while the view is open waits for revive, as on the desktop; one that comes back clears it, and one on
  // another machine, as a move lands, is opened there
  const windowId = robot?.tmux?.windowId;
  useEffect(() => {
    if (!windowId) return;
    setFailed(undefined);
    if (online && !away && robot?.machine !== openedOn.current) {
      openedOn.current = robot?.machine;
      link.current?.open().catch((e: Error) => setFailed(e.message));
    }
    return () => setFailed('The terminal closed.');
  }, [windowId]);

  const shown = robot && shownAgent(robot);
  const blocked = shown?.status === 'blocked';
  const promptId = shown?.promptId;
  // a question dialog's Enter picks the highlighted option, one question at a time
  const question = shown?.askedTool === 'AskUserQuestion';
  const { answering, error: answerError, answer } = useAnswer(id, promptId, blocked);

  useEffect(() => writeDraft(id, prompt), [id, prompt]);

  useLayoutEffect(() => { if (frozen && frozenText.current) frozenText.current.scrollTop = frozen.scroll; }, [frozen]);

  // the field leaves while raw typing is on, and fits its draft again when it is back
  useFitHeight(field, raw ? '' : prompt);

  const size = (step: 1 | -1) => {
    const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, SIZES.indexOf(fontSize) + step))];
    try { localStorage.setItem(SIZE_KEY, String(next)); } catch { /* site data switched off */ }
    setFontSize(next);
  };

  const key = (seq: string) => { setFrozen(undefined); xterm.current?.scrollToBottom(); link.current?.input(seq); };

  // iOS raises the keyboard only for a focus made inside the tap, and a tap on the terminal may have focused the
  // textarea already, so it is blurred first
  const typeRaw = () => {
    const input = xterm.current?.textarea;
    if (!input) return;
    setFrozen(undefined);
    input.blur();
    input.setAttribute('inputmode', 'text');
    setRaw(true);
    input.focus();
  };

  // a prompt the fleet does not take comes back to the field, unless something new was typed meanwhile
  const send = () => {
    const text = prompt;
    if (!text.trim() || !here) return;
    setFrozen(undefined);
    xterm.current?.scrollToBottom();
    setPrompt('');
    setSendError(undefined);
    phone.api().call('robot.run', { id, text, enter: true })
      .catch((e: Error) => { setPrompt((p) => p || text); setSendError(e.message); });
  };

  return (
    <div className="robot">
      <header className="top">
        <button className="back" onClick={onBack}><Caret dir="left" /> {backTo}</button>
        <span className="title">
          <span>{robot?.name ?? 'gone'}</span>
          {(island || on) && <small>{island && <span>{island.name}</span>}{on && <MachineLine name={on} short className="title-on" testid="phone-machine" />}</small>}
        </span>
        {/* without svalld the robot's status is stale, so the header says so instead */}
        <span className="conn" data-status={!online ? status : robotStatus ?? 'gone'}>
          {!online ? status : robotStatus ? statusLabel(robotStatus) : 'gone'}
        </span>
        {next && <button type="button" className="next" aria-label={`Next waiting: ${next.name}`} onClick={() => onNext(next.id)}><i className="pip" />next</button>}
        <button type="button" className="ahead" aria-haspopup="dialog" onClick={() => setMenu(true)}>context <Caret dir="right" /></button>
      </header>
      <div className="stage">
        <div className="screen" ref={host} />
        {frozen && (
          <>
            <pre className="frozen" ref={frozenText} style={frozen.style} data-testid="phone-select"
              onTouchStart={() => { touchedFrozen.current = true; }} onClick={(e) => { if (!touchedFrozen.current) e.preventDefault(); }}>
              {frozen.text.map((p, i) => (typeof p === 'string' ? p : <a key={i} href={p.href} target="_blank" rel="noreferrer">{p.text}</a>))}
            </pre>
            <button type="button" className="frozen-done" onClick={() => setFrozen(undefined)}>done</button>
          </>
        )}
        {unreachable && (
          <p className="unreachable" role="status" data-testid="phone-unreachable">{unreachable}</p>
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
      <div className="dock">
        {blocked && robot && !elsewhere(robot, via) && (
          <div className="ask" role="status">
            <p>{shown?.prompt ?? `${robot.name} is waiting on you`}</p>
            <span>
              <button type="button" disabled={answering} onClick={() => void answer('approve')}>{question ? 'select' : 'approve'}</button>
              <button type="button" disabled={answering} onClick={() => void answer('deny')}>{question ? 'cancel' : 'deny'}</button>
            </span>
            {shown?.askedFor && shown.askedFor !== shown.prompt && <code>{shown.askedFor}</code>}
            {answerError && <p className="sheet-error">{answerError}</p>}
          </div>
        )}
        <div className="keys">
          {KEY_ROW.map((k) => (
            <button key={k.label} type="button" aria-label={FACE[k.label]?.[1]} disabled={away}
              onMouseDown={keepFocus} onClick={() => key(k.seq)}>{FACE[k.label]?.[0] ?? k.label}</button>
          ))}
          <button type="button" className="more" aria-label="More keys" aria-haspopup="dialog" disabled={away} onMouseDown={keepFocus} onClick={() => setKeys(true)}><More size="lg" /></button>
        </div>
        {sendError && <p className="sheet-error">{sendError}</p>}
        <form className="pill" data-raw={raw || undefined} onSubmit={(e) => { e.preventDefault(); send(); }}>
          {raw ? (
            <>
              <p>typing into the terminal</p>
              <button type="button" className="done" aria-label="Done typing into the terminal" onMouseDown={keepFocus} onClick={() => xterm.current?.textarea?.blur()}>done</button>
            </>
          ) : (
            <>
              <textarea
                ref={field}
                value={prompt}
                rows={1}
                placeholder="prompt…"
                aria-label="Prompt"
                enterKeyHint="enter"
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setPrompt(e.target.value)}
              />
              {prompt.trim()
                ? <button type="submit" className="send" aria-label="send" disabled={!here}><Arrow dir="up" size="md" /></button>
                : <button type="button" aria-label="Type into the terminal" disabled={away} onClick={typeRaw}><Keyboard size="md" /></button>}
            </>
          )}
        </form>
      </div>
      {menu && <RobotMenu id={id} onClose={() => setMenu(false)} onClosed={onBack} />}
      {keys && <KeysSheet kind={robot?.agent?.kind} fontSize={fontSize} onKey={key} onSize={size} onClose={() => setKeys(false)} />}
    </div>
  );
}
