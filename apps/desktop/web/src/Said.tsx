import { useEffect, useState, type ReactNode } from 'react';
import { app } from './boot.js';
import { copyText } from './bridge.js';
import { Caret, Mark } from './icons.js';
import { terminalOn } from './MoveSheet.js';
import { useRoute } from './OnMachine.js';

/** `fix` with the command `run` in it set as code, whole; one that ends the fix on a line of its own, as a command it does not quote stands. */
export function Fix({ fix, run }: { fix: string; run?: string }) {
  const at = run ? fix.indexOf(run) : -1;
  if (at < 0) return <>{fix}</>;
  const after = fix.slice(at + run!.length);
  return <>{fix.slice(0, at)}<code className="said-run" data-own-line={!after || undefined}>{run}</code>{after}</>;
}

/**
 * A problem, said once: its line, what to do under it, what a tool said behind details, and for its command `run` a terminal
 * on `on` with it typed when this Mac reaches it, or, with no `on`, Copy, as it runs on this Mac, where the window opens no
 * terminal. A command the fix does not quote stands in mono under it beside Copy, and behind details where neither is offered.
 * `settings`: the fix as a note of the Settings window. `mark`: false inside a row that carries its own; `ok` for what went well.
 * `copy`: how Copy reaches the clipboard, on a page with a bridge of its own.
 */
export function Said({ line, fix, raw, run, on, settings, mark = 'fail', copy = (text) => copyText(app.bridge, text) }: {
  line: ReactNode; fix?: ReactNode; raw?: string; run?: string; on?: string; settings?: boolean; mark?: 'fail' | 'warn' | 'ok' | false; copy?: (text: string) => void;
}) {
  const route = useRoute(run ? on : undefined);
  const terminal = !!run && !!on && route;
  const here = !!run && on === undefined;
  const quoted = typeof fix === 'string' && !!run && fix.includes(run);
  const more = [!terminal && !here && run && !quoted ? run : undefined, raw].filter(Boolean).join('\n\n');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="said" data-mark={mark || undefined}>
      {mark && <span className="said-mark" aria-hidden><Mark status={mark} /></span>}
      <div>
        <span>{line}</span>
        {fix && <span className={settings ? 'set-note' : 'modal-sub'}>{typeof fix === 'string' ? <Fix fix={fix} run={run} /> : fix}</span>}
        {here && !quoted && <code className="said-run">{run}</code>}
        {more && (
          <details className="modal-more">
            <summary><Caret dir="right" />details</summary>
            <div className="modal-more-body mono">{more}</div>
          </details>
        )}
      </div>
      {terminal && <button className="btn sm" onClick={() => terminalOn(on!, run!)}>Open terminal</button>}
      {here && (
        <button className="btn sm" data-testid="said-copy" data-tip={`Copy ${run} to run in a terminal on this Mac`}
          onClick={() => { copy(run!); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
      )}
    </div>
  );
}
