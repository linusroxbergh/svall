import { Command } from 'commander';
import { AGENTS, findAgents, mainAgent } from '@archipelago/archid/agents';
import { loadConfig, saveMainAgent } from '@archipelago/archid/config';
import { resolvePaths } from '@archipelago/archid/paths';
import { AgentKind, type FleetState } from '@archipelago/protocol';
import { Client } from '../client.js';
import { printResult } from '../format.js';
import type { Target } from '../target.js';

export type AgentDeps = { configFile: string; found: AgentKind[]; apply(agent: AgentKind): Promise<boolean> };

const label = (k: AgentKind) => AGENTS[k].label;

export async function setMainAgentCli(d: AgentDeps, agent: AgentKind): Promise<string> {
  // a running archid checks the CLI against its own PATH and writes config.json itself
  if (await d.apply(agent)) return `Main agent: ${label(agent)}`;
  if (!d.found.includes(agent)) throw new Error(`${AGENTS[agent].bin} is not on PATH; install ${label(agent)} first`);
  saveMainAgent(d.configFile, agent);
  return `Main agent: ${label(agent)}; archid uses it from its next start`;
}

async function fleetState(home: string): Promise<FleetState | undefined> {
  let c: Client;
  try { c = await Client.connect(home); } catch { return undefined; }
  try { return await c.call('state.get', {}); } finally { c.close(); }
}

export function agentCommand(target: () => Target, json: () => boolean): Command {
  return new Command('agent')
    .description('show or set the main agent: what the scribe, mission control and archi char new --run run by default')
    .argument('[name]', 'claude or codex')
    .action(async (name: string | undefined) => {
      const t = target();
      const configFile = resolvePaths(t.home).config;
      const found = findAgents(process.env.PATH ?? '');
      if (name === undefined) {
        // a running archid answers with what the fleet uses, which its own PATH and its start's config.json decide
        const live = await fleetState(t.home);
        const agent = live?.mainAgent ?? mainAgent(loadConfig(configFile).mainAgent, found);
        printResult({ agent, found: live?.agentsFound ?? found }, json(), () => `Main agent: ${label(agent)}`);
        return;
      }
      const agent = AgentKind.safeParse(name);
      if (!agent.success) throw new Error(`unknown agent ${name}; use claude or codex`);
      const line = await setMainAgentCli({
        configFile, found,
        apply: async (a) => {
          let c: Client;
          // no archid, or one speaking another protocol, cannot take it; its next start reads config.json
          try { c = await Client.connect(t.home); } catch { return false; }
          try { await c.call('mainAgent.set', { agent: a }); return true; } finally { c.close(); }
        },
      }, agent.data);
      printResult({ agent: agent.data }, json(), () => line);
    });
}
