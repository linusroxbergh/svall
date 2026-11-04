import { useEffect, useState } from 'react';
import { type Result, type SetupRow } from '@svall/protocol';
import { app, deps } from './boot.js';
import { openFolder } from './bridge.js';
import { stepLabel } from './host.js';
import { useApp } from './hooks.js';
import { openFile } from './ide/files.js';
import { homeName } from './placement.js';
import { reloadResources } from './resources/load.js';

// what a file holds when the home has none yet and a person opens it
const FILES = [['CLAUDE.md', ''], ['settings.json', '{}\n']] as const;

// the files under `dir` on the home; a folder it cannot list holds none
async function filesUnder(id: string, dir: string): Promise<string[]> {
  const { entries } = await deps().api.call('fs.list', { id, path: dir }).catch(() => ({ entries: [] as Result<'fs.list'>['entries'] }));
  const deeper = await Promise.all(entries.filter((e) => e.kind === 'dir').map((e) => filesUnder(id, `${dir}/${e.name}`)));
  return [...entries.filter((e) => e.kind === 'file').map((e) => `${dir}/${e.name}`), ...deeper.flat()];
}

// the home's files, opened in the shelf's editor and written there over the API
function HomeFiles({ id, skills }: { id: string; skills: number }) {
  const [rules, setRules] = useState<string[]>([]);
  useEffect(() => {
    let left = false;
    void filesUnder(id, 'rules').then((found) => { if (!left) setRules(found); });
    return () => { left = true; };
  }, [id]);
  const shelf = (what?: 'skills') => {
    app.store.getState().toggleSettings(false);
    app.store.getState().toggleResources(true, { where: id, ...(what && { what }) });
  };
  const open = async (path: string, seed?: string) => {
    const d = deps();
    try {
      if (seed !== undefined && await d.api.call('fs.read', { id, path }).then(() => false, (e: { code?: string }) => e.code === 'not_found')) await d.api.call('fs.write', { id, path, text: seed, mtimeMs: 0 });
    } catch (e) {
      d.store.getState().showToast((e as Error).message, 'error');
      return;
    }
    shelf();
    await openFile(d, id, path);
  };
  const row = (key: string, label: string, go: () => void) => (
    <div className="row" key={key}>
      <span>{label}</span>
      <b><button className="btn sm" data-testid={`setup-open-${key}`} onClick={go}>Open</button></b>
    </div>
  );
  return (
    <div className="rows" data-testid="setup-files">
      {FILES.map(([file, seed]) => row(file, file, () => void open(file, seed)))}
      {row('skills', skills === 1 ? '1 skill' : `${skills} skills`, () => shelf('skills'))}
      {rules.map((file) => row(file, file, () => void open(file)))}
    </div>
  );
}

/** A window on a worker: the agent setup lives on the fleet's home, whose files open here, and this machine's own goes there only when copied. */
export function AgentSetup() {
  const home = useApp((s) => (s.via ? homeName(s.fleet, s.via) : ''));
  const me = useApp((s) => s.via?.machine);
  // a window that follows the home over its own route; through this machine's link the files read are this machine's
  const follows = useApp((s) => !!s.via?.online && !!s.home?.master);
  const source = useApp((s) => s.resources.find((r) => r.name === 'Claude' && r.tier === 'global'));
  const [rows, setRows] = useState<SetupRow[]>();
  const [backup, setBackup] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const show = (r: Result<'home.setup'>) => { setRows(r.rows); setBackup(r.backup); };
  useEffect(() => { app.api().call('home.setup', {}).then(show, () => setRows([])); }, []);
  useEffect(() => { if (follows) void reloadResources(deps()); }, [follows]);
  const tick = (r: SetupRow, on: boolean) => {
    app.api().call('home.setupConsent', { item: r.tick!.item, fields: r.tick!.fields, on }).then(show, (e: Error) => setSaid({ ok: false, text: e.message }));
  };
  const copy = () => {
    setBusy(true);
    setSaid(undefined);
    app.api().call('machines.copySetupFrom', { machine: me! }).then(
      (r) => {
        setSaid({ ok: true, text: `Copied to ${home}.${r.backup ? ` What it replaced there is in ${r.backup}.` : ''}` });
        void reloadResources(deps());
      },
      (e: Error) => setSaid({ ok: false, text: e.message }),
    ).finally(() => setBusy(false));
  };
  return (
    <>
      <div className="desc" data-testid="setup-lives">Your agent setup lives on {home}. Every worker takes it from there, this Mac included.</div>
      {follows && source
        ? <HomeFiles id={source.rootId} skills={source.groups.find((g) => g.kind === 'skills')?.items.length ?? 0} />
        : !follows && <div className="desc" data-testid="setup-away">Its files open here while this window reaches {home}.</div>}
      {!!rows?.length && (
        <>
          <div className="desc">Keys stay on this Mac unless you tick them for {home}.</div>
          <div className="rows" data-testid="setup-rows">
            {rows.map((r) => (
              <div className="row" key={r.key}>
                <span>{stepLabel(`mirror:${r.key}`)} <small>{r.tick!.preview.join(', ')}</small></span>
                <b><input type="checkbox" data-testid={`setup-tick-${r.key}`} aria-label={stepLabel(`mirror:${r.key}`)} checked={r.tick!.on} onChange={(e) => tick(r, e.target.checked)} /></b>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="opens">
        <button className="btn sm" data-testid="setup-copy" disabled={!follows || busy} data-tip={`One copy, now, of what is on this Mac; ${home} stays the source after it`} onClick={copy}>
          {busy ? 'Copying…' : `Copy my agent setup from this Mac to ${home}`}
        </button>
      </div>
      {said && <div className="desc" role="status" data-testid={said.ok ? 'setup-copied' : 'setup-copy-failed'}>{said.text}</div>}
      {backup && (
        <div className="desc" data-testid="setup-backup">
          The first push from {home} kept what it replaced on this Mac in <code>{backup}</code>.{' '}
          <button className="btn sm" data-testid="setup-backup-show" onClick={() => openFolder(app.bridge, backup)}>Show in Finder</button>
        </div>
      )}
    </>
  );
}
