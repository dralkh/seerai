import {
  formatModelDisplayName,
  inferCapabilities,
  type DiscoveredModel,
} from "../providerTypes";
import { getCliAgent } from "./agents";
import { runCliCapture } from "./cliRunner";

/**
 * Pull the live model list from an installed CLI when it supports listing
 * (e.g. `codex debug models`). Returns [] when the agent has no list command
 * or the call fails — callers fall back to the preset catalog.
 */
export async function fetchCliModels(
  agentId: string | undefined,
): Promise<DiscoveredModel[]> {
  const agent = getCliAgent(agentId);
  if (!agent?.listModels) return [];
  try {
    const res = await runCliCapture(agent.bin, agent.listModels.args, 12000);
    const parsed = agent.listModels.parse(res.stdout || res.stderr || "");
    return parsed.map((m) => ({
      id: m.id,
      object: "model",
      displayName: m.label || formatModelDisplayName(m.id),
      capabilities: m.capabilities || inferCapabilities(m.id),
    }));
  } catch {
    return [];
  }
}
