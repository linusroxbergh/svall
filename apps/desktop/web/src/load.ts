import { useEffect, useState } from 'react';
import type { LoadSnapshot } from '@svall/protocol';
import { app } from './boot.js';

const POLL_MS = 4000;

// svalld samples load only while it is asked, so this polls only while enabled
export function useLoad(enabled: boolean): LoadSnapshot | undefined {
  const [load, setLoad] = useState<LoadSnapshot>();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () => app.api().call('load.get', {})
      .then((s) => { if (live) setLoad(s); })
      .catch(() => {});
    void read();
    const poll = setInterval(read, POLL_MS);
    return () => { live = false; clearInterval(poll); };
  }, [enabled]);
  return enabled ? load : undefined;
}
