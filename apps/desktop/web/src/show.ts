import type { AppShow } from '@svall/protocol';
import type { Deps } from './actions.js';
import { openPath } from './ide/files.js';
import { closeSide, pick, snapRatio } from './panes.js';
import { panesOf } from './selectors.js';

/** Shows what `svall app show` asked for; a field it left out stays as the window has it. */
export async function applyShow(d: Deps, p: AppShow): Promise<void> {
  const s = () => d.store.getState();
  const id = p.id !== undefined && s().fleet.robots[p.id] ? p.id : undefined;
  if (p.view) s().setView(p.view);
  if (p.card === 'closed') s().closeCard();
  if (id) { if (p.card === 'closed') s().select(id); else s().focus(id); }
  if ((p.card === 'half' || p.card === 'full') && s().cardSize !== p.card) s().toggleCardSize();
  if (id) {
    let panes = panesOf(s(), id);
    if (p.left) panes = pick(panes, 'left', p.left);
    if (p.right === 'none') panes = closeSide(panes, 'right');
    else if (p.right) panes = pick(panes, 'right', p.right);
    s().setPanes(id, panes);
    if (p.ratio !== undefined) s().setRatio(id, snapRatio(p.ratio));
  }
  if (p.tree !== undefined) s().toggleFilesTree(p.tree);
  if (p.sidebar !== undefined) s().toggleSidebar(p.sidebar);
  // after the selection, which opens the side card unless the user collapsed it
  if (p.sideCard !== undefined) s().toggleSideCard(p.sideCard);
  if (p.redact) s().setPhoneRedact(p.redact.qr);
  if (p.panel === 'none') s().toggleMobile(false);
  else if (p.panel) ({ phone: s().toggleMobile, usage: s().toggleUsage, load: s().toggleLoad })[p.panel](true);
  if (p.size && d.bridge.present) d.bridge.send({ type: 'window.size', width: p.size.w, height: p.size.h });
  if (id && p.file) {
    const path = await openPath(d, id, p.file, 'terminal');
    if (path && p.preview) s().askPreview({ id, path });
  }
}
