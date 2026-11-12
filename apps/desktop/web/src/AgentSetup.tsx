import { useEffect, useState } from 'react';
import { type Result, type SetupRow } from '@svall/protocol';
import { app, deps } from './boot.js';
import { openFolder } from './bridge.js';
import { keyLabel, keyMask, plural, splitRaw, withoutTokens } from './host.js';
import { useApp } from './hooks.js';
import { Caret } from './icons.js';
import { openFile } from './ide/files.js';
import { Group, Info } from './Info.js';
import { homeName } from './placement.js';
import { reloadResources } from './resources/load.js';
import { Said } from './Said.js';

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

// the home's files, opened in the shelf's editor and written there over the API; past six rules, the rules fold
function HomeFiles({ id, skills }: { id: string; skills: number }) {
  const [rules, setRules] = useState<string[]>([]);
  const [unread, setUnread] = useState<string>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let left = false;
    void filesUnder(id, 'rules').then((found) => { if (!left) setRules(found); }, (e: Error) => { if (!left) setUnread(e.message); });
    return () => { left = true; };
  }, [id]);
  const shelf = (what?: 'skills') => {
    app.store.getState().toggleSettings(false);
    app.store.getState().toggleResources(true, { where: id, ...(what && { what }) });
  };
  const go = async (path: string, seed?: string) => {
    shelf();
    await openFile(deps(), id, path, seed);
  };
  const row = (key: string, label: string, act: () => void) => (
    <div className="row" key={key}>
      <span>{label}</span>
      <b><button className="btn sm" data-testid={`setup-open-${key}`} aria-label={`Open ${label}`} onClick={act}>Open</button></b>
    </div>
  );
  const folds = rules.length > 6;
  return (
    <div data-testid="setup-files">
      {FILES.map(([file, seed]) => row(file, file, () => void go(file, seed)))}
      {row('skills', `skills · ${skills}`, () => shelf('skills'))}
      {folds && (
        <button type="button" className="sec-fold set-fold" data-testid="setup-rules-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Caret dir={open ? 'down' : 'right'} />{plural(rules.length, 'rule')}
        </button>
      )}
      {(!folds || open) && rules.map((file) => row(file, file, () => void go(file)))}
      {unread && <div className="set-said" data-testid="setup-rules-failed"><Said line="The rules could not be read" raw={withoutTokens(unread)} settings mark="warn" /></div>}
    </div>
  );
}

/** What of this machine's agent setup holds a key, each with its switch for the home: nothing goes switched off. */
export function SetupTicks({ rows, tick }: { rows: SetupRow[]; tick: (r: SetupRow, fields: string[], on: boolean) => void }) {
  const home = useApp((s) => (s.via ? homeName(s.fleet, s.via) : 'the home'));
  const label = (r: SetupRow, field?: string) => {
    const mask = keyMask(r, field);
    return <span>{keyLabel(r, field)}{mask && <> <small className="mono">{mask}</small></>}</span>;
  };
  const sw = (r: SetupRow, id: string, fields: string[], on: boolean, field?: string) => (
    <b><button className="set-switch" role="switch" aria-checked={on} aria-label={`Send ${keyLabel(r, field)} to ${home}`} data-testid={`setup-tick-${id}`}
      onClick={() => tick(r, fields, !on)}>{on ? 'on' : 'off'}</button></b>
  );
  const row = (r: SetupRow) => {
    const t = r.tick!;
    // a key row with several fields has a switch each; what travels whole has one
    if (!t.ticked || t.fields.length < 2) {
      return <div className="row" key={r.key}>{label(r)}{sw(r, r.key, t.fields, t.on)}</div>;
    }
    return [
      <div className="row" key={r.key}>
        {label(r)}
        {t.ticked.length > 0 && !t.on && <b data-testid={`setup-partial-${r.key}`}>{t.ticked.length} of {t.fields.length} on</b>}
      </div>,
      ...t.fields.map((f) => (
        <div className="row set-sub" key={`${r.key}#${f}`}>
          {label(r, f)}
          {sw(r, `${r.key}#${f}`, [f], t.ticked!.includes(f), f)}
        </div>
      )),
    ];
  };
  return <div data-testid="setup-rows">{rows.map(row)}</div>;
}

