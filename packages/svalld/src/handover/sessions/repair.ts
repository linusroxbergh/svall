import type { AgentKind } from '@svall/protocol';
import { condenseTurns } from '../../agent/transcript.js';

const NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/**
 * A brief to start a fresh agent with when a session cannot be resumed. It is a new conversation that
 * reads a summary of the old one: nothing here resumes, copies or renames the old session, and a handover
 * never calls it on its own.
 */
export function repairBrief(kind: AgentKind, transcript: string, o: { sessionId: string; turns?: number }): string {
  const turns = condenseTurns(kind, transcript, o.turns ?? 40);
  return [
    `This is a new ${NAMES[kind]} session. The earlier session ${o.sessionId} could not be resumed on this machine,`,
    'so what follows is a summary of its last turns, not that conversation itself. Paths in it may name the',
    'machine it ran on.',
    '',
    turns || '(the earlier session left no turns to summarise)',
  ].join('\n');
}
