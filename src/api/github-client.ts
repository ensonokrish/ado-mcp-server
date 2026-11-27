/**
 * GitHub REST v3 + GraphQL v4 client (read-only).
 */

export interface GithubProject {
  number: number;
  title: string;
  url: string;
  itemCount: number;
}

export interface GithubProjectField {
  id: string;
  name: string;
  dataType: string;
  options: { id: string; name: string }[];
}

export interface GithubProjectContext {
  id: string;
  number: number;
  title: string;
  url: string;
  fields: GithubProjectField[];
}

export interface GithubProjectIteration {
  id: string;
  title: string;
  startDate: string | null;
  duration: number;
}

export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  created_at: string;
  updated_at: string;
  milestone: { title: string } | null;
  user: { login: string };
}

export interface GithubProjectItem {
  id: string;
  title: string;
  body: string | null;
  url: string | null;
  labels: string[];
  assignees: string[];
  status: string | null;
  number: number | null;
  type: "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE" | string;
}

export interface CreateGithubIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export class GithubClient {
  private token: string;
  private restBase = "https://api.github.com";
  private graphqlUrl = "https://api.github.com/graphql";

  constructor(token: string) {
    this.token = token;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  async verifyToken(): Promise<{ login: string; name: string | null }> {
    const res = await fetch(`${this.restBase}/user`, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`GitHub auth failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json() as { login: string; name: string | null };
    return { login: data.login, name: data.name };
  }

  async listOrgProjects(org: string): Promise<GithubProject[]> {
    const query = `
      query($org: String!, $cursor: String) {
        organization(login: $org) {
          projectsV2(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { number title url items { totalCount } }
          }
        }
      }
    `;
    const projects: GithubProject[] = [];
    let cursor: string | null = null;
    do {
      const res = await fetch(this.graphqlUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ query, variables: { org, cursor } }),
      });
      if (!res.ok) throw new Error(`GitHub GraphQL failed (${res.status}): ${await res.text()}`);
      const json = await res.json() as {
        errors?: { message: string }[];
        data: {
          organization?: {
            projectsV2?: {
              pageInfo: { hasNextPage: boolean; endCursor: string };
              nodes: { number: number; title: string; url: string; items: { totalCount: number } }[];
            };
          };
        };
      };
      if (json.errors?.length) throw new Error(`GitHub GraphQL error: ${json.errors[0].message}`);
      const pv2 = json.data?.organization?.projectsV2;
      if (!pv2) throw new Error(`Organization '${org}' not found or no Projects v2 access.`);
      for (const n of pv2.nodes) {
        projects.push({ number: n.number, title: n.title, url: n.url, itemCount: n.items.totalCount });
      }
      cursor = pv2.pageInfo.hasNextPage ? pv2.pageInfo.endCursor : null;
    } while (cursor);
    return projects;
  }

  async listIssues(
    owner: string,
    repo: string,
    opts: { state?: "open" | "closed" | "all"; label?: string; limit?: number } = {}
  ): Promise<GithubIssue[]> {
    const params = new URLSearchParams({
      state: opts.state ?? "open",
      per_page: String(Math.min(opts.limit ?? 50, 100)),
    });
    if (opts.label) params.set("labels", opts.label);

    const url = `${this.restBase}/repos/${owner}/${repo}/issues?${params}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`GitHub list issues failed (${res.status}): ${await res.text()}`);
    }
    const items = await res.json() as GithubIssue[];
    // REST /issues also returns PRs — filter them out
    return items.filter((i: GithubIssue & { pull_request?: unknown }) => !i.pull_request);
  }

