import { useState } from 'react';
import type { ResourceSource } from '@svall/protocol';
import { app } from '../boot.js';
import { revealFile } from '../bridge.js';
import { useApp } from '../hooks.js';
import { chainOf, entityOf, isDoc, shelfSource, tierOf, type Chip } from './model.js';

const NONE: string[] = [];

// a chip that stands for several repositories opens into one chip each
function ChainChip({ chip, sources, on }: { chip: Chip; sources: ResourceSource[]; on: boolean }) {
  const [open, setOpen] = useState(false);
  const t = tierOf(chip.tier);
  const go = (rootId: string) => app.store.getState().setResourcesFilter({ where: rootId });
  const many = chip.rootIds.length > 1;
  return (
    <>
      <button className="res-chip" data-testid={`resources-chip-${chip.tier}`} aria-pressed={on} aria-expanded={many ? open : undefined}
        onClick={() => (many ? setOpen(!open) : go(chip.rootIds[0]))}>
        <i style={{ color: `var(${t.colour})` }}>{t.glyph}</i>{chip.label}
      </button>
      {many && open && chip.rootIds.map((id) => (
        <button key={id} className="res-chip" data-testid={`resources-chip-repo-${id}`} onClick={() => go(id)}>
          <i style={{ color: `var(${t.colour})` }}>{t.glyph}</i>{sources.find((s) => s.rootId === id)?.name}
        </button>
      ))}
    </>
  );
}

/** The line under all three panes: the shown file's path, what an island's or a character's agent reads, and the actions on the file. */
export function Foot({ onRefresh }: { onRefresh(): void }) {
  const sources = useApp((s) => s.resources);
  const fleet = useApp((s) => s.fleet);
  const resourcesWhere = useApp((s) => s.resourcesWhere);
  const shown = useApp((s) => s.resourcesShown);
  const field = useApp((s) => (s.resourcesField && entityOf(s, s.resourcesField) ? s.resourcesField : undefined));
  const dirty = useApp((s) => (shown ? s.ide[shown.rootId]?.dirty ?? NONE : NONE));
  const conflict = useApp((s) => (shown ? s.ide[shown.rootId]?.conflict ?? NONE : NONE));
  const failed = useApp((s) => (shown ? s.ide[shown.rootId]?.failed ?? NONE : NONE));
  const root = sources.find((s) => s.rootId === shown?.rootId)?.root ?? shown?.rootId.slice(2);
  const selected = shelfSource({ resources: sources, resourcesWhere, fleet });
  const chain = selected && chainOf(sources, fleet, selected);
  const file = shown && !field ? `${root}/${shown.path}` : undefined;
  const doc = shown !== undefined && !field && isDoc(sources, shown.rootId, shown.path);
  const unsaved = shown !== undefined && dirty.includes(shown.path);
  // a conflict waits for Reload or Overwrite, and a failed write for the next edit or ⌘S, so neither doc is being saved
  const stuck = shown !== undefined && (conflict.includes(shown.path) || failed.includes(shown.path));
  return (
    <footer className="res-foot">
      {/* the path is clipped at its head, which asks for an RTL box; bdi keeps the text itself left to right */}
      <span className="res-path" data-testid="resources-editor-path">{field ? 'saved when you leave the field' : <bdi>{file ?? ''}</bdi>}</span>
      {chain && (
        <span className="res-chain" data-testid="resources-chain">
          <span className="res-chain-h">{chain.heading}</span>
          {chain.chips.map((c) => <ChainChip key={c.tier} chip={c} sources={sources} on={c.rootIds.includes(selected.rootId)} />)}
        </span>
      )}
      {file && doc && <span className="res-save-word" data-testid="resources-save-state">{!unsaved ? 'saved' : stuck ? 'not saved' : 'saving…'}</span>}
      {file && !doc && unsaved && <span className="res-unsaved-word">unsaved · ⌘S saves</span>}
      {file && <button className="res-link" onClick={() => revealFile(app.bridge, file)}>Show in Finder ›</button>}
      <button className="res-link" data-testid="resources-refresh" title="Reload from disk" onClick={onRefresh}>↻ Refresh</button>
    </footer>
  );
}
