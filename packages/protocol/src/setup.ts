import type { AgentKind } from './state.js';

// an agent found only by its folder gets hooks and a toggle, but cannot be the main agent
export type FoundAgent = { kind: AgentKind; path: string; version?: string; folderOnly?: boolean };

/** What `svall setup --plan` prints for the app's setup screen. */
export type SetupPlan = {
  agents: FoundAgent[]; integrations?: AgentKind[]; writes: { what: string; path: string; agent?: AgentKind }[];
  shimDir: string; shimOnPath: boolean; blockers: string[]; projects: string;
  // how to install each agent's CLI, while setup found none
  install?: { kind: AgentKind; command: string; url: string }[];
};
