import type { AgentKind } from '@svall/protocol';
import { condenseTurns } from '../agent/transcript.js';

const NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/** A brief for a fresh agent when a session cannot be resumed: a new conversation reading a summary of the old one, which
 *  nothing here resumes, copies or renames. A move never calls it on its own. */
export function repairBrief(kind: AgentKind, transcript: string, o: { sessionId: string }): string {
  const turns = condenseTurns(kind, transcript, 40);
  return [
    `This is a new ${NAMES[kind]} session. The earlier session ${o.sessionId} could not be resumed on this machine,`,
    'so what follows is a summary of its last turns, not that conversation itself. Paths in it may name the',
    'machine it ran on.',
    '',
    turns || '(the earlier session left no turns to summarise)',
  ].join('\n');
}
