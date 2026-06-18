import { openAIService, OpenAIMessage } from "../../openai";
import { ToolResult } from "./toolTypes";
import {
  listAgentSkills,
  manageAgentSkills,
  viewAgentSkill,
  readSkillReference,
  getSkillAssetList,
} from "../skills/registry";
import { executeTodoRead, executeTodoWrite } from "./todoTool";
import { executeWorkspaceTool } from "../workspace/tools";

export async function executeSkillsList(args: {
  query?: string;
}): Promise<ToolResult> {
  const skills = await listAgentSkills(args.query);
  return {
    success: true,
    data: {
      skills: skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        tags: skill.tags,
        enabled: skill.enabled,
        trusted: skill.trusted,
        diagnostics: skill.diagnostics,
      })),
    },
    summary: `Found ${skills.length} skill(s)`,
  };
}

export async function executeSkillView(args: {
  name: string;
}): Promise<ToolResult> {
  const skill = await viewAgentSkill(args.name);
  if (!skill) {
    return { success: false, error: `Skill not found: ${args.name}` };
  }
  if (!skill.enabled) {
    return { success: false, error: `Skill is disabled: ${skill.name}` };
  }
  return {
    success: true,
    data: skill,
    summary: `Activated skill: ${skill.name}`,
  };
}

export async function executeSkillManage(args: {
  action:
    | "refresh"
    | "enable"
    | "disable"
    | "trust_source"
    | "untrust_source"
    | "add_source"
    | "remove_source";
  skill?: string;
  source_path?: string;
}): Promise<ToolResult> {
  const result = await manageAgentSkills(args);
  return {
    success: true,
    data: {
      state: result.state,
      skills: result.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        source: skill.source,
        enabled: skill.enabled,
        trusted: skill.trusted,
      })),
    },
    summary: `Skill registry ${args.action} complete`,
  };
}

export async function executeSkillReference(args: {
  name: string;
  path?: string;
}): Promise<ToolResult> {
  try {
    const content = await readSkillReference(args.name, args.path);
    if (content === null) {
      return {
        success: false,
        error: `Reference file not found for skill "${args.name}"${args.path ? ` at "${args.path}"` : ""}`,
      };
    }
    return {
      success: true,
      data: {
        skill: args.name,
        path: args.path || null,
        content,
      },
      summary: `Read reference from ${args.name}${args.path ? `/${args.path}` : ""} (${content.length} chars)`,
    };
  } catch (e: any) {
    return {
      success: false,
      error: `Failed to read skill reference: ${e?.message || e}`,
    };
  }
}

export async function executeSkillInfo(args: {
  name: string;
}): Promise<ToolResult> {
  try {
    const info = await getSkillAssetList(args.name);
    if (!info) {
      return {
        success: false,
        error: `Skill not found: ${args.name}`,
      };
    }
    return {
      success: true,
      data: {
        name: args.name,
        skillDir: info.skillDir,
        references: info.references,
        scripts: info.scripts,
        assets: info.assets,
      },
      summary: `Skill "${args.name}": ${info.scripts.length} script(s), ${info.references.length} reference(s), ${info.assets.length} asset(s)`,
    };
  } catch (e: any) {
    return {
      success: false,
      error: `Failed to get skill info: ${e?.message || e}`,
    };
  }
}

export async function executeTodoAdapter(args: {
  action: "read" | "write";
  todos?: import("./toolTypes").TodoItem[];
}): Promise<ToolResult> {
  if (args.action === "read") return executeTodoRead();
  return executeTodoWrite({ todos: args.todos || [] });
}

export async function executeClarify(args: {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
  }>;
}): Promise<ToolResult> {
  return executeWorkspaceTool("workspace_question", args);
}

async function runBoundedAgent(prompt: string): Promise<string> {
  const messages: OpenAIMessage[] = [
    {
      role: "system",
      content:
        "You are a bounded research sub-agent. Do not claim tool access. Answer from the provided prompt only, state assumptions, and keep the response concise.",
    },
    { role: "user", content: prompt },
  ];
  return openAIService.chatCompletion(messages, {
    max_tokens: 1200,
    isolated: true,
  } as any);
}

export async function executeDelegateTask(args: {
  task: string;
  context?: string;
}): Promise<ToolResult> {
  const output = await runBoundedAgent(
    [args.task, args.context ? `Context:\n${args.context}` : ""]
      .filter(Boolean)
      .join("\n\n"),
  );
  return {
    success: true,
    data: { output },
    summary: "Delegated task completed",
  };
}

export async function executeMixtureOfAgents(args: {
  task: string;
  agents?: Array<{ name?: string; instruction: string }>;
}): Promise<ToolResult> {
  const agents =
    args.agents && args.agents.length > 0
      ? args.agents.slice(0, 4)
      : [
          { name: "methods", instruction: "Focus on methods and validity." },
          { name: "evidence", instruction: "Focus on evidence and citations." },
          { name: "synthesis", instruction: "Focus on synthesis and gaps." },
        ];
  const outputs = await Promise.all(
    agents.map(async (agent) => ({
      name: agent.name || "agent",
      output: await runBoundedAgent(
        `${agent.instruction}\n\nTask:\n${args.task}`,
      ),
    })),
  );
  const synthesis = await runBoundedAgent(
    `Synthesize these independent agent outputs into one concise answer:\n\n${outputs
      .map((o) => `## ${o.name}\n${o.output}`)
      .join("\n\n")}`,
  );
  return {
    success: true,
    data: { outputs, synthesis },
    summary: `Mixture of ${outputs.length} agents completed`,
  };
}
