import { assert } from "chai";
import { listCliAgents, getCliAgent } from "../src/modules/chat/cli/agents";
import {
  parseClaudeEventLine,
  claudeAgentDef,
} from "../src/modules/chat/cli/claudeAgent";
import {
  parseCodexEventLine,
  codexAgentDef,
} from "../src/modules/chat/cli/codexAgent";
import { hermesAgentDef } from "../src/modules/chat/cli/hermesAgent";
import { openclawAgentDef } from "../src/modules/chat/cli/openclawAgent";
import {
  formatToolNotice,
  isSeeraiTool,
} from "../src/modules/chat/cli/toolNotice";
import {
  getProviderPresets,
  getPresetById,
} from "../src/modules/chat/providerPresets";
import {
  buildMcpEnv,
  buildClaudeMcpConfig,
  buildCodexMcpArgs,
  applyMcpServerEntry,
  isHarnessConnected,
  MCP_SERVER_NAME,
  HERMES_TOOLSETS,
} from "../src/modules/chat/cli/mcpBridge";
import { buildCliAgentInstructions } from "../src/modules/chat/cli/harnessPrompt";
import {
  TOOL_DEFINITIONS,
  RESEARCH_TOOL_NAMES,
  filterToolsByProfile,
} from "../mcp-server/src/tools";
import type { CliParseResult } from "../src/modules/chat/cli/cliTypes";

// Exactly the harnesses we support right now. Update both this list and the
// registry together — the wiring test below keeps them in lockstep.
const EXPECTED_AGENT_IDS = [
  "codex",
  "claude",
  "antigravity",
  "hermes",
  "openclaw",
];

function kinds(results: CliParseResult[]): string[] {
  return results.map((r) => r.kind);
}

function localCliPresets() {
  return getProviderPresets().filter((p) => p.adapterId === "local-cli");
}

// OpenClaw's single-JSON parser (its presence is asserted by the registry test).
const parseOpenClawFinal = (raw: string): CliParseResult =>
  openclawAgentDef.parseFinal!(raw);

