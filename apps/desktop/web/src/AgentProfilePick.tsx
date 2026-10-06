import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { app, deps } from './boot.js';
import { useApp } from './hooks.js';
import { chooseResource } from './resources/choose.js';
import { loadResources } from './resources/load.js';
import { placeTip } from './settings.js';
import { Caret } from './Sidebar.js';

// no file can be named this, so the menu's last entry never stands for a profile
const MANAGE = '\u0000manage';
const NONE: never[] = [];

type Opt = { value: string; name: string; detail?: string; error?: boolean; disabled?: boolean };

/** The role a character plays, picked from the fleet's agent profiles; the line under it says what the role is without opening it. */
export function AgentProfilePick({ id }: { id: string }) {
  const picked = useApp((s) => s.fleet.characters[id]?.agentProfile);
  const running = useApp((s) => Boolean(s.fleet.characters[id]?.agent));
  const fleet = useApp((s) => s.resources.find((r) => r.tier === 'fleet'));
  const items = fleet?.groups.find((g) => g.kind === 'agentProfiles')?.items ?? NONE;
  const current = picked === undefined ? undefined : items.find((i) => i.name === picked);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties>();
  const row = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const shelf = () => { if (fleet) app.store.getState().toggleResources(true, { where: fleet.rootId, what: 'agentProfiles' }); };
  // svalld reads the file as it saves the pick and refuses one it cannot use, so only its yes is told as one; the listing is read
  // again either way, so the line under says what the folder holds now
  const pick = (v: string) => {
    if (v === MANAGE) { shelf(); return; }
    const toast = app.store.getState().showToast;
    void deps().api.call('char.update', { id, agentProfile: v }).then(
      () => { if (v && running) toast(`${v} applies from the next prompt`, 'ok'); },
      (e: Error) => toast(e.message, 'error'));
    void loadResources(deps());
  };
  // before the listing has come there is nothing to say a profile is missing
  const hint = picked === undefined || !fleet ? undefined
    : !current ? `${picked}.md is not in the agent profiles folder` : current.error ? `${picked} ${current.error}` : current.detail;

  const opts: Opt[] = [
    { value: '', name: 'No profile' },
    ...items.map((i) => ({ value: i.name, name: i.name, detail: i.error ?? i.detail, error: Boolean(i.error), disabled: Boolean(i.error) && i.name !== picked })),
    ...(picked !== undefined && !current ? [{ value: picked, name: fleet ? `${picked} (missing)` : picked }] : []),
    ...(fleet ? [{ value: MANAGE, name: 'Manage profiles…' }] : []),
  ];
  const chosen = Math.max(0, opts.findIndex((o) => o.value === (picked ?? '')));
  const choose = (o: Opt) => { setOpen(false); if (o.value !== (picked ?? '')) pick(o.value); };
  const show = () => { setActive(chosen); setOpen(true); };
  const step = (from: number, by: number) => {
    for (let i = from + by; i >= 0 && i < opts.length; i += by) if (!opts[i].disabled) return i;
    return from;
  };
  // the page closes the card on Escape and opens the terminal on Enter, so the keys the menu uses stop here
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab') { setOpen(false); return; }
    const act = !open ? (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) ? show : undefined) : {
      ArrowDown: () => setActive((a) => step(a, 1)),
      ArrowUp: () => setActive((a) => step(a, -1)),
      Home: () => setActive(step(-1, 1)),
      End: () => setActive(step(opts.length, -1)),
      Enter: () => choose(opts[active]),
      ' ': () => choose(opts[active]),
      Escape: () => setOpen(false),
    }[e.key];
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  };

  // the menu hangs under the field or flips over it, capped at the room the card has there; it is fixed to the window,
  // so the section it sits in does not clip it, and placed again when that section scrolls
  useLayoutEffect(() => {
    const at = row.current, el = menu.current;
    if (!open || !at || !el) return;
    const measure = () => {
      const r = at.getBoundingClientRect();
      const panel = at.closest('.side')?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const { above, maxHeight } = placeTip(r, el.scrollHeight, panel);
      setPlace({ left: r.left, width: r.width, maxHeight: maxHeight || undefined,
        ...(above ? { bottom: window.innerHeight - r.top + 5 } : { top: r.bottom + 5 }) });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
  }, [open]);
  useEffect(() => { if (open) menu.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [open, active]);

  return (
    <>
      <div className="side-profile" ref={row}>
        {/* WebKit leaves a clicked button unfocused, so the click focuses it: the keys and the blur that closes the menu come to it;
            the press keeps focus where it is, or WebKit's blur would close the menu just before the click opens it again */}
        <button type="button" className="fld" role="combobox" aria-label="Agent profile" aria-haspopup="listbox" aria-expanded={open}
          aria-controls={`side-profile-menu-${id}`} aria-activedescendant={open ? `side-profile-${id}-${active}` : undefined}
          data-none={picked === undefined} data-testid="side-agent-profile" onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.currentTarget.focus(); if (open) setOpen(false); else show(); }} onKeyDown={onKey} onBlur={() => setOpen(false)}>
          <span>{opts[chosen].name}</span><Caret open />
        </button>
        {current?.open && (
          <button className="btn sm res-open" data-testid="side-agent-profile-view" title={`Open ${current.reveal}`}
            onClick={() => { shelf(); void chooseResource(deps(), current); }}>View</button>
        )}
        {open && (
          <div ref={menu} className="side-profile-menu" role="listbox" id={`side-profile-menu-${id}`} aria-label="Agent profile"
            style={place}
            onMouseDown={(e) => e.preventDefault()}>
            {opts.map((o, i) => (
              <Fragment key={o.value}>
                {o.value === MANAGE && <div className="side-profile-sep" aria-hidden="true" />}
                <div id={`side-profile-${id}-${i}`} role="option" className="side-profile-opt" aria-selected={i === chosen} aria-disabled={o.disabled || undefined}
                  data-active={i === active} data-manage={o.value === MANAGE || undefined}
                  data-testid={`side-agent-profile-opt-${o.value === MANAGE ? 'manage' : o.value || 'none'}`}
                  onPointerEnter={() => { if (!o.disabled) setActive(i); }} onClick={() => { if (!o.disabled) choose(o); }}>
                  <b>{o.name}</b>
                  {i === chosen && <Check />}
                  {o.detail && <span data-error={o.error}>{o.detail}</span>}
                </div>
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {hint && <div className="side-profile-hint" data-error={!current || Boolean(current.error)} data-testid="side-agent-profile-hint">{hint}</div>}
    </>
  );
}

function Check() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.8 5.4 4 7.6 8.4 2.6" />
    </svg>
  );
}
