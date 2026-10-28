import { HOME_ISLAND, type FleetState } from '@svall/protocol';
import { skillPrompt } from '../actions.js';
import type { Api } from '../api.js';

/** Starts a home robot on a prompt, as cmd+G does on the Mac; `sent` is false when the agent never took the prompt. */
export async function startMission(api: Pick<Api, 'call'>, f: FleetState, prompt: string, label?: string): Promise<{ id: string; sent: boolean }> {
  const { cwd, command } = f.home;
  const c = await api.call('robot.create', { islandId: HOME_ISLAND, cwd, command, ...(label ? { name: label } : {}), run: skillPrompt(command, prompt) });
  return { id: c.id, sent: c.runSent !== false };
}
