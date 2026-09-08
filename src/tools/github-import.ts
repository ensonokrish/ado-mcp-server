import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GithubClient, GithubIssue } from "../api/github-client.js";
import { saveGithubToken, getGithubToken } from "../auth/credentials.js";
import { getActiveClient } from "./connect.js";
let githubClient: GithubClient | null = null;

function getGithubClient(): GithubClient {
  if (!githubClient) throw new Error("Not connected to GitHub. Call connect_github first.");
  return githubClient;
}

/** Convert a GitHub issue into a plain description string for ADO. */
function buildDescription(issue: GithubIssue, sourceUrl: string): string {
  const body = issue.body?.trim() ?? "";
  const lines: string[] = [
    `<div><p><em>Imported from GitHub: <a href="${sourceUrl}">${sourceUrl}</a></em></p>`,
    `<p>Opened by <strong>${issue.user.login}</strong> on ${issue.created_at.slice(0, 10)}</p>`,
  ];
  if (body) lines.push(`<hr/><div>${body.replace(/\n/g, "<br/>")}</div>`);
  lines.push("</div>");
  return lines.join("");
}

export function registerGithubTools(server: McpServer): void {
  /**
   * Authenticate against GitHub using a PAT and cache for this session.
   */
  server.tool(
    "connect_github",
    "Connect to GitHub using a Personal Access Token (PAT). Token is saved to the system keychain. Required before using any github_ tools.",
    {
      token: z.string().optional().describe("GitHub PAT (classic or fine-grained with Issues: Read and Projects: Read). If omitted, loads from keychain."),
    },
    async ({ token }) => {
      try {
        let pat = token;
        if (!pat) {
          pat = (await getGithubToken()) ?? undefined;
          if (!pat) return { content: [{ type: "text", text: "No GitHub token provided and none found in keychain. Provide a token." }] };
        }

        const client = new GithubClient(pat);
        const user = await client.verifyToken();

        if (token) await saveGithubToken(token);
        githubClient = client;

        return {
          content: [{
            type: "text",
            text: `Connected to GitHub as ${user.login}${user.name ? ` (${user.name})` : ""}. Token saved to keychain.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `GitHub connection failed: ${(err as Error).message}` }] };
      }
    }
  );

  /**
   * List all GitHub Projects v2 boards for an org.
   */
  server.tool(
    "list_github_projects",
    "List all GitHub Projects v2 boards for a GitHub organization. Use this to find the project number before calling list_github_project_items.",
    {
      org: z.string().describe("GitHub organization name (e.g., 'dfinsolutions')"),
    },
    async ({ org }) => {
      try {
        const client = getGithubClient();
        const projects = await client.listOrgProjects(org);
        if (!projects.length) {
          return { content: [{ type: "text", text: `No Projects v2 boards found for org '${org}'.` }] };
        }
        const lines = projects.map((p) => `#${p.number} — ${p.title} (${p.itemCount} items)\n  ${p.url}`);
        return {
          content: [{ type: "text", text: `GitHub Projects v2 for ${org}:\n\n${lines.join("\n\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  /**
   * List open (or filtered) issues from a GitHub repository.
   */
  server.tool(
    "list_github_issues",
    "List issues from a GitHub repository. Use this to browse issues before importing to ADO.",
    {
      owner: z.string().describe("GitHub org or user name (e.g., 'microsoft')"),
      repo: z.string().describe("Repository name (e.g., 'vscode')"),
      state: z.enum(["open", "closed", "all"]).optional().default("open").describe("Issue state filter"),
      label: z.string().optional().describe("Filter by label name"),
      limit: z.number().optional().default(25).describe("Max issues to return (1–100)"),
    },
    async ({ owner, repo, state, label, limit }) => {
      try {
        const client = getGithubClient();
        const issues = await client.listIssues(owner, repo, { state, label, limit });

        if (!issues.length) {
          return { content: [{ type: "text", text: `No ${state} issues found in ${owner}/${repo}.` }] };
        }

        const lines = issues.map((i) => {
          const labels = i.labels.map((l) => l.name).join(", ");
          return `#${i.number} [${i.state}] ${i.title}${labels ? ` [${labels}]` : ""}\n  ${i.html_url}`;
        });

        return {
          content: [{
            type: "text",
            text: `GitHub issues in ${owner}/${repo} (${issues.length} shown):\n\n${lines.join("\n\n")}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  /**
   * List items from a GitHub Projects v2 board.
   */
  server.tool(
    "list_github_project_items",
    "List items from a GitHub Projects v2 board. Use this to browse project tasks before importing to ADO.",
    {
      owner: z.string().describe("GitHub org or user name that owns the project"),
      project_number: z.number().describe("The project number (visible in the URL: /projects/N)"),
    },
    async ({ owner, project_number }) => {
      try {
        const client = getGithubClient();
        const items = await client.listProjectItems(owner, project_number);

        if (!items.length) {
          return { content: [{ type: "text", text: `No items found in project #${project_number}.` }] };
        }

        const lines = items.map((item) => {
          const num = item.number != null ? `#${item.number} ` : "";
          const status = item.status ? ` [${item.status}]` : "";
          const labels = item.labels.length ? ` [${item.labels.join(", ")}]` : "";
          const assignees = item.assignees.length ? ` → ${item.assignees.join(", ")}` : "";
          const url = item.url ? ` | ${item.url}` : "";
          return `${num}${item.title}${status}${labels}${assignees}${url}`;
        });

        return {
          content: [{
            type: "text",
            text: `GitHub Project #${project_number} items (${items.length} total):\n\n${lines.join("\n\n")}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  /**
   * Import a single GitHub issue into ADO as a work item.
   * ADO fields can be overridden — if not provided, the tool previews the
   * mapped values and asks the user to confirm or adjust before creating.
   */
  server.tool(
    "import_github_issue",
    "Import a GitHub issue into Azure DevOps as a work item. Fetches the issue, maps fields, and creates the ADO item. All ADO fields can be overridden.",
    {
      owner: z.string().describe("GitHub org or user (for repo issues) or project owner"),
      repo: z.string().optional().describe("Repository name — required when importing a repo issue"),
      issue_number: z.number().optional().describe("Issue number — required when importing a repo issue"),
      project_number: z.number().optional().describe("GitHub Project number — use with project_item_number for project items"),
      project_item_number: z.number().optional().describe("Issue number from a GitHub Project item (use list_github_project_items to find it)"),
      // ADO overrides
      title: z.string().optional().describe("Override the ADO work item title (defaults to GitHub issue title)"),
      description: z.string().optional().describe("Override description (defaults to GitHub issue body)"),
      type: z.string().optional().default("Engineering Story").describe("ADO work item type"),
      assigned_to: z.string().optional().describe("ADO assignee display name"),
      area_path: z.string().optional().describe("ADO area path override"),
      iteration_path: z.string().optional().describe("ADO iteration path override"),
      tags: z.string().optional().describe("Semicolon-separated ADO tags (e.g. 'AD; 2026 - Q3 - SRE')"),
      parent_id: z.number().optional().describe("ADO parent work item ID"),
      preview_only: z.boolean().optional().default(false).describe("If true, shows mapped fields without creating the ADO item"),
      // DFIN required fields
      acceptance_criteria: z.string().optional().describe("Acceptance criteria for the ADO work item"),
      product_name: z.string().optional().describe("Product name (e.g., 'ActiveDisclosure')"),
      requestor: z.string().optional().describe("Requestor display name (e.g., 'Krishnendu Sur')"),
    },
    async ({
      owner, repo, issue_number, project_number, project_item_number,
      title, description, type, assigned_to, area_path, iteration_path, tags, parent_id, preview_only,
      acceptance_criteria, product_name, requestor,
    }) => {
      try {
        const adoClient = getActiveClient();
        if (!adoClient) return { content: [{ type: "text", text: "Not connected to ADO. Call connect first." }] };

        const ghClient = getGithubClient();

        // Resolve the GitHub issue
        let issue: GithubIssue;
        let sourceUrl: string;

        if (repo && issue_number != null) {
          issue = await ghClient.getIssue(owner, repo, issue_number);
          sourceUrl = issue.html_url;
        } else if (project_number != null && project_item_number != null) {
          const items = await ghClient.listProjectItems(owner, project_number);
          const match = items.find((i) => i.number === project_item_number);
          if (!match) {
            return { content: [{ type: "text", text: `Issue #${project_item_number} not found in project #${project_number}.` }] };
          }
          if (!match.url || !repo) {
            // Treat as draft/synthetic issue — build a minimal GithubIssue shape
            issue = {
              number: project_item_number,
              title: match.title,
              body: match.body,
              state: "open",
              html_url: match.url ?? `https://github.com/orgs/${owner}/projects/${project_number}`,
              labels: match.labels.map((name) => ({ name })),
              assignees: match.assignees.map((login) => ({ login })),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              milestone: null,
              user: { login: owner },
            } as GithubIssue;
            sourceUrl = match.url ?? `https://github.com/orgs/${owner}/projects/${project_number}`;
          } else {
            // Extract owner/repo/number from the issue URL
            const urlMatch = match.url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
            if (!urlMatch) {
              return { content: [{ type: "text", text: `Cannot parse issue URL: ${match.url}` }] };
            }
            issue = await ghClient.getIssue(urlMatch[1], urlMatch[2], parseInt(urlMatch[3], 10));
            sourceUrl = issue.html_url;
          }
        } else {
          return {
            content: [{
              type: "text",
              text: "Provide either (owner + repo + issue_number) or (owner + project_number + project_item_number).",
            }],
          };
        }

        // Map GitHub → ADO fields
        const mappedTitle = title ?? issue.title;
        const mappedDescription = description ?? buildDescription(issue, sourceUrl);
        const mappedType = type ?? "Engineering Story";
        const mappedTags = tags ?? issue.labels.map((l) => l.name).join("; ");

        if (preview_only) {
          const lines = [
            `**GitHub issue**: ${sourceUrl}`,
            `**Title**: ${mappedTitle}`,
            `**Type**: ${mappedType}`,
            assigned_to ? `**Assigned to**: ${assigned_to}` : `**Assigned to**: (not set — GitHub: ${issue.assignees.map((a) => a.login).join(", ") || "unassigned"})`,
            area_path ? `**Area path**: ${area_path}` : `**Area path**: (not set — will use profile default)`,
            iteration_path ? `**Iteration**: ${iteration_path}` : `**Iteration**: (not set — will use profile default)`,
            `**Tags**: ${mappedTags || "(none)"}`,
            parent_id ? `**Parent ID**: ${parent_id}` : `**Parent ID**: (not set)`,
            `\n**Description preview**:\n${issue.body?.slice(0, 300) ?? "(empty)"}${(issue.body?.length ?? 0) > 300 ? "…" : ""}`,
            `\nTo create: call import_github_issue again with the same params and **preview_only: false**.`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Build ADO fields map
        const fields: Record<string, unknown> = {
          "System.Title": mappedTitle,
          "System.Description": mappedDescription,
        };
        if (assigned_to) fields["System.AssignedTo"] = assigned_to;
        if (area_path) fields["System.AreaPath"] = area_path;
        if (iteration_path) fields["System.IterationPath"] = iteration_path;
        if (mappedTags) fields["System.Tags"] = mappedTags;
        if (acceptance_criteria) fields["Microsoft.VSTS.Common.AcceptanceCriteria"] = acceptance_criteria;
        if (product_name) fields["Custom.ProductName"] = product_name;
        if (requestor) fields["Custom.Requestor"] = requestor;

        const created = await adoClient.createWorkItem(mappedType, fields, undefined, parent_id);
        const id = created.id;

        const { org, project } = (await import("./connect.js")).getActiveContext();
        const webUrl = `https://dev.azure.com/${org}/${encodeURIComponent(project ?? "")}/_workitems/edit/${id}`;

        return {
          content: [{
            type: "text",
            text: [
              `Work item created from GitHub issue ${sourceUrl}`,
              ``,
              `ID: ${id}`,
              `Title: ${mappedTitle}`,
              `Type: ${mappedType}`,
              assigned_to ? `Assigned to: ${assigned_to}` : "",
              parent_id ? `Parent: ${parent_id}` : "",
              `URL: ${webUrl}`,
            ].filter(Boolean).join("\n"),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );
}
