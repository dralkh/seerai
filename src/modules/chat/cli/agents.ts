import type { CliAgentDef } from "./cliTypes";
import { codexAgentDef } from "./codexAgent";
import { claudeAgentDef } from "./claudeAgent";
import { antigravityAgentDef } from "./antigravityAgent";
import { copilotAgentDef } from "./copilotAgent";

const CLI_AGENTS: CliAgentDef[] = [
  codexAgentDef,
  claudeAgentDef,
  antigravityAgentDef,
  copilotAgentDef,
];

const BY_ID = new Map(CLI_AGENTS.map((agent) => [agent.id, agent]));

export function getCliAgent(id: string | undefined): CliAgentDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function listCliAgents(): CliAgentDef[] {
  return CLI_AGENTS;
}
