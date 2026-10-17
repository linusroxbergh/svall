import { useEffect, useState } from 'react';
import type { LoadSnapshot } from '@svall/protocol';
import { app } from './boot.js';

const POLL_MS = 4000;

// svalld samples load only while it is asked, so this polls only while enabled; each read waits on the
// last, and a reading from before a pause is never shown after it
export function useLoad(enabled: boolean): LoadSnapshot | undefined {
  const [load, setLoad] = useState<LoadSnapshot>();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let next: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      app.api().call('load.get', {})
        .then((s) => { if (live) setLoad(s); }, () => {})
        .finally(() => { if (live) next = setTimeout(read, POLL_MS); });
    };
    read();
    return () => { live = false; clearTimeout(next); setLoad(undefined); };
  }, [enabled]);
  return enabled ? load : undefined;
}
