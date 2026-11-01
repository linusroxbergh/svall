import { useEffect, useRef } from 'react';
import { app } from './boot.js';
import { Glide } from './Glide.js';
import { useApp } from './hooks.js';
import { keyTip } from './keys.js';
import type { View } from './store/ui.js';

// each view mounts a switch of its own, so the new one's pill starts behind the view being left
let shown: View | undefined;

/** Map or Board, in the same place over either view. */
export function ViewSwitch() {
  const view = useApp((s) => s.view);
  const from = useRef(shown !== view ? shown : undefined).current;
  useEffect(() => { shown = view; }, [view]);
  const bindings = useApp((s) => s.settings.bindings);
  const tab = (v: View, label: string) => (
    <button type="button" data-testid={`view-${v}`} aria-pressed={view === v} data-tip={view === v ? undefined : keyTip(label, 'toggleView', bindings)}
      onClick={() => { if (view !== v) app.store.getState().setView(v); }}>{label}</button>
  );
  return (
    <div className="seg even" role="group" aria-label="View">
      <Glide at={view} from={from && `[data-testid="view-${from}"]`} />{tab('map', 'Map')}{tab('board', 'Board')}
    </div>
  );
}
