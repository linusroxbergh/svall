import { app } from './boot.js';
import { useApp } from './hooks.js';
import { sourceOfRoot } from './resources/model.js';

export function ResourcesButton({ root, testid }: { root: string | undefined; testid: string }) {
  const sources = useApp((s) => s.resources);
  const source = sourceOfRoot(sources, root);
  return (
    <button className="btn res-open" data-testid={testid} title="Open the resources shelf"
      onClick={() => app.store.getState().toggleResources(true, { where: (source ?? sources[0])?.rootId, what: 'all' })}>Resources</button>
  );
}
