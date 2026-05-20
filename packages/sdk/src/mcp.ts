#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentHubControlClient, type AgentHubControlConfig } from "./index.js";
import { buildControlConfig } from "./cli.js";
import { createAgentHubMcpTools, type AgentHubMcpTool } from "./mcp-tools.js";

export interface AgentHubMcpServerLike {
  registerTool(
    name: string,
    config: {
      description: string;
      inputSchema: AgentHubMcpTool["inputSchema"];
    },
    handler: AgentHubMcpTool["handler"],
  ): unknown;
}

export function registerAgentHubMcpTools(
  server: AgentHubMcpServerLike,
  tools: AgentHubMcpTool[],
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      tool.handler,
    );
  }
}

export function createAgentHubMcpServer(config: AgentHubControlConfig = buildControlConfig()): McpServer {
  const server = new McpServer({
    name: "agent-hub",
    version: "0.1.0",
  });
  const client = new AgentHubControlClient(config);
  registerAgentHubMcpTools(server as unknown as AgentHubMcpServerLike, createAgentHubMcpTools(client));
  return server;
}

export async function runMcpServer(config: AgentHubControlConfig = buildControlConfig()): Promise<void> {
  const server = createAgentHubMcpServer(config);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runMcpServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
