import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveClient } from "./connect.js";
import { scrubToolResponse, logAudit } from "../security/index.js";
import { spellCheck, isCacheLoaded, suggestFeatureFromCache, suggestAssigneeFromCache, suggestProductTag, findDuplicates } from "../intelligence/index.js";
import { getProductTags, loadConfig } from "../config/index.js";

function requireClient() {
  const client = getActiveClient();
  if (!client) {
    throw new Error("Not connected. Call 'connect' first.");
  }
  return client;
}

function formatWorkItem(wi: { id: number; fields: Record<string, unknown> }): string {
  const f = wi.fields;
  const lines = [
    `ID: ${wi.id}`,
    `Title: ${f["System.Title"] || "(untitled)"}`,
    `Type: ${f["System.WorkItemType"] || "Unknown"}`,
    `State: ${f["System.State"] || "Unknown"}`,
    `Assigned To: ${(f["System.AssignedTo"] as { displayName?: string })?.displayName || "Unassigned"}`,
    `Area Path: ${f["System.AreaPath"] || ""}`,
    `Iteration Path: ${f["System.IterationPath"] || ""}`,
    `Created: ${f["System.CreatedDate"] || ""}`,
    `Changed: ${f["System.ChangedDate"] || ""}`,
  ];

  if (f["System.Description"]) {
    // Scrub description for potential injection patterns
    const { text } = scrubToolResponse(String(f["System.Description"]));
    lines.push(`Description: ${text}`);
  }

  return lines.join("\n");
}

