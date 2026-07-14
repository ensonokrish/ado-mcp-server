import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveClient } from "./connect.js";
import { scrubToolResponse, logAudit, escapeWiql, validateWiqlSelect } from "../security/index.js";
import { getAreaPath } from "../config/index.js";
import { getDetectedProductTags } from "../intelligence/index.js";

function requireClient() {
  const client = getActiveClient();
  if (!client) {
    throw new Error("Not connected. Call 'connect' first.");
  }
  return client;
}

export function registerQueryTools(server: McpServer): void {
  /**
   * Run a WIQL query.
   */
  server.tool(
    "query_work_items",
    "Run a WIQL (Work Item Query Language) query to find work items. Returns matching IDs with basic fields.",
    {
      wiql: z
        .string()
        .describe(
          "WIQL query string. Example: SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC"
        ),
      project: z.string().optional().describe("Project name (uses default if not specified)"),
      top: z.number().optional().describe("Maximum number of results (default: 50)"),
      fetch_details: z
        .boolean()
        .optional()
        .describe("If true, fetches full details for each returned work item (slower for large result sets)"),
    },
    async ({ wiql, project, top, fetch_details }) => {
      const client = requireClient();

      // Validate WIQL is a read-only query
      if (!validateWiqlSelect(wiql)) {
        return {
          content: [{ type: "text" as const, text: "Invalid WIQL: query must start with SELECT." }],
        };
      }

      try {
        const result = await client.queryByWiql(wiql, project, top || 50);

        if (result.workItems.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No work items found matching the query." }],
          };
        }

        // If fetch_details, get full work item data
        if (fetch_details && result.workItems.length > 0) {
          const ids = result.workItems.map((wi) => wi.id).slice(0, 200);
          const items = await client.getWorkItems(ids, project, [
            "System.Id",
            "System.Title",
            "System.State",
            "System.AssignedTo",
            "System.WorkItemType",
            "System.IterationPath",
            "Microsoft.VSTS.Common.Priority",
            "System.Tags",
          ]);

          const lines = items.map((wi) => {
            const f = wi.fields;
            const assignee =
              (f["System.AssignedTo"] as { displayName?: string })?.displayName ||
              "Unassigned";
            return `  [${wi.id}] ${f["System.WorkItemType"]} | ${f["System.State"]} | ${f["System.Title"]} | ${assignee}`;
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${result.workItems.length} work items:\n\n${lines.join("\n")}`,
              },
            ],
          };
        }

        // Otherwise just return IDs
        const idList = result.workItems.map((wi) => wi.id).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${result.workItems.length} work items.\nIDs: ${idList}\n\nUse get_work_item to view details, or re-run with fetch_details=true.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Query error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Shortcut: get my open work items.
   */
  server.tool(
    "my_work_items",
    "Get work items assigned to the current user. IMPORTANT: Before fetching, ask the user which type they want to see (e.g., 'User Story', 'Product Backlog Item', 'Feature', 'Epic', 'Task', 'Bug', or 'all'). Pass the chosen type in the 'type' parameter (omit for all).",
    {
      project: z.string().optional().describe("Project name (uses default if not specified)"),
      state: z
        .string()
        .optional()
        .describe("Filter by state (e.g., 'Active', 'New'). Omit for all non-closed items."),
      type: z
        .string()
        .optional()
        .describe("Filter by work item type (e.g., 'User Story', 'Product Backlog Item', 'Feature', 'Epic', 'Task', 'Bug'). Omit for all types."),
      top: z.number().optional().describe("Maximum results (default: 50)"),
    },
    async ({ project, state, type, top }) => {
      const client = requireClient();

      let wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [Microsoft.VSTS.Common.Priority] FROM WorkItems WHERE [System.AssignedTo] = @Me`;

      if (state) {
        wiql += ` AND [System.State] = '${escapeWiql(state)}'`;
      } else {
        wiql += ` AND [System.State] <> 'Closed' AND [System.State] <> 'Removed'`;
      }

      if (type) {
        wiql += ` AND [System.WorkItemType] = '${escapeWiql(type)}'`;
      }

      wiql += ` ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC`;

      try {
        const result = await client.queryByWiql(wiql, project, top || 50);

        if (result.workItems.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No work items assigned to you matching the criteria." }],
          };
        }

        const ids = result.workItems.map((wi) => wi.id).slice(0, 200);
        const items = await client.getWorkItems(ids, project, [
          "System.Id",
          "System.Title",
          "System.State",
          "System.WorkItemType",
          "System.IterationPath",
          "Microsoft.VSTS.Common.Priority",
          "System.Tags",
        ]);

        // Group by detected product tags (dynamic), with "Other" as fallback
        const detectedTags = getDetectedProductTags().slice(0, 10);
        const groups: Record<string, typeof items> = {};
        if (detectedTags.length > 0) {
          for (const tag of detectedTags) {
            groups[tag] = [];
          }
        }
        groups["Other"] = [];

        for (const wi of items) {
          const tags = (wi.fields["System.Tags"] as string) || "";
          let matched = false;
          for (const tag of detectedTags) {
            if (tags.includes(tag)) {
              groups[tag].push(wi);
              matched = true;
              break;
            }
          }
          if (!matched) {
            groups["Other"].push(wi);
          }
        }

        const sections: string[] = [];
        for (const [group, groupItems] of Object.entries(groups)) {
          if (groupItems.length === 0) continue;
          const stateCount: Record<string, number> = {};
          for (const wi of groupItems) {
            const s = (wi.fields["System.State"] as string) || "Unknown";
            stateCount[s] = (stateCount[s] || 0) + 1;
          }
          const stateSummary = Object.entries(stateCount)
            .map(([s, c]) => `${c} ${s}`)
            .join(", ");

          const lines = groupItems.map((wi) => {
            const f = wi.fields;
            const priority = f["Microsoft.VSTS.Common.Priority"] || "-";
            return `  [${wi.id}] P${priority} | ${f["System.WorkItemType"]} | ${f["System.State"]} | ${f["System.Title"]}`;
          });

          sections.push(`=== ${group} (${stateSummary}) ===\n${lines.join("\n")}`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Your work items (${items.length}):\n\n${sections.join("\n\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Get iterations/sprints.
   */
  server.tool(
    "get_iterations",
    "List iterations (sprints) for a project team.",
    {
      project: z.string().optional().describe("Project name (uses default if not specified)"),
      team: z.string().optional().describe("Team name (uses default team if not specified)"),
    },
    async ({ project, team }) => {
      const client = requireClient();
      try {
        const iterations = await client.getIterations(project, team);
        const lines = iterations.map((it) => {
          const attrs = it.attributes as {
            startDate?: string;
            finishDate?: string;
            timeFrame?: string;
          } | null;
          const timeFrame = attrs?.timeFrame || "";
          const dates =
            attrs?.startDate && attrs?.finishDate
              ? ` (${attrs.startDate.split("T")[0]} → ${attrs.finishDate.split("T")[0]})`
              : "";
          return `  - ${it.name}${dates} [${timeFrame}]`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Iterations:\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * List active features and epics from the board (dynamic).
   */
  server.tool(
    "list_features",
    "Dynamically fetch active Epics and Features from the project board. Use this to find the correct parent_id when creating work items.",
    {
      type: z
        .enum(["Feature", "Epic", "both"])
        .optional()
        .describe("Filter by type. Default: both"),
      project: z.string().optional().describe("Project name (uses default if not specified)"),
    },
    async ({ type, project }) => {
      const client = requireClient();
      const typeFilter = type || "both";

      let typeClause = "";
      if (typeFilter === "Feature") {
        typeClause = "AND [System.WorkItemType] = 'Feature'";
      } else if (typeFilter === "Epic") {
        typeClause = "AND [System.WorkItemType] = 'Epic'";
      } else {
        typeClause = "AND ([System.WorkItemType] = 'Feature' OR [System.WorkItemType] = 'Epic')";
      }

      const areaPath = getAreaPath();
      const areaFilter = areaPath
        ? `[System.AreaPath] UNDER '${escapeWiql(areaPath)}'`
        : `[System.TeamProject] = '${escapeWiql(project || "")}'`;

      const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType] FROM WorkItems WHERE ${areaFilter} ${typeClause} AND [System.State] <> 'Closed' AND [System.State] <> 'Removed' ORDER BY [System.WorkItemType] DESC, [System.Title] ASC`;

      try {
        const result = await client.queryByWiql(wiql, project, 100);
        if (result.workItems.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No active features/epics found." }],
          };
        }

        const ids = result.workItems.map((wi) => wi.id);
        const items = await client.getWorkItems(ids, project, [
          "System.Id",
          "System.Title",
          "System.State",
          "System.WorkItemType",
        ]);

        const lines = items.map((wi) => {
          const f = wi.fields;
          return `  [${wi.id}] ${f["System.WorkItemType"]} | ${f["System.State"]} | ${f["System.Title"]}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Active Epics & Features (${items.length}):\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
