import type { CliAgentDef } from "./cliTypes";
import { codexAgentDef } from "./codexAgent";
import { claudeAgentDef } from "./claudeAgent";
import { antigravityAgentDef } from "./antigravityAgent";
import { hermesAgentDef } from "./hermesAgent";
import { openclawAgentDef } from "./openclawAgent";

// Supported terminal harnesses. Copilot (copilotAgent.ts) is intentionally not
// registered for now — the file is kept so it can be re-added easily.
const CLI_AGENTS: CliAgentDef[] = [
  codexAgentDef,
  claudeAgentDef,
  antigravityAgentDef,
  hermesAgentDef,
  openclawAgentDef,
];

const BY_ID = new Map(CLI_AGENTS.map((agent) => [agent.id, agent]));

export function getCliAgent(id: string | undefined): CliAgentDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function listCliAgents(): CliAgentDef[] {
  return CLI_AGENTS;
}
