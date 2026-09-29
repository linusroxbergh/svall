import { useEffect, useState } from 'react';
import type { Character } from '@svall/protocol';
import type { Api } from './api.js';

const PROMPT_HISTORY = 30;

/** The prompts sent to this agent, newest first, and the one being read; read from the transcript, so they survive a restart. */
export function usePromptHistory(api: () => Pick<Api, 'call'>, id: string, agent: Character['agent']) {
  const [hist, setHist] = useState<{ list: string[]; at: number }>({ list: [], at: 0 });
  const running = agent?.status === 'working' || agent?.status === 'blocked';

  useEffect(() => {
    if (!agent) return;
    let live = true;
    api().call('char.prompts', { id, limit: PROMPT_HISTORY })
      .then((r) => {
        if (!live) return;
        // a new prompt pushes the one being read down the list; follow the prompt, not the index
        setHist((h) => {
          const reading = h.list[h.at];
          return { list: r.prompts, at: h.at === 0 ? 0 : Math.max(0, r.prompts.indexOf(reading)) };
        });
      })
      .catch(() => { if (live) setHist({ list: [], at: 0 }); });
    return () => { live = false; };
    // a new session or prompt changes the list, and a turn's end settles what its prompt left pending;
    // the tool events and permission asks in between would re-read the tail for nothing
  }, [id, agent?.sessionId, agent?.transcriptPath, agent?.lastPrompt?.id, running]);

  const { list } = hist;
  const at = Math.min(hist.at, Math.max(0, list.length - 1));
  return { list, at, step: (by: 1 | -1) => setHist({ list, at: at + by }) };
}
