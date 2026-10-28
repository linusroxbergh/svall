import type { AgentKind } from '@svall/protocol';
import { AGENT_LABEL } from '@svall/protocol';

export type Key = { label: string; seq: string; hint?: string };
export type KeyGroup = { title: string; keys: Key[] };

/** The row under the terminal: what an agent's TUI asks for most, in the order a thumb reaches them. */
export const KEY_ROW: Key[] = [
  { label: 'esc', seq: '\x1b' }, { label: 'tab', seq: '\t' }, { label: '⇧tab', seq: '\x1b[Z' }, { label: '^C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' }, { label: '↓', seq: '\x1b[B' }, { label: '↩', seq: '\r' },
];

const cmd = (label: string, hint: string): Key => ({ label, seq: `${label}\r`, hint });

const AGENT: Record<AgentKind, Key[]> = {
  claude: [
    { label: '⇧tab', seq: '\x1b[Z', hint: 'cycle permission mode' },
    { label: 'esc esc', seq: '\x1b\x1b', hint: 'rewind the conversation' },
    { label: '^O', seq: '\x0f', hint: 'show or hide the full transcript' },
    { label: '^T', seq: '\x14', hint: 'show or hide the todo list' },
    { label: '^B', seq: '\x02', hint: 'send the running task to the background' },
    cmd('/compact', 'summarise the context'),
    cmd('/clear', 'start a fresh conversation'),
    cmd('/model', 'pick the model'),
    cmd('/status', 'account, model and context'),
    cmd('/resume', 'pick an earlier conversation'),
  ],
  codex: [
    { label: '⇧tab', seq: '\x1b[Z', hint: 'switch mode' },
    { label: 'esc esc', seq: '\x1b\x1b', hint: 'edit the previous message' },
    { label: '^T', seq: '\x14', hint: 'show or hide the transcript' },
    cmd('/model', 'pick the model and reasoning effort'),
    cmd('/approvals', 'what Codex may do unasked'),
    cmd('/compact', 'summarise the context'),
    cmd('/status', 'session, model and token use'),
    cmd('/new', 'start a fresh conversation'),
  ],
  opencode: [
    { label: 'tab', seq: '\t', hint: 'switch agent' },
    cmd('/models', 'pick the model'),
    cmd('/compact', 'summarise the context'),
    cmd('/new', 'start a fresh session'),
    cmd('/help', 'the keys and commands'),
  ],
};

const TERMINAL: Key[] = [
  { label: '^C', seq: '\x03', hint: 'interrupt' },
  { label: '^D', seq: '\x04', hint: 'end the input, or quit' },
  { label: '^L', seq: '\x0c', hint: 'clear the screen' },
  { label: '^U', seq: '\x15', hint: 'clear the line' },
  { label: '^R', seq: '\x12', hint: 'search the history' },
  { label: '←', seq: '\x1b[D', hint: 'left' },
  { label: '→', seq: '\x1b[C', hint: 'right' },
  { label: 'pgup', seq: '\x1b[5~', hint: 'a page back' },
  { label: 'pgdn', seq: '\x1b[6~', hint: 'a page on' },
];

/** The keys sheet's groups: the agent's own keys and slash commands, then the terminal's. */
export const keyGroups = (kind: AgentKind | undefined): KeyGroup[] =>
  [...(kind ? [{ title: AGENT_LABEL[kind], keys: AGENT[kind] }] : []), { title: 'Terminal', keys: TERMINAL }];
