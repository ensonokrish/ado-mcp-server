import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GithubClient, GithubIssue } from "../api/github-client.js";
import { saveGithubToken, getGithubToken, getGithubProfile, saveGithubProfile } from "../auth/credentials.js";
import { getActiveClient, getActiveContext } from "./connect.js";
import { escapeWiql, logAudit, scrubToolResponse } from "../security/index.js";
let githubClient: GithubClient | null = null;
let activeGithubProfileName: string | null = null;

function getGithubClient(): GithubClient {
  if (!githubClient) throw new Error("Not connected to GitHub. Call connect_github first.");
  return githubClient;
}

async function resolveGithubScope(
  profileName: string | undefined,
  owner: string | undefined,
  projectNumber: number | undefined,
  repo?: string
): Promise<{ owner: string; projectNumber: number; repo?: string }> {
  const profile = await getGithubProfile(profileName ?? activeGithubProfileName ?? "ensono-cloudops-q4");
  const resolvedOwner = owner ?? profile?.organization;
  const resolvedProjectNumber = projectNumber ?? profile?.projectNumber;
  const resolvedRepo = repo ?? profile?.defaultRepository;
  if (!resolvedOwner || !resolvedProjectNumber) {
    throw new Error("Provide owner and project_number, or configure a GitHub Project profile.");
  }
  if (profile?.allowedRepositories?.length && resolvedRepo && !profile.allowedRepositories.includes(resolvedRepo)) {
    throw new Error(`Repository '${resolvedRepo}' is not permitted by GitHub profile '${profile.name}'.`);
  }
  return { owner: resolvedOwner, projectNumber: resolvedProjectNumber, repo: resolvedRepo };
}

function statusOption(context: Awaited<ReturnType<GithubClient["getProjectContext"]>>, status: string) {
  const field = context.fields.find((candidate) => candidate.name.toLowerCase() === "status" && candidate.dataType === "SINGLE_SELECT");
  if (!field) throw new Error("This Project has no single-select Status field.");
  const option = field.options.find((candidate) => candidate.name.toLowerCase() === status.toLowerCase());
  if (!option) throw new Error(`Invalid status '${status}'. Allowed values: ${field.options.map((candidate) => candidate.name).join(", ")}.`);
  return { field, option };
}

function formatGithubIssue(issue: GithubIssue, status?: string | null): string {
  return [
    `Issue: #${issue.number}`,
    `Title: ${issue.title}`,
    `State: ${issue.state}`,
    status ? `Status: ${status}` : "",
    `URL: ${issue.html_url}`,
  ].filter(Boolean).join("\n");
}

function mapAdoStateToGithubStatus(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized.includes("review") || normalized === "resolved") return "In review";
  if (normalized.includes("progress") || normalized === "active") return "In progress";
  if (normalized === "committed") return "Ready";
  return "Backlog";
}

function mapAdoTypeToGithubType(type: string): "task" | "story" | "epic" {
  const normalized = type.toLowerCase();
  if (normalized.includes("epic") || normalized.includes("feature")) return "epic";
  if (normalized.includes("task")) return "task";
  return "story";
}

function buildMigratedIssueBody(fields: Record<string, unknown>, sourceUrl: string, migrationKey: string): string {
  const description = scrubToolResponse(String(fields["System.Description"] ?? "")).text;
  const acceptanceCriteria = scrubToolResponse(String(fields["Microsoft.VSTS.Common.AcceptanceCriteria"] ?? "")).text;
  return [
    description ? `## Description\n\n${description}` : "",
    acceptanceCriteria ? `## Acceptance Criteria\n\n${acceptanceCriteria}` : "",
    "## Migration",
    "- Source system: Azure DevOps",
    `- Source URL: ${sourceUrl}`,
    `<!-- ${migrationKey} -->`,
  ].filter(Boolean).join("\n\n");
}

function withParentReference(body: string | undefined, owner: string, repo: string, parentIssueNumber: number | undefined): string | undefined {
  if (!parentIssueNumber) return body;
  const parentUrl = `https://github.com/${owner}/${repo}/issues/${parentIssueNumber}`;
  return [body, "## Parent", `- Parent issue: ${parentUrl}`, `<!-- github-parent:${owner}/${repo}#${parentIssueNumber} -->`]
    .filter(Boolean)
    .join("\n\n");
}