  async getIssue(owner: string, repo: string, number: number): Promise<GithubIssue> {
    const res = await fetch(`${this.restBase}/repos/${owner}/${repo}/issues/${number}`, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`GitHub get issue failed (${res.status}): ${await res.text()}`);
    }
    return res.json() as Promise<GithubIssue>;
  }

  async createIssue(owner: string, repo: string, input: CreateGithubIssueInput): Promise<GithubIssue> {
    const res = await fetch(`${this.restBase}/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`GitHub create issue failed (${res.status}): ${await res.text()}`);
    return res.json() as Promise<GithubIssue>;
  }

  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    input: Partial<CreateGithubIssueInput> & { state?: "open" | "closed" }
  ): Promise<GithubIssue> {
    const res = await fetch(`${this.restBase}/repos/${owner}/${repo}/issues/${number}`, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`GitHub update issue failed (${res.status}): ${await res.text()}`);
    return res.json() as Promise<GithubIssue>;
  }

  async findIssueByMigrationKey(owner: string, repo: string, migrationKey: string): Promise<GithubIssue | null> {
    const params = new URLSearchParams({ q: `repo:${owner}/${repo} "${migrationKey}" in:body`, per_page: "1" });
    const res = await fetch(`${this.restBase}/search/issues?${params}`, { headers: this.headers });
    if (!res.ok) throw new Error(`GitHub migration lookup failed (${res.status}): ${await res.text()}`);
    const data = await res.json() as { items: GithubIssue[] };
    return data.items[0] ?? null;
  }

  async getProjectContext(owner: string, projectNumber: number): Promise<GithubProjectContext> {
    const query = `
      query($owner: String!, $number: Int!) {
        organization(login: $owner) {
          projectV2(number: $number) {
            id number title url
            fields(first: 100) {
              nodes {
                ... on ProjectV2FieldCommon { id name dataType }
                ... on ProjectV2SingleSelectField { id name dataType options { id name } }
              }
            }
          }
        }
      }
    `;
    const json = await this.graphql(query, { owner, number: projectNumber });
    const project = json.data?.organization?.projectV2;
    if (!project) throw new Error("Project not found. Check owner name and project number.");
    return {
      id: project.id,
      number: project.number,
      title: project.title,
      url: project.url,
      fields: project.fields.nodes.map((field: { id: string; name: string; dataType: string; options?: { id: string; name: string }[] }) => ({
        id: field.id,
        name: field.name,
        dataType: field.dataType,
        options: field.options ?? [],
      })),
    };
  }

  async addIssueToProject(projectId: string, issueUrl: string): Promise<string> {
    const contentId = await this.getNodeId(issueUrl);
    const mutation = `
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
      }
    `;
    const json = await this.graphql(mutation, { projectId, contentId });
    const itemId = json.data?.addProjectV2ItemById?.item?.id;
    if (!itemId) throw new Error("GitHub did not return a Project item ID.");
    return itemId;
  }

  async getProjectItem(itemId: string): Promise<{ id: string; projectId: string; issueUrl: string | null }> {
    const query = `
      query($id: ID!) {
        node(id: $id) {
          ... on ProjectV2Item {
            id
            project { id }
            content { ... on Issue { url } }
          }
        }
      }
    `;
    const json = await this.graphql(query, { id: itemId });
    const item = json.data?.node;
    if (!item?.id || !item.project?.id) {
      throw new Error(`GitHub Project item '${itemId}' was not found.`);
    }
    return {
      id: item.id,
      projectId: item.project.id,
      issueUrl: item.content?.url ?? null,
    };
  }

  async setProjectSingleSelectField(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    const mutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) { projectV2Item { id } }
      }
    `;
    await this.graphql(mutation, { projectId, itemId, fieldId, optionId });
  }

  async getProjectIterations(owner: string, projectNumber: number): Promise<{ fieldId: string; iterations: GithubProjectIteration[] }> {
    const query = `
      query($owner: String!, $number: Int!) {
        organization(login: $owner) {
          projectV2(number: $number) {
            fields(first: 100) {
              nodes {
                ... on ProjectV2IterationField {
                  id
                  configuration {
                    iterations { id title startDate duration }
                    completedIterations { id title startDate duration }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const json = await this.graphql(query, { owner, number: projectNumber });
    const fields = json.data?.organization?.projectV2?.fields?.nodes ?? [];
    const field = fields.find((candidate: { configuration?: unknown }) => candidate.configuration);
    if (!field?.id || !field.configuration) throw new Error("This Project has no Iteration field.");
    return {
      fieldId: field.id,
      iterations: [...(field.configuration.iterations ?? []), ...(field.configuration.completedIterations ?? [])],
    };
  }

  async setProjectIterationField(projectId: string, itemId: string, fieldId: string, iterationId: string): Promise<void> {
    const mutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $iterationId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { iterationId: $iterationId }
        }) { projectV2Item { id } }
      }
    `;
    await this.graphql(mutation, { projectId, itemId, fieldId, iterationId });
  }

  private async getNodeId(issueUrl: string): Promise<string> {
    const query = `
      query($url: URI!) {
        resource(url: $url) {
          ... on Issue { id }
        }
      }
    `;
    const json = await this.graphql(query, { url: issueUrl });
    const id = json.data?.resource?.id;
    if (!id) throw new Error(`Unable to resolve GitHub issue node ID: ${issueUrl}`);
    return id;
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    const res = await fetch(this.graphqlUrl, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL failed (${res.status}): ${await res.text()}`);
    const json = await res.json() as { errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`GitHub GraphQL error: ${json.errors[0].message}`);
    return json;
  }

  async listProjectItems(owner: string, projectNumber: number): Promise<GithubProjectItem[]> {
    const query = `
      query($owner: String!, $number: Int!, $cursor: String) {
        organization(login: $owner) {
          projectV2(number: $number) {
            title
            items(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                type
                content {
                  ... on Issue {
                    number
                    title
                    body
                    url
                    labels(first: 10) { nodes { name } }
                    assignees(first: 5) { nodes { login } }
                  }
                  ... on PullRequest {
                    number
                    title
                    body
                    url
                    assignees(first: 5) { nodes { login } }
                  }
                  ... on DraftIssue {
                    title
                    body
                    assignees(first: 5) { nodes { login } }
                  }
                }
                fieldValues(first: 10) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2SingleSelectField { name } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const items: GithubProjectItem[] = [];
    let cursor: string | null = null;

    do {
      const res = await fetch(this.graphqlUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ query, variables: { owner, number: projectNumber, cursor } }),
      });

      if (!res.ok) {
        throw new Error(`GitHub GraphQL failed (${res.status}): ${await res.text()}`);
      }

      const json = await res.json() as {
        errors?: { message: string }[];
        data: {
          organization?: {
            projectV2?: {
              items: {
                pageInfo: { hasNextPage: boolean; endCursor: string };
                nodes: {
                  id: string;
                  type: string;
                  content?: {
                    number?: number;
                    title?: string;
                    body?: string;
                    url?: string;
                    labels?: { nodes: { name: string }[] };
                    assignees?: { nodes: { login: string }[] };
                  };
                  fieldValues: {
                    nodes: {
                      name?: string;
                      field?: { name?: string };
                    }[];
                  };
                }[];
              };
            };
          };
        };
      };

      if (json.errors?.length) {
        throw new Error(`GitHub GraphQL error: ${json.errors[0].message}`);
      }

      const project = json.data?.organization?.projectV2;
      if (!project) {
        throw new Error("Project not found. Check owner name and project number.");
      }

      for (const node of project.items.nodes) {
        const c = node.content;
        // find Status field value
        const status =
          node.fieldValues.nodes.find((fv) => fv.field?.name === "Status")?.name ?? null;
        items.push({
          id: node.id,
          title: c?.title ?? "(untitled)",
          body: c?.body ?? null,
          url: c?.url ?? null,
          labels: c?.labels?.nodes.map((l) => l.name) ?? [],
          assignees: c?.assignees?.nodes.map((a) => a.login) ?? [],
          status,
          number: c?.number ?? null,
          type: node.type,
        });
      }

      const pageInfo = project.items.pageInfo;
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor);

    return items;
  }
}