describe("CLI harness integration", function () {
  // ───────────────────────────────────────────────────────────────
  // 1. Registry — exactly our scope (Hermes/Claude/Codex/Antigravity/OpenClaw)
  // ───────────────────────────────────────────────────────────────
  describe("agent registry", function () {
    it("registers exactly the five supported harnesses", function () {
      assert.deepEqual(
        listCliAgents().map((a) => a.id),
        EXPECTED_AGENT_IDS,
      );
    });

    it("does not register Copilot (dropped for now)", function () {
      assert.isUndefined(getCliAgent("copilot"));
    });

    it("resolves the new harnesses by id", function () {
      assert.equal(getCliAgent("hermes")?.bin, "hermes");
      assert.equal(getCliAgent("openclaw")?.bin, "openclaw");
    });

    it("gives every agent a non-empty name, bin and guidance", function () {
      for (const agent of listCliAgents()) {
        assert.isNotEmpty(agent.name, `${agent.id} name`);
        assert.isNotEmpty(agent.bin, `${agent.id} bin`);
        assert.isNotEmpty(agent.loginGuidance, `${agent.id} loginGuidance`);
        assert.isNotEmpty(
          agent.notFoundGuidance,
          `${agent.id} notFoundGuidance`,
        );
        assert.isAbove(
          agent.catalogModels.length,
          0,
          `${agent.id} catalogModels`,
        );
      }
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 2. Preset ↔ registry wiring — every selectable CLI preset is backed
  // ───────────────────────────────────────────────────────────────
  describe("provider presets are compatible with the registry", function () {
    it("exposes a preset for each supported harness and none for Copilot", function () {
      const ids = localCliPresets()
        .map((p) => p.id)
        .sort();
      assert.deepEqual(ids, [
        "antigravity-cli",
        "claude-cli",
        "codex-cli",
        "hermes-cli",
        "openclaw-cli",
      ]);
      assert.isUndefined(getPresetById("copilot-cli"));
    });

    it("links every local-cli preset to a registered agent", function () {
      for (const preset of localCliPresets()) {
        assert.isString(
          preset.cliAgentId,
          `${preset.id} should declare cliAgentId`,
        );
        assert.isDefined(
          getCliAgent(preset.cliAgentId),
          `${preset.id} -> ${preset.cliAgentId} must resolve to a registered agent`,
        );
      }
    });

    it("never asks seerai to store credentials for a CLI harness", function () {
      for (const preset of localCliPresets()) {
        assert.isFalse(preset.requiresApiKey, `${preset.id} requiresApiKey`);
        assert.equal(preset.authMethod, "none", `${preset.id} authMethod`);
        assert.isTrue(preset.isLocal, `${preset.id} isLocal`);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 3. Prompt delivery — stdin vs argument, and buildArgs shapes
  // ───────────────────────────────────────────────────────────────
  describe("prompt delivery and buildArgs", function () {
    it("uses stdin for Claude/Codex and arguments for Hermes/OpenClaw", function () {
      // undefined !== false -> stdin (default)
      assert.notStrictEqual(claudeAgentDef.stdinPrompt, false);
      assert.notStrictEqual(codexAgentDef.stdinPrompt, false);
      // arg/flag delivery
      assert.strictEqual(hermesAgentDef.stdinPrompt, false);
      assert.strictEqual(openclawAgentDef.stdinPrompt, false);
    });

    it("Hermes passes the prompt via `-z`", function () {
      assert.deepEqual(hermesAgentDef.buildArgs({ prompt: "hello world" }), [
        "-z",
        "hello world",
      ]);
      assert.deepEqual(hermesAgentDef.buildArgs({}), ["-z", ""]);
    });

    it("Hermes does not enable the MCP toolset unless connected", function () {
      // not agentic, and (headless) not connected → no -t, just the prompt
      assert.deepEqual(
        hermesAgentDef.buildArgs({ agentic: true, prompt: "x" }),
        ["-z", "x"],
      );
      // the toolset spec is the base CLI toolset plus the server name
      assert.equal(HERMES_TOOLSETS, "hermes-cli,seerai-zotero");
    });

    it("OpenClaw passes the prompt via --message and routes to an agent", function () {
      assert.deepEqual(openclawAgentDef.buildArgs({ prompt: "summarize" }), [
        "agent",
        "--agent",
        "default",
        "--message",
        "summarize",
        "--json",
      ]);
      // the seerai "model" field selects the OpenClaw agent identity
      assert.deepEqual(
        openclawAgentDef.buildArgs({ prompt: "go", model: "ops" }),
        ["agent", "--agent", "ops", "--message", "go", "--json"],
      );
    });

    it("Codex/Claude keep their existing flags and thread the model through", function () {
      const codex = codexAgentDef.buildArgs({ model: "gpt-5.5" });
      assert.includeMembers(codex, [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
      ]);
      assert.include(codex.join(" "), "-m gpt-5.5");

      const claude = claudeAgentDef.buildArgs({ model: "opus" });
      assert.includeMembers(claude, [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
      ]);
      assert.include(claude.join(" "), "--model opus");
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 4. Claude parser — surfaces text AND its own tool calls
  // ───────────────────────────────────────────────────────────────
  describe("parseClaudeEventLine", function () {
    function line(obj: unknown): CliParseResult[] {
      return parseClaudeEventLine(JSON.stringify(obj));
    }

    it("returns answer text", function () {
      const out = line({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      });
      assert.deepEqual(out, [{ kind: "text", text: "Hello" }]);
    });

    it("surfaces a tool_use block as a completed tool event with a detail summary", function () {
      const out = line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      });
      assert.deepEqual(out, [
        {
          kind: "tool-complete",
          id: undefined,
          name: "Bash",
          detail: "ls -la",
          owner: "cli",
          success: true,
        },
      ]);
    });

    it("returns both text and tool events from one message, in order", function () {
      const out = line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", name: "Read", input: { file_path: "/a.txt" } },
          ],
        },
      });
      assert.deepEqual(kinds(out), ["text", "tool-complete"]);
      assert.equal((out[1] as { name: string }).name, "Read");
      assert.equal((out[1] as { detail?: string }).detail, "/a.txt");
    });

    it("maps a non-success result to an error and success to done", function () {
      assert.deepEqual(line({ type: "result", subtype: "success" }), [
        { kind: "done" },
      ]);
      assert.deepEqual(
        line({ type: "result", subtype: "error_max_turns", result: "ran out" }),
        [{ kind: "error", message: "ran out" }],
      );
    });

    it("ignores system init, unknown types and malformed JSON", function () {
      assert.deepEqual(line({ type: "system", subtype: "init" }), [
        { kind: "ignore" },
      ]);
      assert.deepEqual(parseClaudeEventLine("not json"), [{ kind: "ignore" }]);
      assert.deepEqual(parseClaudeEventLine("   "), [{ kind: "ignore" }]);
    });

    it("streams text deltas from partial-message stream_events", function () {
      assert.deepEqual(
        line({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hel" },
          },
        }),
        [{ kind: "text-delta", text: "Hel" }],
      );
    });

    it("streams tool start events from partial-message stream_events", function () {
      assert.deepEqual(
        line({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "pwd" },
            },
          },
        }),
        [
          {
            kind: "tool-start",
            id: "toolu_1",
            name: "Bash",
            detail: "pwd",
            owner: "cli",
          },
        ],
      );
    });

    it("ignores non-text stream_events", function () {
      assert.deepEqual(
        line({
          type: "stream_event",
          event: { type: "content_block_start", index: 0 },
        }),
        [{ kind: "ignore" }],
      );
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 5. Codex parser — text, reasoning, and its own tool calls
  // ───────────────────────────────────────────────────────────────
  describe("parseCodexEventLine", function () {
    function item(itemObj: Record<string, unknown>): CliParseResult {
      return parseCodexEventLine(
        JSON.stringify({ type: "item.completed", item: itemObj }),
      );
    }

    it("returns agent_message text and reasoning", function () {
      assert.deepEqual(item({ type: "agent_message", text: "Answer" }), {
        kind: "text",
        text: "Answer",
      });
      assert.deepEqual(item({ type: "reasoning", text: "thinking" }), {
        kind: "reasoning",
        text: "thinking",
      });
    });

    it("surfaces shell, MCP, web-search and file-change as completed tool events", function () {
      assert.deepEqual(
        item({
          type: "command_execution",
          id: "cmd_1",
          command: "git status",
        }),
        {
          kind: "tool-complete",
          success: true,
          id: "cmd_1",
          name: "shell",
          detail: "git status",
          owner: "cli",
        },
      );
      assert.deepEqual(
        item({
          type: "mcp_tool_call",
          id: "mcp_1",
          tool: "search_library",
          server: "seerai-zotero",
        }),
        {
          kind: "tool-complete",
          success: true,
          id: "mcp_1",
          name: "search_library",
          detail: "seerai-zotero",
          owner: "seerai-mcp",
        },
      );
      assert.deepEqual(item({ type: "web_search", query: "rag papers" }), {
        kind: "tool-complete",
        success: true,
        id: undefined,
        name: "web_search",
        detail: "rag papers",
        owner: "cli",
      });
      assert.deepEqual(item({ type: "file_change" }), {
        kind: "tool-complete",
        success: true,
        id: undefined,
        name: "file_change",
        detail: undefined,
        owner: "cli",
      });
    });

    it("surfaces tool starts before completion when Codex reports them", function () {
      assert.deepEqual(
        parseCodexEventLine(
          JSON.stringify({
            type: "item.started",
            item: { type: "command_execution", id: "cmd_2", command: "ls" },
          }),
        ),
        {
          kind: "tool-start",
          id: "cmd_2",
          name: "shell",
          detail: "ls",
          owner: "cli",
        },
      );
    });

    it("maps turn lifecycle and errors", function () {
      assert.deepEqual(parseCodexEventLine('{"type":"turn.completed"}'), {
        kind: "done",
      });
      assert.deepEqual(
        parseCodexEventLine('{"type":"error","message":"boom"}'),
        { kind: "error", message: "boom" },
      );
    });

    it("ignores unrelated events and malformed JSON", function () {
      assert.deepEqual(parseCodexEventLine('{"type":"item.started"}'), {
        kind: "ignore",
      });
      assert.deepEqual(parseCodexEventLine("garbage"), { kind: "ignore" });
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 6. OpenClaw parseFinal — defensive single-JSON extraction
  // ───────────────────────────────────────────────────────────────
  describe("openclaw parseFinal", function () {
    const parseFinal = parseOpenClawFinal;

    it("pulls the reply from common top-level fields", function () {
      assert.deepEqual(parseFinal('{"message":"done"}'), {
        kind: "text",
        text: "done",
      });
      assert.deepEqual(parseFinal('{"response":"hi"}'), {
        kind: "text",
        text: "hi",
      });
    });

    it("pulls the reply from a nested data object", function () {
      assert.deepEqual(parseFinal('{"data":{"text":"nested"}}'), {
        kind: "text",
        text: "nested",
      });
    });

    it("pulls the last assistant entry from a messages transcript", function () {
      assert.deepEqual(
        parseFinal(
          '{"messages":[{"role":"user","content":"q"},{"role":"assistant","content":"a"}]}',
        ),
        { kind: "text", text: "a" },
      );
    });

    it("surfaces error envelopes (string or object)", function () {
      assert.deepEqual(parseFinal('{"error":"gateway down"}'), {
        kind: "error",
        message: "gateway down",
      });
      assert.deepEqual(parseFinal('{"error":{"message":"no agent"}}'), {
        kind: "error",
        message: "no agent",
      });
    });

    it("treats non-JSON output as an error and empty output as ignore", function () {
      assert.equal(parseFinal("gateway not running").kind, "error");
      assert.deepEqual(parseFinal("   "), { kind: "ignore" });
    });

    it("ignores a well-formed object with no recognizable reply", function () {
      assert.deepEqual(parseFinal('{"meta":{"tokens":5}}'), { kind: "ignore" });
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 7. Tool notice — communicate tool calls "other than what we defined"
  // ───────────────────────────────────────────────────────────────
  describe("tool-call notices", function () {
    it("classifies seerai tools vs the harness's own tools", function () {
      assert.isTrue(isSeeraiTool("search_library"));
      assert.isTrue(isSeeraiTool("systematic_review"));
      assert.isFalse(isSeeraiTool("Bash"));
      assert.isFalse(isSeeraiTool("Read"));
    });

    it("flags a non-seerai tool with the harness name and tool", function () {
      const notice = formatToolNotice("Claude Code CLI", "Bash", "ls -la");
      assert.include(notice, "not a seerai tool");
      assert.include(notice, "Claude Code CLI");
      assert.include(notice, "Bash");
      assert.include(notice, "ls -la");
    });

    it("does not flag one of our own tools as external", function () {
      const notice = formatToolNotice("Codex CLI (ChatGPT)", "search_library");
      assert.notInclude(notice, "not a seerai tool");
      assert.include(notice, "search_library");
    });

    it("collapses whitespace and truncates long detail", function () {
      const notice = formatToolNotice("X", "Bash", "a\n   b");
      assert.include(notice, "a b");
      const long = "x".repeat(400);
      const truncated = formatToolNotice("X", "Bash", long);
      assert.isBelow(truncated.length, 300);
    });
  });

  describe("CLI agentic gating (buildArgs)", function () {
    it("Codex uses a writable sandbox only in agentic mode", function () {
      assert.include(
        codexAgentDef.buildArgs({ agentic: true }).join(" "),
        "--sandbox workspace-write",
      );
      assert.include(
        codexAgentDef.buildArgs({ agentic: false }).join(" "),
        "--sandbox read-only",
      );
      // Default (no flag) is the safe, read-only plain-chat behavior.
      assert.include(
        codexAgentDef.buildArgs({}).join(" "),
        "--sandbox read-only",
      );
    });

    it("Claude skips permission prompts only in agentic mode", function () {
      assert.include(
        claudeAgentDef.buildArgs({ agentic: true }),
        "--dangerously-skip-permissions",
      );
      const off = claudeAgentDef.buildArgs({ agentic: false }).join(" ");
      assert.include(off, "--permission-mode default");
      assert.notInclude(off, "--dangerously-skip-permissions");
    });
  });

  describe("MCP bridge config", function () {
    it("builds the callback env with the research tool profile", function () {
      const env = buildMcpEnv();
      assert.equal(env.ZOTERO_API_URL, "http://127.0.0.1:23119");
      assert.equal(env.SEERAI_MCP_TOOL_PROFILE, "research");
      assert.equal(env.SEERAI_EXEC_PORT, "0");
      assert.equal(env.SEERAI_ENABLE_TERMINAL_TOOLS, "0");
    });

    it("builds a Claude --mcp-config server entry pointing at node", function () {
      const cfg = buildClaudeMcpConfig("/bin/seerai-mcp.cjs", buildMcpEnv());
      const server = cfg.mcpServers[MCP_SERVER_NAME] as {
        command: string;
        args: string[];
        env: Record<string, string>;
      };
      assert.equal(server.command, "node");
      assert.deepEqual(server.args, ["/bin/seerai-mcp.cjs"]);
      assert.equal(server.env.SEERAI_MCP_TOOL_PROFILE, "research");
    });

    it("builds Codex -c overrides and opens localhost network", function () {
      const args = buildCodexMcpArgs("/bin/seerai-mcp.cjs", buildMcpEnv());
      const joined = args.join(" ");
      assert.include(joined, `mcp_servers.${MCP_SERVER_NAME}.command="node"`);
      assert.include(
        joined,
        `mcp_servers.${MCP_SERVER_NAME}.args=["/bin/seerai-mcp.cjs"]`,
      );
      assert.include(joined, "sandbox_workspace_write.network_access=true");
      // every value is preceded by its own -c flag
      assert.equal(args.filter((a) => a === "-c").length, 4);
    });

    it("registers MCP for Claude/Codex only (not the tool-less harnesses)", function () {
      assert.isFunction(getCliAgent("claude")?.registerMcp);
      assert.isFunction(getCliAgent("codex")?.registerMcp);
      assert.isUndefined(getCliAgent("hermes")?.registerMcp);
      assert.isUndefined(getCliAgent("antigravity")?.registerMcp);
      assert.isUndefined(getCliAgent("openclaw")?.registerMcp);
    });
  });

  describe("MCP server research profile", function () {
    it("exposes only research tools, hiding file/bash/workspace/task tools", function () {
      const filtered = filterToolsByProfile(TOOL_DEFINITIONS, "research");
      const names = filtered.map((t) => t.name).sort();
      assert.deepEqual(names, [...RESEARCH_TOOL_NAMES].sort());
      for (const hidden of [
        "terminal",
        "execute_code",
        "workspace_bash",
        "workspace_write_file",
        "todowrite",
        "skill_view",
      ]) {
        assert.notInclude(names, hidden, `${hidden} must be suppressed`);
      }
    });

    it("returns all tools when no/!research profile is set", function () {
      assert.equal(
        filterToolsByProfile(TOOL_DEFINITIONS, undefined).length,
        TOOL_DEFINITIONS.length,
      );
      assert.equal(
        filterToolsByProfile(TOOL_DEFINITIONS, "all").length,
        TOOL_DEFINITIONS.length,
      );
    });
  });

  describe("CLI harness MCP guidance (prompt)", function () {
    it("connected → generic MCP guidance, no bare-name tool catalog", function () {
      const g = buildCliAgentInstructions(true);
      assert.include(g, "seerai-zotero");
      assert.include(g, "MCP");
      // must NOT teach bare callable names like search_library({...})
      assert.notInclude(g, "search_library(");
      assert.notInclude(g, "table({ action");
    });

    it("not connected → tells the model it has no Zotero tools", function () {
      const g = buildCliAgentInstructions(false);
      assert.match(g, /not connected|NOT connected/);
      assert.match(g, /do not (claim|invent)/i);
    });
  });

  describe("MCP config merge (applyMcpServerEntry)", function () {
    const inv = { command: "/bin/sh", args: ["/x/launch.sh"] };

    it("adds seerai-zotero while preserving existing servers", function () {
      const cfg: Record<string, unknown> = {
        mcpServers: { github: { command: "npx" } },
        other: 1,
      };
      applyMcpServerEntry(cfg, inv, true);
      const servers = cfg.mcpServers as Record<string, unknown>;
      assert.deepEqual(servers[MCP_SERVER_NAME], {
        command: "/bin/sh",
        args: ["/x/launch.sh"],
      });
      assert.isDefined(servers.github); // untouched
      assert.equal(cfg.other, 1);
    });

    it("removes only seerai-zotero on disconnect", function () {
      const cfg: Record<string, unknown> = {
        mcpServers: {
          github: { command: "npx" },
          [MCP_SERVER_NAME]: { command: "/bin/sh" },
        },
      };
      applyMcpServerEntry(cfg, null, false);
      const servers = cfg.mcpServers as Record<string, unknown>;
      assert.isUndefined(servers[MCP_SERVER_NAME]);
      assert.isDefined(servers.github);
    });

    it("creates mcpServers when the config is empty", function () {
      const cfg: Record<string, unknown> = {};
      applyMcpServerEntry(cfg, inv, true);
      assert.isDefined(
        (cfg.mcpServers as Record<string, unknown>)[MCP_SERVER_NAME],
      );
    });
  });

  describe("harness connected state", function () {
    it("treats Claude/Codex as auto-connected", function () {
      assert.isTrue(isHarnessConnected("claude"));
      assert.isTrue(isHarnessConnected("codex"));
    });

    it("treats persistent-config harnesses as disconnected by default", function () {
      assert.isFalse(isHarnessConnected("hermes"));
      assert.isFalse(isHarnessConnected("antigravity"));
      assert.isFalse(isHarnessConnected("openclaw"));
    });
  });
});
