import { useRef, useState, type JSX } from 'react';
import { useApp, useFitHeight } from '../hooks.js';
import { phone } from './boot.js';
import { writeDraft } from './draft.js';
import { startMission } from './mission.js';

/** The phone's cmd+G: a prompt under the fleet starts a home robot on it and opens it. */
export function MissionBar({ onOpen }: { onOpen(id: string): void }): JSX.Element | null {
  const fleet = useApp((s) => s.fleet);
  const loaded = useApp((s) => s.loaded);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);

  useFitHeight(field, text);

  if (!loaded) return null;

  const send = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // a prompt the agent never took waits in the robot's own composer
      const { id, sent } = await startMission(phone.api(), fleet, prompt);
      if (!sent) writeDraft(id, prompt);
      setText('');
      onOpen(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="composer mission" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {error && <p className="sheet-error">{error}</p>}
      <textarea ref={field} value={text} rows={1} placeholder="what should the fleet do?" aria-label="Mission control" enterKeyHint="enter"
        autoCapitalize="off" autoCorrect="off" onChange={(e) => setText(e.target.value)} />
      <button type="submit" disabled={busy || !text.trim()}>{busy ? 'starting…' : 'start'}</button>
    </form>
  );
}