export function registerWorkItemTools(server: McpServer): void {
  /**
   * Get a work item by ID.
   */
  server.tool(
    "get_work_item",
    "Get details of a work item by its ID.",
    {
      id: z.number().describe("Work item ID"),
      project: z.string().optional().describe("Project name (uses default if not specified)"),
      expand: z
        .enum(["all", "fields", "relations", "none"])
        .optional()
        .describe("Level of detail to return"),
    },
    async ({ id, project, expand }) => {
      const startTime = Date.now();
      const client = requireClient();
      try {
        const wi = await client.getWorkItem(id, project, expand);
        logAudit({
          timestamp: new Date().toISOString(),
          tool: "get_work_item",
          arguments: { id, project, expand },
          success: true,
          durationMs: Date.now() - startTime,
        });
        return {
          content: [{ type: "text" as const, text: formatWorkItem(wi) }],
        };
      } catch (err) {
        logAudit({
          timestamp: new Date().toISOString(),
          tool: "get_work_item",
          arguments: { id, project, expand },
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startTime,
        });
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
   * Create a work item.
   */
  server.tool(
    "create_work_item",
    "Create a new work item (Task, Bug, User Story, Epic, etc.).",
    {
      type: z.string().describe("Work item type (e.g., 'Task', 'Bug', 'User Story', 'Epic', 'Engineering Story')"),
      title: z.string().describe("Title of the work item"),
      project: z.string().optional().describe("Project name (uses default if not specified)"),
      description: z.string().optional().describe("Description/details (HTML supported)"),
      acceptance_criteria: z.string().optional().describe("Acceptance criteria (HTML supported)"),
      product_name: z.string().optional().describe("Product name (custom required field, e.g., 'Active Disclosure', 'GAIL', 'Saturn')"),
      requestor: z.string().optional().describe("Requestor (custom required field, e.g., 'SRE', 'Engineering')"),
      assigned_to: z.string().optional().describe("Assign to this person (email or display name)"),
      area_path: z.string().optional().describe("Area path"),
      iteration_path: z.string().optional().describe("Iteration/sprint path"),
      state: z.string().optional().describe("Initial state (e.g., 'New', 'Active')"),
      priority: z.number().optional().describe("Priority (1-4)"),
      tags: z.string().optional().describe("Semicolon-separated tags"),
      parent_id: z.number().optional().describe("Parent work item ID to link to"),
    },
    async ({
      type,
      title,
      project,
      description,
      acceptance_criteria,
      product_name,
      requestor,
      assigned_to,
      area_path,
      iteration_path,
      state,
      priority,
      tags,
      parent_id,
    }) => {
      const client = requireClient();

      // Spell-check title and description
      const titleCheck = spellCheck(title);
      const checkedTitle = titleCheck.corrected;
      let spellNote = "";
      if (titleCheck.corrections.length > 0) {
        spellNote = `\n\n[Auto-corrected: ${titleCheck.corrections.map((c) => `"${c.from}" → "${c.to}"`).join(", ")}]`;
      }

      const fields: Record<string, unknown> = {
        "System.Title": checkedTitle,
      };

      if (description) fields["System.Description"] = description;
      if (acceptance_criteria) fields["Microsoft.VSTS.Common.AcceptanceCriteria"] = acceptance_criteria;
      if (product_name) fields["Custom.ProductName"] = product_name;
      if (requestor) fields["Custom.Requestor"] = requestor;
      if (assigned_to) fields["System.AssignedTo"] = assigned_to;
      if (area_path) fields["System.AreaPath"] = area_path;
      if (iteration_path) fields["System.IterationPath"] = iteration_path;
      if (state) fields["System.State"] = state;
      if (priority) fields["Microsoft.VSTS.Common.Priority"] = priority;
      if (tags) fields["System.Tags"] = tags;

      try {
        // Validate required fields for Engineering Story
        if (type === "Engineering Story") {
          const missing: string[] = [];
          if (!assigned_to) missing.push("assigned_to — Who will work on this? (e.g., 'Srinath Ekbote', 'Hina Ayub', 'Krishnendu Sur')");
          if (!requestor) missing.push("requestor — Who is requesting this work? (e.g., 'Srinath Ekbote', 'Mohammad Rasheedi')");
          if (!product_name) missing.push(`product_name — Which product? (e.g., '${loadConfig()?.required_fields?.product_name || "your product"}')`);

          // Validate product tag is present in tags
          const validProductTags = getProductTags();
          const hasProductTag = validProductTags.length === 0 || (tags && validProductTags.some((t) => tags.includes(t)));
          if (!hasProductTag) {
            missing.push(`product tag — Which board swimlane? Must include one of: ${validProductTags.map((t) => `'${t}'`).join(", ")} in tags`);
          }

          if (missing.length > 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Missing required fields for Engineering Story:\n\n${missing.map((m, i) => `  ${i + 1}. ${m}`).join("\n")}\n\nPlease provide these values to create the work item.`,
                },
              ],
            };
          }
        }

        const startTime = Date.now();
        const wi = await client.createWorkItem(type, fields, project, parent_id);

        logAudit({
          timestamp: new Date().toISOString(),
          tool: "create_work_item",
          arguments: { type, title, project, assigned_to, tags, parent_id },
          success: true,
          durationMs: Date.now() - startTime,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Work item created successfully!${spellNote}\n\n${formatWorkItem(wi)}${parent_id ? `\n\nLinked to parent: ${parent_id}` : ""}\n\nURL: ${wi.url}`,
            },
          ],
        };
      } catch (err) {
        logAudit({
          timestamp: new Date().toISOString(),
          tool: "create_work_item",
          arguments: { type, title, project, assigned_to, tags, parent_id },
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - Date.now(),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Error creating work item: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Update a work item.
   */
  server.tool(
    "update_work_item",
    "Update fields on an existing work item.",
    {
      id: z.number().describe("Work item ID to update"),
      project: z.string().optional().describe("Project name (uses default if not specified)"),
      title: z.string().optional().describe("New title"),
      state: z.string().optional().describe("New state (e.g., 'Active', 'Closed', 'Resolved')"),
      assigned_to: z.string().optional().describe("New assignee"),
      description: z.string().optional().describe("New description"),
      priority: z.number().optional().describe("New priority (1-4)"),
      iteration_path: z.string().optional().describe("New iteration path"),
      area_path: z.string().optional().describe("New area path"),
      tags: z.string().optional().describe("New tags (semicolon-separated)"),
      comment: z.string().optional().describe("Add a discussion comment"),
    },
    async ({
      id,
      project,
      title,
      state,
      assigned_to,
      description,
      priority,
      iteration_path,
      area_path,
      tags,
      comment,
    }) => {
      const client = requireClient();
      const fields: Record<string, unknown> = {};

      if (title) fields["System.Title"] = title;
      if (state) fields["System.State"] = state;
      if (assigned_to) fields["System.AssignedTo"] = assigned_to;
      if (description) fields["System.Description"] = description;
      if (priority) fields["Microsoft.VSTS.Common.Priority"] = priority;
      if (iteration_path) fields["System.IterationPath"] = iteration_path;
      if (area_path) fields["System.AreaPath"] = area_path;
      if (tags) fields["System.Tags"] = tags;
      if (comment) fields["System.History"] = comment;

      if (Object.keys(fields).length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No fields to update. Provide at least one field." },
          ],
        };
      }

      try {
        const wi = await client.updateWorkItem(id, fields, project);
        return {
          content: [
            {
              type: "text" as const,
              text: `Work item ${id} updated successfully!\n\n${formatWorkItem(wi)}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error updating work item: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Get available work item types.
   */
  server.tool(
    "get_work_item_types",
    "List available work item types for a project.",
    {
      project: z.string().optional().describe("Project name (uses default if not specified)"),
    },
    async ({ project }) => {
      const client = requireClient();
      try {
        const types = await client.getWorkItemTypes(project);
        const lines = types.map((t) => `  - ${t.name}: ${t.description || "(no description)"}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Work item types:\n${lines.join("\n")}`,
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
   * Suggest defaults for a new work item based on historical patterns.
   */
  server.tool(
    "suggest_defaults",
    "Analyze a work item title and suggest: parent feature, assignee, product tag, and check for duplicates. Use before creating items.",
    {
      title: z.string().describe("The proposed title for the work item"),
      project: z.string().optional().describe("Project name (uses default if not specified)"),
    },
    async ({ title, project }) => {
      const client = requireClient();

      // Spell-check first
      const titleCheck = spellCheck(title);
      const correctedTitle = titleCheck.corrected;

      const lines: string[] = [];

      if (titleCheck.corrections.length > 0) {
        lines.push(`Spell corrections: ${titleCheck.corrections.map((c) => `"${c.from}" → "${c.to}"`).join(", ")}`);
        lines.push(`Corrected title: ${correctedTitle}`);
        lines.push("");
      }

      // Use cache-based intelligence if available, fallback to static patterns
      if (isCacheLoaded()) {
        lines.push("[Using live board data for suggestions]");
        lines.push("");

        const feature = suggestFeatureFromCache(correctedTitle);
        if (feature) {
          lines.push(`Suggested parent: [${feature.id}] ${feature.name} (confidence: ${feature.confidence})`);
        } else {
          lines.push("Suggested parent: No match found — please specify manually");
        }

        const assignee = suggestAssigneeFromCache(correctedTitle);
        if (assignee) {
          lines.push(`Suggested assignee: ${assignee.name} (${assignee.reason})`);
        }
      } else {
        lines.push("[No historical data — run 'connect' first to load live intelligence]");
        lines.push("");
        lines.push("Suggested parent: Connect first to enable feature matching");
        lines.push("Suggested assignee: Connect first to enable assignee matching");
      }

      const tag = suggestProductTag(correctedTitle);
      if (tag) {
        lines.push(`Suggested tag: ${tag}`);
      }

      // Always check duplicates live
      const dupes = await findDuplicates(client, correctedTitle, project);
      if (dupes.length > 0) {
        lines.push("");
        lines.push("Potential duplicates found:");
        for (const d of dupes) {
          lines.push(`  [${d.id}] ${d.title} (${d.state})`);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: lines.length > 0 ? lines.join("\n") : "No suggestions available for this title.",
          },
        ],
      };
    }
  );
}
