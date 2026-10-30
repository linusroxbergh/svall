import { useEffect, useState } from 'react';
import { robotSender, type Robot } from '@svall/protocol';
import type { Api } from './api.js';

const PROMPT_HISTORY = 30;

/** The prompts sent to this agent, newest first, and the one being read; read from the transcript, so they survive a restart. */
export function usePromptHistory(api: () => Pick<Api, 'call'>, id: string, agent: Robot['agent']) {
  const [hist, setHist] = useState<{ list: string[]; at: number }>({ list: [], at: 0 });
  const running = agent?.status === 'working' || agent?.status === 'blocked';

  useEffect(() => {
    if (!agent) return;
    let live = true;
    api().call('robot.prompts', { id, limit: PROMPT_HISTORY })
      .then((r) => {
        if (!live) return;
        // another robot's message is not a command the user sent
        const list = r.prompts.filter((p) => !robotSender(p));
        // a new prompt pushes the one being read down the list; follow the prompt, not the index
        setHist((h) => {
          const reading = h.list[h.at];
          return { list, at: h.at === 0 ? 0 : Math.max(0, list.indexOf(reading)) };
        });
      })
      .catch(() => { if (live) setHist({ list: [], at: 0 }); });
    return () => { live = false; };
    // read again on a new session, a new prompt (told by its time: one sent mid-turn carries the turn's first id) or a
    // turn's end; the tool events and permission asks in between would re-read the tail for nothing
  }, [id, agent?.sessionId, agent?.transcriptPath, agent?.lastPrompt?.at, running]);

  const { list } = hist;
  const at = Math.min(hist.at, Math.max(0, list.length - 1));
  return { list, at, step: (by: 1 | -1) => setHist({ list, at: at + by }) };
}
