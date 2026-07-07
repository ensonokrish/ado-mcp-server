import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectTools } from "./tools/connect.js";
import { registerWorkItemTools } from "./tools/work-items.js";
import { registerQueryTools } from "./tools/queries.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "ado-mcp-server",
    version: "1.0.0",
  });

  // Register all tool groups
  registerConnectTools(server);
  registerWorkItemTools(server);
  registerQueryTools(server);

  return server;
}
