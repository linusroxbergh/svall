import { useEffect, useRef, useState } from 'react';
import { phone } from './boot.js';

/** Approve or deny the question `promptId` names. An answer stays in flight until the daemon reports the agent unblocked or
 *  on another question, so one tap answers once. */
export function useAnswer(id: string, promptId: string | undefined, blocked: boolean): { answering: boolean; error?: string; answer(a: 'approve' | 'deny'): Promise<void> } {
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string>();
  const asking = useRef(promptId);
  useEffect(() => { asking.current = promptId; setAnswering(false); setError(undefined); }, [blocked, promptId]);

  const answer = async (a: 'approve' | 'deny') => {
    if (answering) return;
    setAnswering(true);
    setError(undefined);
    try {
      await phone.api().call('robot.answer', { id, answer: a, promptId });
    } catch (e) {
      // a refusal that comes back after a newer question is up is not that question's
      if (asking.current !== promptId) return;
      setError((e as Error).message);
      setAnswering(false);
    }
  };
  return { answering, error, answer };
}
