import { useEffect, useState } from 'react';
import type { LoadSnapshot } from '@svall/protocol';
import { app } from './boot.js';

const POLL_MS = 4000;

// svalld samples load only while it is asked, so this polls only while enabled; each read waits on the
// last, and a reading from before a pause is never shown after it. A read that fails keeps the last
// reading beside its error until one succeeds
export function useLoad(enabled: boolean): { load?: LoadSnapshot; error?: string } {
  const [load, setLoad] = useState<LoadSnapshot>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let next: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      app.api().call('load.get', {})
        .then((s) => { if (live) { setLoad(s); setError(undefined); } }, (e: Error) => { if (live) setError(e.message); })
        .finally(() => { if (live) next = setTimeout(read, POLL_MS); });
    };
    read();
    return () => { live = false; clearTimeout(next); setLoad(undefined); setError(undefined); };
  }, [enabled]);
  return enabled ? { load, error } : {};
}
