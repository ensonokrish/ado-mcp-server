import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdoClient } from "../api/ado-client.js";
import {
  saveProfile,
  getProfile,
  listProfiles,
  deleteProfile,
} from "../auth/credentials.js";
import { loadHistoricalData, getDetectedProductTags, getDetectedIteration } from "../intelligence/index.js";
import { getAreaPath, setActiveOrg, clearConfigCache, detectStoryType, getStoryType } from "../config/index.js";

/** In-memory session state */
let activeClient: AdoClient | null = null;
let activeProfileName: string | null = null;
let activeOrg: string | null = null;
let activeProject: string | null = null;

export function getActiveClient(): AdoClient | null {
  return activeClient;
}

export function getActiveContext(): {
  org: string | null;
  project: string | null;
  profile: string | null;
} {
  return { org: activeOrg, project: activeProject, profile: activeProfileName };
}

export function registerConnectTools(server: McpServer): void {
  /**
   * Connect to ADO using a saved profile or explicit credentials.
   */
  server.tool(
    "connect",
    "Connect to Azure DevOps. Provide a saved profile_name OR explicit organization + pat. Validates credentials and lists available projects.",
    {
      profile_name: z
        .string()
        .optional()
        .describe("Saved profile name (loads credentials from keychain)"),
      organization: z
        .string()
        .optional()
        .describe("ADO organization name (e.g., 'DFIN')"),
      pat: z
        .string()
        .optional()
        .describe("Personal Access Token for ADO"),
      project: z
        .string()
        .optional()
        .describe("Default project to use for operations"),
      save_as: z
        .string()
        .optional()
        .describe("Save these credentials as a named profile for future use"),
    },
    async ({ profile_name, organization, pat, project, save_as }) => {
      let org: string;
      let token: string;
      let defaultProject: string | undefined = project;

      if (profile_name) {
        const stored = await getProfile(profile_name);
        if (!stored) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Profile '${profile_name}' not found. Use list_profiles to see available profiles.`,
              },
            ],
          };
        }
        org = stored.profile.organization;
        token = stored.pat;
        defaultProject = project || stored.profile.defaultProject;
        activeProfileName = profile_name;
      } else if (organization && pat) {
        org = organization;
        token = pat;
      } else {
        return {
          content: [
            {
              type: "text" as const,
              text: "Provide either a profile_name OR organization + pat to connect.",
            },
          ],
        };
      }

      const client = new AdoClient({
        organization: org,
        pat: token,
        defaultProject,
      });

      // Validate connection
      let projects: { name: string; id: string }[];
      try {
        projects = await client.validateConnection();
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      // Save profile if requested
      if (save_as) {
        await saveProfile(save_as, org, token, defaultProject);
        activeProfileName = save_as;
      }

      // Set session state
      activeClient = client;
      activeOrg = org;
      activeProject = defaultProject || null;

      // Tell config module which org we connected to so it can
      // skip defaults.json when the org doesn't match.
      clearConfigCache();
      setActiveOrg(org);

      // Detect the story-level work item type for this project
      if (defaultProject) {
        try {
          const types = await client.getWorkItemTypes(defaultProject);
          await detectStoryType(types);
        } catch {
          // Non-critical — falls back to 'User Story'
        }
      }

      // Load historical data for intelligence
      let historyStatus = "";
      if (defaultProject) {
        const result = await loadHistoricalData(client, defaultProject);
        historyStatus = `\n  Intelligence: ${result}`;
      }

      // Load board context (historical data)
      let boardContext = "";
      const configAreaPath = getAreaPath() || defaultProject;
      if (defaultProject && configAreaPath) {
        try {
          const areaPath = configAreaPath;

          // Get board column counts — query by State (universal) rather than BoardColumn (process-specific)
          const columns = ["New", "Active", "Resolved", "Closed"];
          const counts: Record<string, number> = {};
          for (const col of columns) {
            const stateFilter = col === "Closed"
              ? `[System.State] IN ('Closed', 'Done') AND [Microsoft.VSTS.Common.ClosedDate] >= '${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]}'`
              : col === "New"
              ? `[System.State] IN ('New', 'Approved')`
              : col === "Active"
              ? `[System.State] IN ('Active', 'Committed', 'In Progress')`
              : `[System.State] IN ('Resolved', 'In Review')`;
            const fullFilter = `${stateFilter} AND [System.State] <> 'Removed'`;
            const result = await client.queryByWiql(
              `SELECT [System.Id] FROM WorkItems WHERE [System.AreaPath] UNDER '${areaPath}' AND [System.WorkItemType] = '${getStoryType()}' AND ${fullFilter}`,
              defaultProject,
              200
            );
            counts[col] = result.workItems.length;
          }

          // Get active team members (who has items assigned)
          const activeItems = await client.queryByWiql(
            `SELECT [System.Id], [System.AssignedTo] FROM WorkItems WHERE [System.AreaPath] UNDER '${areaPath}' AND [System.WorkItemType] = '${getStoryType()}' AND [System.State] <> 'Closed' AND [System.State] <> 'Removed' AND [System.AssignedTo] <> ''`,
            defaultProject,
            200
          );

          const boardName = defaultProject;
          boardContext = `\n\nBoard snapshot (${boardName}):\n  New: ${counts["New"]} | Active: ${counts["Active"]} | Resolved: ${counts["Resolved"]} | Closed (30d): ${counts["Closed"]}\n  Open items: ${activeItems.workItems.length}`;
        } catch {
          // Non-critical — don't fail connection
        }
      }

      // Build detection summary
      const detectedIter = getDetectedIteration();
      const detectedTags = getDetectedProductTags();
      let detectionInfo = `\n  Story type: ${getStoryType()}`;
      if (detectedIter) {
        detectionInfo += `\n  Current sprint: ${detectedIter.name}`;
      }
      if (detectedTags.length > 0) {
        detectionInfo += `\n  Top tags: ${detectedTags.slice(0, 8).join(", ")}`;
      }

      const projectList = projects.map((p) => `  - ${p.name}`).join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `Connected to Azure DevOps organization: ${org}\nDefault project: ${defaultProject || "(none)"}\n\nAvailable projects:\n${projectList}${boardContext}${historyStatus}${detectionInfo}`,
          },
        ],
      };
    }
  );

  /**
   * List saved profiles.
   */
  server.tool(
    "list_profiles",
    "List all saved Azure DevOps connection profiles.",
    {},
    async () => {
      const profiles = await listProfiles();

      if (profiles.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No saved profiles. Use connect with save_as to create one.",
            },
          ],
        };
      }

      const lines = profiles.map(
        (p) =>
          `  - ${p.name} (org: ${p.organization}${p.defaultProject ? `, project: ${p.defaultProject}` : ""})`
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Saved profiles:\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );

  /**
   * Delete a saved profile.
   */
  server.tool(
    "delete_profile",
    "Delete a saved Azure DevOps connection profile from the keychain.",
    {
      profile_name: z.string().describe("Profile name to delete"),
    },
    async ({ profile_name }) => {
      const deleted = await deleteProfile(profile_name);
      return {
        content: [
          {
            type: "text" as const,
            text: deleted
              ? `Profile '${profile_name}' deleted.`
              : `Profile '${profile_name}' not found.`,
          },
        ],
      };
    }
  );

  /**
   * Disconnect / clear session.
   */
  server.tool(
    "disconnect",
    "Disconnect from the current Azure DevOps session.",
    {},
    async () => {
      activeClient = null;
      activeOrg = null;
      activeProject = null;
      activeProfileName = null;
      return {
        content: [{ type: "text" as const, text: "Disconnected." }],
      };
    }
  );
}
