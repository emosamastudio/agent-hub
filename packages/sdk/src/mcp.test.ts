import { describe, expect, test, vi } from "vitest";
import { registerAgentHubMcpTools } from "./mcp";
import { createAgentHubMcpTools } from "./mcp-tools";

describe("Agent Hub MCP server wiring", () => {
  test("registers all Agent Hub tools with the MCP server", () => {
    const registerTool = vi.fn();
    const server = { registerTool };
    const handler = vi.fn();

    registerAgentHubMcpTools(server as any, [
      {
        name: "agent_hub_health",
        description: "health",
        inputSchema: {},
        handler,
      },
      {
        name: "agent_hub_trigger_agent",
        description: "trigger",
        inputSchema: {},
        handler,
      },
    ]);

    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(registerTool).toHaveBeenNthCalledWith(
      1,
      "agent_hub_health",
      { description: "health", inputSchema: {} },
      handler,
    );
    expect(registerTool).toHaveBeenNthCalledWith(
      2,
      "agent_hub_trigger_agent",
      { description: "trigger", inputSchema: {} },
      handler,
    );
  });

  test("exposes doctor diagnostics as an MCP tool", async () => {
    const client = {
      doctor: vi.fn(async () => ({ ok: true })),
    };

    const tools = createAgentHubMcpTools(client as any);
    const tool = tools.find((candidate) => candidate.name === "agent_hub_doctor");

    expect(tool).toBeTruthy();
    expect(tool?.description).toContain("diagnostics");
    expect(tool?.inputSchema).toHaveProperty("project");

    await expect(tool?.handler({ project: "oph" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true }, null, 2),
        },
      ],
    });
    expect(client.doctor).toHaveBeenCalledWith({ project: "oph" });
  });
});
