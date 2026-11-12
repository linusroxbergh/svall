import { Caret } from './icons.js';
import { terminalOn } from './MoveSheet.js';
import { useRoute } from './OnMachine.js';

/**
 * A problem, said once: its line, what to do under it, what a tool said behind details, and a terminal on `on` with
 * `run` typed when this Mac reaches it. `settings`: the fix as a note of the Settings window.
 */
export function Said({ line, fix, raw, run, on, settings }: { line: string; fix?: string; raw?: string; run?: string; on?: string; settings?: boolean }) {
  const route = useRoute(run ? on : undefined);
  return (
    <div className="said">
      <div>
        <span>{line}</span>
        {fix && <span className={settings ? 'set-note' : 'modal-sub'}>{fix}</span>}
        {raw && (
          <details className="modal-more">
            <summary><Caret dir="right" />details</summary>
            <div className="modal-more-body mono">{raw}</div>
          </details>
        )}
      </div>
      {run && on && route && <button className="btn sm" onClick={() => terminalOn(on, run)}>Open terminal</button>}
    </div>
  );
}