function resolveIteration(
  iterations: Awaited<ReturnType<GithubClient["getProjectIterations"]>>["iterations"],
  requestedIteration: string
) {
  if (requestedIteration.toLowerCase() !== "@current") {
    return iterations.find((candidate) => candidate.title.toLowerCase() === requestedIteration.toLowerCase());
  }
  const today = new Date();
  return iterations.find((candidate) => {
    if (!candidate.startDate || !candidate.duration) return false;
    const start = new Date(`${candidate.startDate}T00:00:00Z`);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + candidate.duration);
    return start <= today && today < end;
  });
}

type MigrationFilters = {
  assigned_to?: string;
  iteration_path?: string;
  work_item_type?: string;
  tag?: string;
  changed_since?: string;
};

async function resolveMigrationWorkItemIds(
  adoClient: NonNullable<ReturnType<typeof getActiveClient>>,
  workItemIds: number[] | undefined,
  adoProject: string | undefined,
  filters: MigrationFilters
): Promise<number[]> {
  if (workItemIds?.length) return workItemIds;
  if (!Object.values(filters).some(Boolean)) {
    throw new Error("Provide work_item_ids or at least one migration filter. Unbounded migrations are not allowed.");
  }
  const clauses = ["[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Cancelled')"];
  if (filters.assigned_to) clauses.push(`[System.AssignedTo] = '${escapeWiql(filters.assigned_to)}'`);
  if (filters.iteration_path) clauses.push(`[System.IterationPath] UNDER '${escapeWiql(filters.iteration_path)}'`);
  if (filters.work_item_type) clauses.push(`[System.WorkItemType] = '${escapeWiql(filters.work_item_type)}'`);
  if (filters.tag) clauses.push(`[System.Tags] CONTAINS '${escapeWiql(filters.tag)}'`);
  if (filters.changed_since) clauses.push(`[System.ChangedDate] >= '${escapeWiql(filters.changed_since)}'`);
  const result = await adoClient.queryByWiql(`SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")}`, adoProject, 100);
  return result.workItems.map((item) => item.id);
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
      token: z.string().optional().describe("GitHub PAT (classic or fine-grained with Issues: Read and write and Projects: Read and write). If omitted, loads from keychain."),
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

  server.tool(
    "configure_github_profile",
    "Save a non-secret GitHub Project profile. Use this to configure the CloudOps Q4 organization, Project, default repository, and allowed repository list.",
    {
      profile_name: z.string().default("ensono-cloudops-q4").describe("Profile name"),
      organization: z.string().describe("GitHub organization, e.g. 'dfinsolutions'"),
      project_number: z.number().describe("GitHub Project v2 number, e.g. 52"),
      default_repository: z.string().optional().describe("Default repository for new issues"),
      allowed_repositories: z.array(z.string()).optional().describe("Repositories allowed for issue creation, e.g. ['cloudops-work']"),
    },
    async ({ profile_name, organization, project_number, default_repository, allowed_repositories }) => {
      const started = Date.now();
      const client = getGithubClient();
      const context = await client.getProjectContext(organization, project_number);
      await saveGithubProfile({
        name: profile_name,
        organization,
        projectNumber: project_number,
        defaultRepository: default_repository,
        allowedRepositories: allowed_repositories,
      });
      activeGithubProfileName = profile_name;
      logAudit({ timestamp: new Date().toISOString(), tool: "configure_github_profile", arguments: { profile_name, organization, project_number, default_repository, allowed_repositories }, success: true, durationMs: Date.now() - started });
      return { content: [{ type: "text", text: `GitHub profile '${profile_name}' configured for ${organization} Project #${project_number}: ${context.title}.` }] };
    }
  );

  server.tool(
    "get_github_project_context",
    "Read the live GitHub Project schema and allowed workflow statuses before managing work.",
    {
      profile_name: z.string().optional().describe("Saved GitHub profile name"),
      owner: z.string().optional().describe("GitHub organization override"),
      project_number: z.number().optional().describe("GitHub Project number override"),
    },
    async ({ profile_name, owner, project_number }) => {
      try {
        const scope = await resolveGithubScope(profile_name, owner, project_number);
        const context = await getGithubClient().getProjectContext(scope.owner, scope.projectNumber);
        const fields = context.fields.map((field) => `${field.name} (${field.dataType})${field.options.length ? `: ${field.options.map((option) => option.name).join(", ")}` : ""}`);
        return { content: [{ type: "text", text: `GitHub Project #${context.number}: ${context.title}\n${context.url}\n\nFields:\n${fields.map((field) => `- ${field}`).join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  server.tool(
    "create_github_work_item",
    "Create a Task, Story, or Epic as a GitHub issue, add it to a GitHub Project, and set its validated board status.",
    {
      title: z.string().min(1).max(256).describe("Work item title"),
      work_type: z.enum(["task", "story", "epic"]).describe("Work item type, represented by a type label"),
      body: z.string().max(65536).optional().describe("Markdown description"),
      parent_issue_number: z.number().optional().describe("Parent issue in the same repository; stored as a portable hierarchy reference"),
      status: z.string().optional().default("Backlog").describe("Project Status value"),
      iteration: z.string().optional().default("@current").describe("Project iteration title, or @current for the active date-based iteration"),
      labels: z.array(z.string()).optional().default([]).describe("Existing GitHub labels"),
      assignees: z.array(z.string()).optional().default([]).describe("Verified GitHub logins"),
      profile_name: z.string().optional().describe("Saved GitHub profile name"),
      owner: z.string().optional().describe("GitHub organization override"),
      project_number: z.number().optional().describe("GitHub Project number override"),
      repo: z.string().optional().describe("Repository for the issue"),
    },
    async ({ title, work_type, body, parent_issue_number, status, iteration, labels, assignees, profile_name, owner, project_number, repo }) => {
      const started = Date.now();
      try {
        const scope = await resolveGithubScope(profile_name, owner, project_number, repo);
        if (!scope.repo) throw new Error("Provide repo or configure default_repository in the GitHub profile.");
        const client = getGithubClient();
        const context = await client.getProjectContext(scope.owner, scope.projectNumber);
        const selectedStatus = statusOption(context, status);
        const issue = await client.createIssue(scope.owner, scope.repo, {
          title,
          body: withParentReference(body, scope.owner, scope.repo, parent_issue_number),
          labels: [...new Set([`type:${work_type}`, ...labels])],
          assignees,
        });
        const projectItemId = await client.addIssueToProject(context.id, issue.html_url);
        await client.setProjectSingleSelectField(context.id, projectItemId, selectedStatus.field.id, selectedStatus.option.id);

        const iterations = await client.getProjectIterations(scope.owner, scope.projectNumber);
        const selectedIteration = resolveIteration(iterations.iterations, iteration);
        if (!selectedIteration) {
          throw new Error(`Iteration '${iteration}' was not found. Available values: ${iterations.iterations.map((candidate) => candidate.title).join(", ") || "none"}.`);
        }
        await client.setProjectIterationField(context.id, projectItemId, iterations.fieldId, selectedIteration.id);

        const projectItem = await client.getProjectItem(projectItemId);
        if (projectItem.projectId !== context.id || projectItem.issueUrl !== issue.html_url) {
          throw new Error(
            `GitHub returned Project item '${projectItemId}', but it does not match Project #${scope.projectNumber} and issue #${issue.number}.`
          );
        }

        logAudit({ timestamp: new Date().toISOString(), tool: "create_github_work_item", arguments: { title, work_type, parent_issue_number, status, iteration: selectedIteration.title, owner: scope.owner, project_number: scope.projectNumber, repo: scope.repo }, success: true, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `GitHub work item created and added to Project #${scope.projectNumber}, iteration ${selectedIteration.title}.\n\n${formatGithubIssue(issue, selectedStatus.option.name)}` }] };
      } catch (err) {
        logAudit({ timestamp: new Date().toISOString(), tool: "create_github_work_item", arguments: { title, work_type, status, iteration, owner, project_number, repo }, success: false, error: (err as Error).message, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  server.tool(
    "set_github_work_item_status",
    "Move an existing GitHub issue already on the Project board to a validated Status value. This does not close or reopen the issue.",
    {
      repo: z.string().describe("Repository containing the issue"),
      issue_number: z.number().describe("GitHub issue number"),
      status: z.string().describe("Project Status value"),
      profile_name: z.string().optional().describe("Saved GitHub profile name"),
      owner: z.string().optional().describe("GitHub organization override"),
      project_number: z.number().optional().describe("GitHub Project number override"),
    },
    async ({ repo, issue_number, status, profile_name, owner, project_number }) => {
      const started = Date.now();
      try {
        const scope = await resolveGithubScope(profile_name, owner, project_number, repo);
        const client = getGithubClient();
        const issue = await client.getIssue(scope.owner, repo, issue_number);
        const context = await client.getProjectContext(scope.owner, scope.projectNumber);
        const selectedStatus = statusOption(context, status);
        const items = await client.listProjectItems(scope.owner, scope.projectNumber);
        const item = items.find((candidate) => candidate.url === issue.html_url);
        if (!item) throw new Error(`Issue #${issue_number} is not on GitHub Project #${scope.projectNumber}.`);
        await client.setProjectSingleSelectField(context.id, item.id, selectedStatus.field.id, selectedStatus.option.id);
        logAudit({ timestamp: new Date().toISOString(), tool: "set_github_work_item_status", arguments: { owner: scope.owner, project_number: scope.projectNumber, repo, issue_number, status }, success: true, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `GitHub issue #${issue_number} moved to ${selectedStatus.option.name}.\n${issue.html_url}` }] };
      } catch (err) {
        logAudit({ timestamp: new Date().toISOString(), tool: "set_github_work_item_status", arguments: { owner, project_number, repo, issue_number, status }, success: false, error: (err as Error).message, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  server.tool(
    "set_github_work_item_iteration",
    "Move an existing GitHub work item to a live GitHub Project iteration by its exact title.",
    {
      repo: z.string().describe("Repository containing the issue"),
      issue_number: z.number().describe("GitHub issue number"),
      iteration: z.string().min(1).describe("Exact GitHub Project iteration title, or '@current' to resolve the active date-based iteration"),
      profile_name: z.string().optional().describe("Saved GitHub profile name"),
      owner: z.string().optional().describe("GitHub organization override"),
      project_number: z.number().optional().describe("GitHub Project number override"),
    },
    async ({ repo, issue_number, iteration, profile_name, owner, project_number }) => {
      const started = Date.now();
      try {
        const scope = await resolveGithubScope(profile_name, owner, project_number, repo);
        const client = getGithubClient();
        const issue = await client.getIssue(scope.owner, repo, issue_number);
        const project = await client.getProjectContext(scope.owner, scope.projectNumber);
        const boardItem = (await client.listProjectItems(scope.owner, scope.projectNumber)).find((candidate) => candidate.url === issue.html_url);
        if (!boardItem) throw new Error(`Issue #${issue_number} is not on GitHub Project #${scope.projectNumber}.`);
        const iterations = await client.getProjectIterations(scope.owner, scope.projectNumber);
        const selected = resolveIteration(iterations.iterations, iteration);
        if (!selected) throw new Error(`Iteration '${iteration}' was not found. Available values: ${iterations.iterations.map((candidate) => candidate.title).join(", ") || "none"}.`);
        await client.setProjectIterationField(project.id, boardItem.id, iterations.fieldId, selected.id);
        logAudit({ timestamp: new Date().toISOString(), tool: "set_github_work_item_iteration", arguments: { owner: scope.owner, project_number: scope.projectNumber, repo, issue_number, iteration: selected.title }, success: true, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `GitHub issue #${issue_number} moved to iteration ${selected.title}.\n${issue.html_url}` }] };
      } catch (err) {
        logAudit({ timestamp: new Date().toISOString(), tool: "set_github_work_item_iteration", arguments: { owner, project_number, repo, issue_number, iteration }, success: false, error: (err as Error).message, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  server.tool(
    "update_github_work_item",
    "Edit title, Markdown body, labels, assignees, and optionally Project Status for a GitHub work item.",
    {
      repo: z.string().describe("Repository containing the issue"),
      issue_number: z.number().describe("GitHub issue number"),
      title: z.string().min(1).max(256).optional().describe("Replacement title"),
      body: z.string().max(65536).optional().describe("Replacement Markdown body"),
      labels: z.array(z.string()).optional().describe("Replacement labels"),
      assignees: z.array(z.string()).optional().describe("Replacement verified GitHub logins"),
      parent_issue_number: z.number().optional().describe("Parent issue in the same repository; updates the portable hierarchy reference"),
      status: z.string().optional().describe("Optional Project Status value"),
      profile_name: z.string().optional().describe("Saved GitHub profile name"),
      owner: z.string().optional().describe("GitHub organization override"),
      project_number: z.number().optional().describe("GitHub Project number override"),
    },
    async ({ repo, issue_number, title, body, labels, assignees, parent_issue_number, status, profile_name, owner, project_number }) => {
      const started = Date.now();
      try {
        if (!title && body === undefined && !labels && !assignees && !parent_issue_number && !status) throw new Error("Provide at least one field to update.");
        const scope = await resolveGithubScope(profile_name, owner, project_number, repo);
        const client = getGithubClient();
        const existing = parent_issue_number ? await client.getIssue(scope.owner, repo, issue_number) : undefined;
        const updatedBody = parent_issue_number
          ? withParentReference((body ?? existing?.body ?? "").replace(/\n*## Parent\n[\s\S]*?<!-- github-parent:[\s\S]*? -->/g, ""), scope.owner, repo, parent_issue_number)
          : body;
        const issue = await client.updateIssue(scope.owner, repo, issue_number, { title, body: updatedBody, labels, assignees });
        let resolvedStatus: string | null = null;
        if (status) {
          const context = await client.getProjectContext(scope.owner, scope.projectNumber);
          const selectedStatus = statusOption(context, status);
          const item = (await client.listProjectItems(scope.owner, scope.projectNumber)).find((candidate) => candidate.url === issue.html_url);
          if (!item) throw new Error(`Issue #${issue_number} is not on GitHub Project #${scope.projectNumber}. Issue content was updated.`);
          await client.setProjectSingleSelectField(context.id, item.id, selectedStatus.field.id, selectedStatus.option.id);
          resolvedStatus = selectedStatus.option.name;
        }
        logAudit({ timestamp: new Date().toISOString(), tool: "update_github_work_item", arguments: { owner: scope.owner, project_number: scope.projectNumber, repo, issue_number, title, labels, assignees, status }, success: true, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `GitHub work item updated.\n\n${formatGithubIssue(issue, resolvedStatus)}` }] };
      } catch (err) {
        logAudit({ timestamp: new Date().toISOString(), tool: "update_github_work_item", arguments: { owner, project_number, repo, issue_number, title, labels, assignees, status }, success: false, error: (err as Error).message, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  server.tool(
    "close_github_work_item",
    "Set a GitHub Project work item to Done and close its underlying issue. Reports a partial result if issue closure fails after the board move.",
    {
      repo: z.string().describe("Repository containing the issue"),
      issue_number: z.number().describe("GitHub issue number"),
      profile_name: z.string().optional().describe("Saved GitHub profile name"),
      owner: z.string().optional().describe("GitHub organization override"),
      project_number: z.number().optional().describe("GitHub Project number override"),
    },
    async ({ repo, issue_number, profile_name, owner, project_number }) => {
      const started = Date.now();
      try {
        const scope = await resolveGithubScope(profile_name, owner, project_number, repo);
        const client = getGithubClient();
        const issue = await client.getIssue(scope.owner, repo, issue_number);
        const context = await client.getProjectContext(scope.owner, scope.projectNumber);
        const selectedStatus = statusOption(context, "Done");
        const item = (await client.listProjectItems(scope.owner, scope.projectNumber)).find((candidate) => candidate.url === issue.html_url);
        if (!item) throw new Error(`Issue #${issue_number} is not on GitHub Project #${scope.projectNumber}.`);
        await client.setProjectSingleSelectField(context.id, item.id, selectedStatus.field.id, selectedStatus.option.id);
        try {
          const closed = await client.updateIssue(scope.owner, repo, issue_number, { state: "closed" });
          logAudit({ timestamp: new Date().toISOString(), tool: "close_github_work_item", arguments: { owner: scope.owner, project_number: scope.projectNumber, repo, issue_number }, success: true, durationMs: Date.now() - started });
          return { content: [{ type: "text", text: `GitHub work item completed.\n\n${formatGithubIssue(closed, selectedStatus.option.name)}` }] };
        } catch (err) {
          logAudit({ timestamp: new Date().toISOString(), tool: "close_github_work_item", arguments: { owner: scope.owner, project_number: scope.projectNumber, repo, issue_number }, success: false, error: `Project status set to Done; issue closure failed: ${(err as Error).message}`, durationMs: Date.now() - started });
          return { content: [{ type: "text", text: `Project status was set to Done, but issue #${issue_number} could not be closed: ${(err as Error).message}` }] };
        }
      } catch (err) {
        logAudit({ timestamp: new Date().toISOString(), tool: "close_github_work_item", arguments: { owner, project_number, repo, issue_number }, success: false, error: (err as Error).message, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  server.tool(
    "reopen_github_work_item",
    "Reopen a GitHub issue and move it to an explicit non-Done Project Status.",
    {
      repo: z.string().describe("Repository containing the issue"),
      issue_number: z.number().describe("GitHub issue number"),
      status: z.string().describe("Destination Project Status, such as Backlog or Ready"),
      profile_name: z.string().optional().describe("Saved GitHub profile name"),
      owner: z.string().optional().describe("GitHub organization override"),
      project_number: z.number().optional().describe("GitHub Project number override"),
    },
    async ({ repo, issue_number, status, profile_name, owner, project_number }) => {
      const started = Date.now();
      try {
        if (status.toLowerCase() === "done") throw new Error("A reopened issue must use a non-Done status.");
        const scope = await resolveGithubScope(profile_name, owner, project_number, repo);
        const client = getGithubClient();
        const reopened = await client.updateIssue(scope.owner, repo, issue_number, { state: "open" });
        const context = await client.getProjectContext(scope.owner, scope.projectNumber);
        const selectedStatus = statusOption(context, status);
        const item = (await client.listProjectItems(scope.owner, scope.projectNumber)).find((candidate) => candidate.url === reopened.html_url);
        if (!item) throw new Error(`Issue #${issue_number} was reopened but is not on GitHub Project #${scope.projectNumber}.`);
        await client.setProjectSingleSelectField(context.id, item.id, selectedStatus.field.id, selectedStatus.option.id);
        logAudit({ timestamp: new Date().toISOString(), tool: "reopen_github_work_item", arguments: { owner: scope.owner, project_number: scope.projectNumber, repo, issue_number, status }, success: true, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `GitHub work item reopened.\n\n${formatGithubIssue(reopened, selectedStatus.option.name)}` }] };
      } catch (err) {
        logAudit({ timestamp: new Date().toISOString(), tool: "reopen_github_work_item", arguments: { owner, project_number, repo, issue_number, status }, success: false, error: (err as Error).message, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  server.tool(
    "preview_ado_to_github_migration",
    "Preview migration of open Azure DevOps work items to GitHub Project work items. This tool performs no writes.",
    {
      work_item_ids: z.array(z.number()).min(1).max(100).optional().describe("Open Azure DevOps work item IDs to assess"),
      assigned_to: z.string().optional().describe("Filter by ADO assignee"),
      iteration_path: z.string().optional().describe("Filter by ADO iteration path"),
      work_item_type: z.string().optional().describe("Filter by ADO work item type"),
      tag: z.string().optional().describe("Filter by ADO tag"),
      changed_since: z.string().optional().describe("Filter by ADO changed date, YYYY-MM-DD"),
      repo: z.string().describe("Approved repository for the GitHub issues"),
      profile_name: z.string().optional().describe("Saved GitHub profile name"),
      owner: z.string().optional().describe("GitHub organization override"),
      project_number: z.number().optional().describe("GitHub Project number override"),
      ado_project: z.string().optional().describe("Azure DevOps project override"),
    },
    async ({ work_item_ids, assigned_to, iteration_path, work_item_type, tag, changed_since, repo, profile_name, owner, project_number, ado_project }) => {
      try {
        const adoClient = getActiveClient();
        if (!adoClient) throw new Error("Not connected to ADO. Call connect first.");
        const scope = await resolveGithubScope(profile_name, owner, project_number, repo);
        const github = getGithubClient();
        const adoContext = getActiveContext();
        const ids = await resolveMigrationWorkItemIds(adoClient, work_item_ids, ado_project, { assigned_to, iteration_path, work_item_type, tag, changed_since });
        const results: string[] = [];
        for (const id of ids) {
          const item = await adoClient.getWorkItem(id, ado_project, "fields");
          const fields = item.fields;
          const state = String(fields["System.State"] ?? "");
          const sourceProject = ado_project ?? adoContext.project ?? "";
          const sourceUrl = `https://dev.azure.com/${adoContext.org}/${encodeURIComponent(sourceProject)}/_workitems/edit/${id}`;
          const migrationKey = `ado-mcp-source:${adoContext.org}:${sourceProject}:${id}`;
          const existing = await github.findIssueByMigrationKey(scope.owner, repo, migrationKey);
          const closed = /closed|done|removed|cancelled/i.test(state);
          results.push([
            `ADO ${id}: ${fields["System.Title"] ?? "(untitled)"}`,
            `  Type: ${fields["System.WorkItemType"] ?? "Unknown"} -> ${mapAdoTypeToGithubType(String(fields["System.WorkItemType"] ?? ""))}`,
            `  State: ${state || "Unknown"} -> ${mapAdoStateToGithubStatus(state)}`,
            `  Eligible: ${closed ? "no (closed state)" : "yes"}`,
            `  Existing migration: ${existing ? existing.html_url : "none"}`,
            `  Source: ${sourceUrl}`,
          ].join("\n"));
        }
        return { content: [{ type: "text", text: `Migration preview for GitHub Project #${scope.projectNumber}:\n\n${results.join("\n\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  server.tool(
    "migrate_ado_to_github",
    "Migrate open Azure DevOps work items to GitHub issues and a GitHub Project. Run preview_ado_to_github_migration first. This is idempotent and requires confirm: true.",
    {
      work_item_ids: z.array(z.number()).min(1).max(25).optional().describe("Open Azure DevOps work item IDs to migrate"),
      assigned_to: z.string().optional().describe("Filter by ADO assignee"),
      iteration_path: z.string().optional().describe("Filter by ADO iteration path"),
      work_item_type: z.string().optional().describe("Filter by ADO work item type"),
      tag: z.string().optional().describe("Filter by ADO tag"),
      changed_since: z.string().optional().describe("Filter by ADO changed date, YYYY-MM-DD"),
      repo: z.string().describe("Approved repository for the GitHub issues"),
      confirm: z.literal(true).describe("Must be true after reviewing the migration preview"),
      close_ado_after_migration: z.boolean().optional().default(false).describe("Close ADO records only after GitHub creation and backlink succeed"),
      profile_name: z.string().optional().describe("Saved GitHub profile name"),
      owner: z.string().optional().describe("GitHub organization override"),
      project_number: z.number().optional().describe("GitHub Project number override"),
      ado_project: z.string().optional().describe("Azure DevOps project override"),
    },
    async ({ work_item_ids, assigned_to, iteration_path, work_item_type, tag, changed_since, repo, close_ado_after_migration, profile_name, owner, project_number, ado_project }) => {
      const started = Date.now();
      try {
        const adoClient = getActiveClient();
        if (!adoClient) throw new Error("Not connected to ADO. Call connect first.");
        const scope = await resolveGithubScope(profile_name, owner, project_number, repo);
        const github = getGithubClient();
        const project = await github.getProjectContext(scope.owner, scope.projectNumber);
        const adoContext = getActiveContext();
        const ids = await resolveMigrationWorkItemIds(adoClient, work_item_ids, ado_project, { assigned_to, iteration_path, work_item_type, tag, changed_since });
        const outcomes: string[] = [];
        for (const id of ids) {
          const item = await adoClient.getWorkItem(id, ado_project, "fields");
          const fields = item.fields;
          const state = String(fields["System.State"] ?? "");
          if (/closed|done|removed|cancelled/i.test(state)) {
            outcomes.push(`ADO ${id}: skipped (state is ${state}).`);
            continue;
          }
          const sourceProject = ado_project ?? adoContext.project ?? "";
          const sourceUrl = `https://dev.azure.com/${adoContext.org}/${encodeURIComponent(sourceProject)}/_workitems/edit/${id}`;
          const migrationKey = `ado-mcp-source:${adoContext.org}:${sourceProject}:${id}`;
          let issue = await github.findIssueByMigrationKey(scope.owner, repo, migrationKey);
          let projectItemId: string | undefined;
          const type = mapAdoTypeToGithubType(String(fields["System.WorkItemType"] ?? ""));
          if (!issue) {
            issue = await github.createIssue(scope.owner, repo, {
              title: scrubToolResponse(String(fields["System.Title"] ?? "(untitled)")).text,
              body: buildMigratedIssueBody(fields, sourceUrl, migrationKey),
              labels: [`type:${type}`],
            });
            projectItemId = await github.addIssueToProject(project.id, issue.html_url);
          }
          let boardItem = projectItemId
            ? { id: projectItemId }
            : (await github.listProjectItems(scope.owner, scope.projectNumber)).find((candidate) => candidate.url === issue.html_url);
          if (!boardItem) {
            projectItemId = await github.addIssueToProject(project.id, issue.html_url);
            boardItem = { id: projectItemId };
          }
          if (!boardItem) throw new Error(`Migrated issue ${issue.html_url} is not on Project #${scope.projectNumber}.`);
          const selectedStatus = statusOption(project, mapAdoStateToGithubStatus(state));
          await github.setProjectSingleSelectField(project.id, boardItem.id, selectedStatus.field.id, selectedStatus.option.id);
          await adoClient.updateWorkItem(id, { "System.History": `Migrated to GitHub Project #${scope.projectNumber}: ${issue.html_url}` }, ado_project);
          if (close_ado_after_migration) {
            await adoClient.updateWorkItem(id, { "System.State": "Closed" }, ado_project);
          }
          outcomes.push(`ADO ${id}: ${issue.html_url} (${selectedStatus.option.name})${close_ado_after_migration ? "; ADO closed" : "; ADO left open"}.`);
        }
        logAudit({ timestamp: new Date().toISOString(), tool: "migrate_ado_to_github", arguments: { work_item_ids: ids, assigned_to, iteration_path, work_item_type, tag, changed_since, owner: scope.owner, project_number: scope.projectNumber, repo, close_ado_after_migration }, success: true, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `Migration completed:\n\n${outcomes.join("\n")}` }] };
      } catch (err) {
        logAudit({ timestamp: new Date().toISOString(), tool: "migrate_ado_to_github", arguments: { work_item_ids, owner, project_number, repo, close_ado_after_migration }, success: false, error: (err as Error).message, durationMs: Date.now() - started });
        return { content: [{ type: "text", text: `Migration stopped: ${(err as Error).message}` }] };
      }
    }
  );

  server.tool(
    "get_migration_status",
    "Reconcile Azure DevOps work item IDs against GitHub migration markers without making changes.",
    {
      work_item_ids: z.array(z.number()).min(1).max(100).describe("Azure DevOps work item IDs to reconcile"),
      repo: z.string().describe("Repository that holds migrated GitHub issues"),
      profile_name: z.string().optional().describe("Saved GitHub profile name"),
      owner: z.string().optional().describe("GitHub organization override"),
      ado_project: z.string().optional().describe("Azure DevOps project override"),
    },
    async ({ work_item_ids, repo, profile_name, owner, ado_project }) => {
      try {
        const scope = await resolveGithubScope(profile_name, owner, undefined, repo);
        const adoContext = getActiveContext();
        const sourceProject = ado_project ?? adoContext.project ?? "";
        const github = getGithubClient();
        const lines: string[] = [];
        for (const id of work_item_ids) {
          const migrationKey = `ado-mcp-source:${adoContext.org}:${sourceProject}:${id}`;
          const issue = await github.findIssueByMigrationKey(scope.owner, repo, migrationKey);
          lines.push(issue ? `ADO ${id}: migrated -> ${issue.html_url} (${issue.state})` : `ADO ${id}: pending`);
        }
        return { content: [{ type: "text", text: `Migration reconciliation:\n\n${lines.join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
      }
    }
  );
}
