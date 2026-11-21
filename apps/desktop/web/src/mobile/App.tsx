import { useEffect, useState, type JSX } from 'react';
import { commitFocused } from '../Field.js';
import { useApp } from '../hooks.js';
import { phone } from './boot.js';
import { RobotView } from './RobotView.js';
import { Fleet } from './Fleet.js';
import { movedTo } from './list.js';
import { MissionBar } from './MissionBar.js';
import { parseRoute, routePath, type Route } from './route.js';
import { Waiting } from './Waiting.js';

// an entry this session pushed, and for a robot, the page it was opened from when that is not the fleet
type Entry = { pushed?: true; from?: 'waiting' };
const entry = (): Entry => (history.state as Entry | null) ?? {};

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  const openId = route.view === 'robot' ? route.id : undefined;
  // a robot that is closed on the Mac takes its view with it
  const gone = useApp((s) => Boolean(openId && s.loaded && !s.fleet.robots[openId]));
  // a fleet the page cannot change says why on the list
  const listOnly = useApp((s) => movedTo(s.fleet, s.via, s.status) !== undefined || s.status === 'unpaired' || s.status === 'refused');

  useEffect(() => {
    // a field saves on blur, which a view taken away by the back gesture never sends
    const onPop = () => { commitFocused(); setRoute(parseRoute(location.pathname)); };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => { if (gone) back(); }, [gone]);

  const shown = gone ? undefined : openId;
  useEffect(() => { phone.view(shown); }, [shown]);

  const go = (r: Route) => { history.pushState({ pushed: true, ...(route.view === 'waiting' && { from: 'waiting' }) } satisfies Entry, '', routePath(r)); setRoute(r); };
  // a view this session opened is popped; one opened cold from a notification has no entry behind it
  function back() {
    if (entry().pushed) { history.back(); return; }
    history.replaceState(null, '', '/');
    setRoute({ view: 'fleet' });
  }

  // the next robot takes this one's place, so back still leads to the list
  const swap = (id: string) => { history.replaceState(history.state, '', routePath({ view: 'robot', id })); setRoute({ view: 'robot', id }); };

  if (openId && !gone) return <RobotView key={openId} id={openId} backTo={entry().from ?? 'fleet'} onBack={back} onNext={swap} />;
  const open = (id: string) => go({ view: 'robot', id });
  if (route.view === 'waiting' && !listOnly) return <Waiting onOpen={open} onBack={back} />;
  return <><Fleet onOpen={open} onWaiting={() => go({ view: 'waiting' })} /><MissionBar onOpen={open} /></>;
}
