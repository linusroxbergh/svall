import { useEffect, useState } from 'react';
import { type Result, type SetupRow } from '@svall/protocol';
import { app, deps } from './boot.js';
import { openFolder } from './bridge.js';
import { stepLabel } from './host.js';
import { useApp } from './hooks.js';
import { openFile } from './ide/files.js';
import { homeName } from './placement.js';
import { reloadResources } from './resources/load.js';

// what an unsaved buffer holds when the home has no such file yet and a person opens it
const FILES = [['CLAUDE.md', ''], ['settings.json', '{}\n']] as const;

// the files under `dir` on the home; a folder not there holds none
async function filesUnder(id: string, dir: string): Promise<string[]> {
  const { entries } = await deps().api.call('fs.list', { id, path: dir }).catch((e: { code?: string }) => {
    if (e.code !== 'not_found') throw e;
    return { entries: [] as Result<'fs.list'>['entries'] };
  });
  const deeper = await Promise.all(entries.filter((e) => e.kind === 'dir').map((e) => filesUnder(id, `${dir}/${e.name}`)));
  return [...entries.filter((e) => e.kind === 'file').map((e) => `${dir}/${e.name}`), ...deeper.flat()];
}

// the home's files, opened in the shelf's editor and written there over the API
function HomeFiles({ id, skills }: { id: string; skills: number }) {
  const [rules, setRules] = useState<string[]>([]);
  useEffect(() => {
    let left = false;
    void filesUnder(id, 'rules').then((found) => { if (!left) setRules(found); }, (e: Error) => deps().store.getState().showToast(`rules: ${e.message}`, 'error'));
    return () => { left = true; };
  }, [id]);
  const shelf = (what?: 'skills') => {
    app.store.getState().toggleSettings(false);
    app.store.getState().toggleResources(true, { where: id, ...(what && { what }) });
  };
  const open = async (path: string, seed?: string) => {
    shelf();
    await openFile(deps(), id, path, seed);
  };
  const row = (key: string, label: string, go: () => void) => (
    <div className="row" key={key}>
      <span>{label}</span>
      <b><button className="btn sm" data-testid={`setup-open-${key}`} aria-label={`Open ${label}`} onClick={go}>Open</button></b>
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

/** What of this machine's agent setup holds a key, each with its box, as Add machine asks it: nothing goes unticked. */
export function SetupTicks({ rows, tick }: { rows: SetupRow[]; tick: (r: SetupRow, fields: string[], on: boolean) => void }) {
  const box = (r: SetupRow, id: string, label: string, fields: string[], on: boolean) => (
    <b><input type="checkbox" data-testid={`setup-tick-${id}`} aria-label={label} checked={on} onChange={(e) => tick(r, fields, e.target.checked)} /></b>
  );
  const row = (r: SetupRow) => {
    const t = r.tick!;
    const label = stepLabel(`mirror:${r.key}`);
    // a key row with several fields has a box each; what travels whole has one
    if (!t.ticked || t.fields.length < 2) {
      return (
        <div className="row" key={r.key}>
          <span>{label} <small>{t.preview.join(', ')}</small></span>
          {box(r, r.key, label, t.fields, t.on)}
        </div>
      );
    }
    return [
      <div className="row" key={r.key}>
        <span>{label}{t.ticked.length > 0 && !t.on && <small data-testid={`setup-partial-${r.key}`}> partly ticked: {t.ticked.length} of {t.fields.length} keys go</small>}</span>
      </div>,
      ...t.fields.map((f) => (
        <div className="row" key={`${r.key}#${f}`}>
          <span><small>{t.preview.filter((p) => p.startsWith(`${f} `)).join(', ') || f}</small></span>
          {box(r, `${r.key}#${f}`, `${label} ${f}`, [f], t.ticked!.includes(f))}
        </div>
      )),
    ];
  };
  return <div className="rows" data-testid="setup-rows">{rows.map(row)}</div>;
}

/** A window on a worker: the agent setup lives on the fleet's home, whose files open here, and this machine's own goes there only when copied. */
export function AgentSetup() {
  const home = useApp((s) => (s.via ? homeName(s.fleet, s.via) : ''));
  const me = useApp((s) => s.via?.machine);
  // a window that follows the home over its own route; through this machine's link the files read are this machine's
  const follows = useApp((s) => !!s.via?.online && !!s.home?.master);
  const dialed = useApp((s) => !!s.via?.online && !!s.home && !s.home.master);
  const source = useApp((s) => s.resources.find((r) => r.name === 'Claude' && r.tier === 'global'));
  const [rows, setRows] = useState<SetupRow[]>();
  const [backup, setBackup] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  // a consent call out, and what the last call about the ticks failed with: a copy waits until the ticks it sends are known
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState<string>();
  const [replaced, setReplaced] = useState<string[]>([]);
  const [pushFailed, setPushFailed] = useState<string>();
  const show = (r: Result<'home.setup'>) => { setRows(r.rows); setBackup(r.backup); setReplaced(r.replaced ?? []); setPushFailed(r.pushFailed); setFailed(undefined); };
  const fail = (e: Error) => setFailed(e.message);
  const load = () => { app.api().call('home.setup', {}).then(show, fail); };
  useEffect(load, []);
  useEffect(() => { if (follows) void reloadResources(deps()); }, [follows]);
  const tick = (r: SetupRow, fields: string[], on: boolean) => {
    setPending((n) => n + 1);
    app.api().call('home.setupConsent', { item: r.tick!.item, fields, on }).then(show, fail).finally(() => setPending((n) => n - 1));
  };
  const copy = () => {
    setBusy(true);
    setSaid(undefined);
    app.api().call('machines.copySetupFrom', { machine: me! }).then(
      (r) => {
        setSaid({
          ok: true,
          text: [
            `Copied to ${home}.`, r.backup && `What it replaced there is in ${r.backup}.`,
            r.replaced && `A tick went over what ${home} held itself for ${r.replaced.join(', ')}: that is in its backup folder.`,
            ...(r.left ?? []).map((name) => `${name} stays as you edited it, with any key the mirror copied in it; remove it yourself.`),
          ].filter(Boolean).join(' '),
        });
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
        : !follows && (
          <div className="desc" data-testid="setup-away">
            {dialed ? `${home} reaches this Mac over its own link, so this window has no way to ${home}: its files and the copy open only where a window reaches it.` : `Its files open here while this window reaches ${home}.`}
          </div>
        )}
      {!!rows?.length && (
        <>
          <div className="desc" data-testid="setup-keys">Keys in config files stay on this Mac unless you tick them for {home}. CLAUDE.md, AGENTS.md, keybindings.json, rules, skills, commands, agents, plugins and agent profiles go as they are, anything written in them included. A key you untick stays on {home} until the next Copy.</div>
          <SetupTicks rows={rows} tick={tick} />
        </>
      )}
      {pushFailed && <div className="desc" role="alert" data-testid="setup-push-failed" data-error>{home}&apos;s last push here did not land: {pushFailed}</div>}
      {failed && (
        <div className="desc" role="alert" data-testid="setup-failed">
          <span data-error>{failed}</span> <button className="btn sm" data-testid="setup-retry" onClick={load}>Check again</button>
        </div>
      )}
      <div className="desc" data-testid="setup-copy-says">
        {backup && <>A push from {home} replaced same-named files on this Mac; they are in the folder below. Put back what you want from there first, as a Copy sends what is on this Mac now. </>}
        A Copy sends only what changed on this Mac since the last one, so a file edited on {home} since stays unless it changed here too. The first Copy has no last one: it replaces same-named files on {home}, edits there included, and keeps what it replaced in {home}&apos;s own backup folder. A Copy removes nothing on {home} but what you unticked, while it is still the copy, and Svall&apos;s rollback copies that hold a key you unticked or changed. A whole item you edited there since stays, with any key in it. A second Mac&apos;s Copy works against the same history: it skips what the first sent and replaces edits made since.
      </div>
      <div className="opens">
        <button className="btn sm" data-testid="setup-copy" disabled={!follows || busy || rows === undefined || pending > 0 || failed !== undefined} data-tip={`One copy, now, of what is on this Mac; ${home} stays the source after it`} onClick={copy}>
          {busy ? 'Copying…' : `Copy my agent setup from this Mac to ${home}`}
        </button>
      </div>
      {said && <div className="desc" role="status" data-testid={said.ok ? 'setup-copied' : 'setup-copy-failed'} data-error={!said.ok}>{said.text}</div>}
      {backup && (
        <div className="desc" data-testid="setup-backup">
          A push from {home} kept what it replaced on this Mac in <code>{backup}</code>.{' '}
          {replaced.length > 0 && <span data-testid="setup-replaced">A tick went over what this Mac held itself for {replaced.join(', ')}: that is in this folder. </span>}
          <button className="btn sm" data-testid="setup-backup-show" onClick={() => openFolder(app.bridge, backup, me)}>Show in Finder</button>
        </div>
      )}
    </>
  );
}
