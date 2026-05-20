import { describe, expect, test, vi } from "vitest";
import { registerAgentHubMcpTools } from "./mcp";

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
});
