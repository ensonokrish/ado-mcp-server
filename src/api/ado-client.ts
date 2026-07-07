/**
 * Azure DevOps REST API client.
 * Uses PAT with Basic auth against the v7.1 API.
 */

export interface AdoConnectionConfig {
  organization: string;
  pat: string;
  defaultProject?: string;
}

export interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  url: string;
}

export interface WorkItemQueryResult {
  workItems: { id: number; url: string }[];
  columns: { referenceName: string; name: string }[];
}

export interface PatchOperation {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

export class AdoClient {
  private baseUrl: string;
  private authHeader: string;
  private defaultProject?: string;

  constructor(config: AdoConnectionConfig) {
    this.baseUrl = `https://dev.azure.com/${config.organization}`;
    this.authHeader =
      "Basic " + Buffer.from(`:${config.pat}`).toString("base64");
    this.defaultProject = config.defaultProject;
  }

  private resolveProject(project?: string): string {
    const resolved = project || this.defaultProject;
    if (!resolved) {
      throw new Error(
        "No project specified and no default project configured. Provide a project name."
      );
    }
    return resolved;
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      query?: Record<string, string>;
    } = {}
  ): Promise<T> {
    const url = new URL(path, this.baseUrl + "/");
    url.searchParams.set("api-version", "7.1");

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      "Content-Type": "application/json",
    };

    // PATCH operations on work items require json-patch content type
    if (options.method === "PATCH" && path.includes("workitems")) {
      headers["Content-Type"] = "application/json-patch+json";
    }

    const response = await fetch(url.toString(), {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `ADO API error ${response.status}: ${response.statusText}\n${errorBody}`
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Validate connection by fetching the organization's projects.
   */
  async validateConnection(): Promise<{ name: string; id: string }[]> {
    const result = await this.request<{
      value: { name: string; id: string }[];
    }>("_apis/projects");
    return result.value;
  }

  /**
   * Get a single work item by ID.
   */
  async getWorkItem(
    id: number,
    project?: string,
    expand?: "all" | "fields" | "relations" | "none"
  ): Promise<WorkItem> {
    const proj = this.resolveProject(project);
    const query: Record<string, string> = {};
    if (expand) {
      query["$expand"] = expand;
    }
    return this.request<WorkItem>(
      `${proj}/_apis/wit/workitems/${id}`,
      { query }
    );
  }

  /**
   * Get multiple work items by IDs.
   */
  async getWorkItems(
    ids: number[],
    project?: string,
    fields?: string[]
  ): Promise<WorkItem[]> {
    const proj = this.resolveProject(project);
    const query: Record<string, string> = {
      ids: ids.join(","),
    };
    if (fields) {
      query["fields"] = fields.join(",");
    }
    const result = await this.request<{ value: WorkItem[] }>(
      `${proj}/_apis/wit/workitems`,
      { query }
    );
    return result.value;
  }

  /**
   * Create a new work item, optionally with a parent link.
   */
  async createWorkItem(
    type: string,
    fields: Record<string, unknown>,
    project?: string,
    parentId?: number
  ): Promise<WorkItem> {
    const proj = this.resolveProject(project);
    const patchDoc: PatchOperation[] = Object.entries(fields).map(
      ([key, value]) => ({
        op: "add" as const,
        path: `/fields/${key}`,
        value,
      })
    );

    if (parentId) {
      patchDoc.push({
        op: "add",
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: `${this.baseUrl}/_apis/wit/workitems/${parentId}`,
          attributes: { comment: "Parent link" },
        },
      });
    }

    return this.request<WorkItem>(
      `${proj}/_apis/wit/workitems/$${encodeURIComponent(type)}`,
      {
        method: "PATCH",
        body: patchDoc,
      }
    );
  }

  /**
   * Update an existing work item.
   */
  async updateWorkItem(
    id: number,
    fields: Record<string, unknown>,
    project?: string
  ): Promise<WorkItem> {
    const proj = this.resolveProject(project);
    const patchDoc: PatchOperation[] = Object.entries(fields).map(
      ([key, value]) => ({
        op: "replace" as const,
        path: `/fields/${key}`,
        value,
      })
    );

    return this.request<WorkItem>(
      `${proj}/_apis/wit/workitems/${id}`,
      {
        method: "PATCH",
        body: patchDoc,
      }
    );
  }

  /**
   * Run a WIQL query.
   */
  async queryByWiql(
    wiql: string,
    project?: string,
    top?: number
  ): Promise<WorkItemQueryResult> {
    const proj = this.resolveProject(project);
    const query: Record<string, string> = {};
    if (top) {
      query["$top"] = top.toString();
    }

    return this.request<WorkItemQueryResult>(
      `${proj}/_apis/wit/wiql`,
      {
        method: "POST",
        body: { query: wiql },
        query,
      }
    );
  }

  /**
   * Get available work item types for a project.
   */
  async getWorkItemTypes(
    project?: string
  ): Promise<{ name: string; description: string }[]> {
    const proj = this.resolveProject(project);
    const result = await this.request<{
      value: { name: string; description: string }[];
    }>(`${proj}/_apis/wit/workitemtypes`);
    return result.value;
  }

  /**
   * Get iterations (sprints) for a project's team.
   */
  async getIterations(
    project?: string,
    team?: string
  ): Promise<{ id: string; name: string; path: string; attributes: unknown }[]> {
    const proj = this.resolveProject(project);
    const teamSegment = team ? `/${encodeURIComponent(team)}` : "";
    const result = await this.request<{
      value: { id: string; name: string; path: string; attributes: unknown }[];
    }>(`${proj}${teamSegment}/_apis/work/teamsettings/iterations`);
    return result.value;
  }
}
