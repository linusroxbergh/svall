import { beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../src/api.js';
import type { Bridge, ToShell } from '../src/bridge.js';
import { dropBuffers } from '../src/ide/buffers.js';
import { applyShow } from '../src/show.js';
import { createAppStore } from '../src/store/index.js';
import { fleet } from './fixtures.js';

// a robot whose cwd holds a README, in a window the shell is there to resize
function setup() {
  const store = createAppStore();
  store.getState().setFleet(fleet());
  const sent: ToShell[] = [];
  const api = { call: (method: string) => method === 'fs.read' ? Promise.resolve({ text: '# hi\n', mtimeMs: 1, root: '/tmp' }) : Promise.resolve({}) } as unknown as Api;
  const bridge = { present: true, send: (m: ToShell) => sent.push(m) } as unknown as Bridge;
  return { d: { api, store, bridge }, s: () => store.getState(), sent };
}

describe('applyShow', () => {
  beforeEach(() => dropBuffers('c1'));

  it("opens the robot's card with the panes, the file and the window asked for", async () => {
    const { d, s, sent } = setup();
    await applyShow(d, { id: 'c1', left: 'terminal', right: 'files', ratio: 0.4, file: 'README.md', preview: true, tree: false, size: { w: 1280, h: 820 } });
    expect(s()).toMatchObject({ card: 'c1', selectedId: 'c1', filesTree: { open: false }, previewAsk: { id: 'c1', path: 'README.md' } });
    expect(s().ide.c1).toMatchObject({ panes: { left: 'terminal', right: 'files' }, ratio: 0.4, open: ['README.md'], active: 'README.md' });
    expect(sent).toEqual([{ type: 'window.size', width: 1280, height: 820 }]);
  });

  it('leaves what it was not asked about, and a closed card leaves the robot selected', async () => {
    const { d, s } = setup();
    await applyShow(d, { id: 'c1', right: 'browser' });
    await applyShow(d, { id: 'c1', card: 'closed', panel: 'phone', sideCard: true });
    expect(s()).toMatchObject({ card: undefined, selectedId: 'c1', sideCardOpen: true, mobileOpen: true, cardSize: 'half' });
    expect(s().ide.c1.panes).toEqual({ left: 'terminal', right: 'browser' });
    await applyShow(d, { id: 'c1', right: 'none', card: 'full', panel: 'none' });
    expect(s()).toMatchObject({ card: 'c1', cardSize: 'full', mobileOpen: false });
    expect(s().ide.c1.panes).toEqual({ left: 'terminal' });
  });
});
