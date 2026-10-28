import { app } from './boot.js';
import { useApp } from './hooks.js';
import { keyTip } from './keys.js';
import type { View } from './store/ui.js';

/** Map or Board, in the same place over either view. */
export function ViewSwitch() {
  const view = useApp((s) => s.view);
  const bindings = useApp((s) => s.settings.bindings);
  const tab = (v: View, label: string) => (
    <button type="button" data-testid={`view-${v}`} aria-pressed={view === v} data-tip={view === v ? undefined : keyTip(label, 'toggleView', bindings)}
      onClick={() => { if (view !== v) app.store.getState().setView(v); }}>{label}</button>
  );
  return <div className="kb-seg" role="group" aria-label="View">{tab('map', 'Map')}{tab('board', 'Board')}</div>;
}
