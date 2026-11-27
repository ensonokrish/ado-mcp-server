import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GithubWork } from "./api/github-work.js";

const positive = z.number().int().positive().safe();
export function createGithubServer(createWork = () => new GithubWork()): McpServer {
  const server = new McpServer({ name: "github-session-ticketing", version: "1.0.0" });
  const shape = {
  action: z.enum(["session", "list_projects", "get_project", "list_project_items", "validate_project_field", "list_issues", "search_issues", "get_issue", "list_comments", "list_assignees", "list_labels", "list_milestones", "list_issue_types", "create_issue", "update_issue", "add_comment", "add_to_project", "remove_from_project", "move_project", "set_project_field", "set_parent", "remove_parent", "link_issue", "link_pr"]),
  owner: z.string().optional(), repo: z.string().optional(), issue_number: positive.optional(),
  project_number: positive.optional(), source_project_number: positive.optional(),
  title: z.string().optional(), body: z.string().optional(), labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(), state: z.enum(["open", "closed"]).optional(),
  state_reason: z.enum(["completed", "not_planned", "reopened"]).optional(),
  milestone_number: positive.nullable().optional(), issue_type: z.string().optional(),
  parent_issue_number: positive.optional(), related_url: z.string().optional(),
  field_name: z.string().optional(), field_value: z.union([z.string(), z.number(), z.null()]).optional(),
  query: z.string().optional(), limit: positive.max(100).optional(), request_key: z.string().optional(),
  };
  const schema = z.object(shape).strict();
  const execute = async (input: z.infer<typeof schema>) => {
  try {
    const result = await createWork().execute(input);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
  } catch (error) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, ...(input.action === "create_issue" ? { data: { mutation_attempted: false } } : {}), error: error instanceof Error ? error.message : "GitHub operation failed." }) }], isError: true };
  }
  };
  server.tool("github_work", "Manage allowlisted GitHub issues and Projects using the authenticated gh session.", shape, execute);
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== "github_work") {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Unknown tool." }) }], isError: true };
    }
    const parsed = schema.safeParse(request.params.arguments);
    if (!parsed.success) {
      const creating = request.params.arguments?.action === "create_issue";
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, ...(creating ? { data: { mutation_attempted: false } } : {}), error: "Invalid github_work arguments." }) }], isError: true };
    }
    return execute(parsed.data);
  });
  return server;
}

if (require.main === module) {
  createGithubServer().connect(new StdioServerTransport()).catch(() => {
    console.error("Could not start GitHub session server.");
    process.exitCode = 1;
  });
}
