import { useEffect, useState, type JSX } from 'react';
import { commitFocused } from '../Field.js';
import { useApp } from '../hooks.js';
import { CharacterView } from './CharacterView.js';
import { Fleet } from './Fleet.js';
import { parseRoute, routePath, type Route } from './route.js';

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  const openId = route.view === 'char' ? route.id : undefined;
  // a character that is closed on the Mac takes its view with it
  const gone = useApp((s) => Boolean(openId && s.loaded && !s.fleet.characters[openId]));

  useEffect(() => {
    // a field saves on blur, which a view taken away by the back gesture never sends
    const onPop = () => { commitFocused(); setRoute(parseRoute(location.pathname)); };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!gone) return;
    history.replaceState(null, '', '/');
    setRoute({ view: 'fleet' });
  }, [gone]);

  const go = (r: Route) => { history.pushState({ pushed: true }, '', routePath(r)); setRoute(r); };
  // a character this session opened is popped; one opened cold from a notification has no entry behind it
  const back = () => {
    if ((history.state as { pushed?: boolean } | null)?.pushed) { history.back(); return; }
    history.replaceState(null, '', '/');
    setRoute({ view: 'fleet' });
  };

  if (openId && !gone) return <CharacterView id={openId} onBack={back} />;
  return <Fleet onOpen={(id) => go({ view: 'char', id })} />;
}