// a backup folder is named for the day it was made, and numbered after the first that day; one named otherwise by its last two parts
const backupLabel = (dir: string): string => {
  const m = /\/(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?\/?$/.exec(dir);
  if (!m) return dir.split('/').filter(Boolean).slice(-2).join('/');
  return `backup from ${new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}${m[4] ? ` (${m[4]})` : ''}`;
};

const copied = (home: string, r: Result<'machines.copySetupFrom'>): string => [
  `Copied to ${home}.`, r.backup && `Replaced files are in ${r.backup} on ${home}.`,
  r.replaced && `${home}'s own ${r.replaced.join(', ')} went to its backup folder.`,
  ...(r.left ?? []).map((name) => `${name} stays as edited on ${home}.`),
].filter(Boolean).join(' ');

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
      (r) => { setSaid({ ok: true, text: copied(home, r) }); void reloadResources(deps()); },
      (e: Error) => setSaid({ ok: false, text: e.message }),
    ).finally(() => setBusy(false));
  };
  return (
    <>
      <Group name={`On ${home}`} testid="setup-lives"
        info={<Info id="setup-lives">Your agent setup lives on the fleet&apos;s home. Every worker takes it from there, this Mac included.</Info>}>
        {!follows ? (
          <div className="set-note" data-testid="setup-away">
            {dialed ? `This window has no route to ${home}. Open Svall where it reaches ${home} to edit the setup.` : `${home} is not reachable; its files open once it is.`}
          </div>
        ) : source
          ? <HomeFiles id={source.rootId} skills={source.groups.find((g) => g.kind === 'skills')?.items.length ?? 0} />
          : <div className="set-note"><span className="move-spin" />Reading {home}&apos;s files…</div>}
      </Group>
      <Group name="Copy from this Mac"
        info={<Info id="setup-copy">Sends what changed on this Mac since the last copy; nothing is removed on {home} except keys you switch off. The first copy replaces same-named files there and keeps the old ones in {home}&apos;s backup folder.</Info>}>
        <div className="row">
          <span>this Mac → {home}</span>
          <b><button className="btn sm" data-testid="setup-copy" disabled={!follows || busy || rows === undefined || pending > 0 || failed !== undefined}
            data-tip={`One copy, now, of what is on this Mac; ${home} stays the source after it`} onClick={copy}>{busy ? 'Copying…' : 'Copy now'}</button></b>
        </div>
        {said?.ok && <div className="set-note" role="status" data-testid="setup-copied">{said.text}</div>}
        {said && !said.ok && <div className="set-said" role="status" data-testid="setup-copy-failed" data-error><Said {...splitRaw(said.text)} settings /></div>}
        {pushFailed && (
          <div className="set-said" role="alert" data-testid="setup-push-failed" data-error>
            <Said line={`${home}'s last push did not land here`} fix={splitRaw(pushFailed).line} raw={splitRaw(pushFailed).raw} settings />
          </div>
        )}
        {failed && (
          <div className="row" role="alert" data-testid="setup-failed">
            <div className="set-said" data-error><Said {...splitRaw(failed)} settings /></div>
            <b><button className="btn sm" data-testid="setup-retry" onClick={load}>Check again</button></b>
          </div>
        )}
      </Group>
      {rows === undefined && !failed && <section className="set-group set-note" data-testid="setup-reading"><span className="move-spin" />Reading this Mac&apos;s agent setup…</section>}
      {!!rows?.length && (
        <Group name="Keys" testid="setup-keys"
          info={<Info id="setup-keys">A key stays on this Mac unless you switch it on for {home}; switched off, it leaves {home} at the next copy. A server or file sent whole stays until you remove it on {home}.</Info>}>
          <SetupTicks rows={rows} tick={tick} />
        </Group>
      )}
      {backup && (
        <Group name="Replaced on this Mac" testid="setup-backup"
          info={<Info id="setup-backup">A push from {home} replaced same-named files here and kept the old ones in this folder. Put back what you want before you copy.</Info>}>
          <div className="row">
            <span data-testid="setup-backup-label" data-tip={backup}>{backupLabel(backup)}</span>
            <b><button className="btn sm" data-testid="setup-backup-show" onClick={() => openFolder(app.bridge, backup, me)}>Show in Finder</button></b>
          </div>
          {replaced.length > 0 && <div className="set-note" data-testid="setup-replaced">Also in it: this Mac&apos;s own {replaced.join(', ')}.</div>}
        </Group>
      )}
    </>
  );
}
