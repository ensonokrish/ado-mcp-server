/**
 * GitHub REST v3 + GraphQL v4 client (read-only).
 */

export interface GithubProject {
  number: number;
  title: string;
  url: string;
  itemCount: number;
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
