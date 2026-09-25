import { app, deps } from './boot.js';
import { useApp } from './hooks.js';
import { chooseResource } from './resources/choose.js';
import { loadResources } from './resources/load.js';

// no file can be named this, so the menu's last entry never stands for a profile
const MANAGE = '\u0000manage';
const NONE: never[] = [];

/** The role a character plays, picked from the fleet's agent profiles; the line under it says what the role is without opening it. */
export function AgentProfilePick({ id }: { id: string }) {
  const picked = useApp((s) => s.fleet.characters[id]?.agentProfile);
  const running = useApp((s) => Boolean(s.fleet.characters[id]?.agent));
  const fleet = useApp((s) => s.resources.find((r) => r.tier === 'fleet'));
  const items = fleet?.groups.find((g) => g.kind === 'agentProfiles')?.items ?? NONE;
  const current = picked === undefined ? undefined : items.find((i) => i.name === picked);
  const shelf = () => { if (fleet) app.store.getState().toggleResources(true, { where: fleet.rootId, what: 'agentProfiles' }); };
  // archid reads the file as it saves the pick and refuses one it cannot use, so only its yes is told as one; the listing is read
  // again either way, so the line under says what the folder holds now
  const pick = (v: string) => {
    if (v === MANAGE) { shelf(); return; }
    const toast = app.store.getState().showToast;
    void deps().api.call('char.update', { id, agentProfile: v }).then(
      () => { if (v && running) toast(`${v} applies from the agent’s next prompt`, 'ok'); },
      (e: Error) => toast(e.message, 'error'));
    void loadResources(deps());
  };
  // before the listing has come there is nothing to say a profile is missing
  const hint = picked === undefined || !fleet ? undefined
    : !current ? `${picked}.md is not in the agent profiles folder` : current.error ? `${picked} ${current.error}` : current.detail;
  return (
    <>
      <div className="side-profile">
        <select className="fld" aria-label="Agent profile" value={picked ?? ''} data-testid="side-agent-profile" onChange={(e) => pick(e.target.value)}>
          <option value="">No profile</option>
          {items.map((i) => <option key={i.id} value={i.name} disabled={Boolean(i.error) && i.name !== picked}>{i.error ? `${i.name} (${i.error})` : i.name}</option>)}
          {picked !== undefined && !current && <option value={picked}>{fleet ? `${picked} (missing)` : picked}</option>}
          {fleet && <option value={MANAGE}>Manage profiles…</option>}
        </select>
        {current?.open && (
          <button className="btn sm res-open" data-testid="side-agent-profile-view" title={`Open ${current.reveal}`}
            onClick={() => { shelf(); void chooseResource(deps(), current); }}>View</button>
        )}
      </div>
      {hint && <div className="side-profile-hint" data-error={!current || Boolean(current.error)} data-testid="side-agent-profile-hint">{hint}</div>}
    </>
  );
}
