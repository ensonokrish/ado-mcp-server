import { GhSession } from "./gh-session.js";

type Input = {
  action: string; owner?: string; repo?: string; issue_number?: number; project_number?: number;
  source_project_number?: number; title?: string; body?: string; labels?: string[]; assignees?: string[];
  state?: "open" | "closed"; state_reason?: "completed" | "not_planned" | "reopened";
  milestone_number?: number | null; issue_type?: string; parent_issue_number?: number;
  related_url?: string; field_name?: string; field_value?: string | number | null; query?: string;
  limit?: number; request_key?: string;
};
type Result = { ok: boolean; data?: Record<string, unknown>; error?: string };

const ident = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98})$/;
const login = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const issue = (i: any) => ({ ...i, url: i.html_url ?? i.url, type: typeof i.type === "string" ? { name: i.type } : i.type ?? null });
const has = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key);

function allowlist(raw: string | undefined, project: boolean): string[] {
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid GitHub allowlist JSON."); }
  if (!Array.isArray(value) || value.some(x => typeof x !== "string" ||
    !(project ? /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[1-9][0-9]*$/ : /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,98}$/).test(x))) {
    throw new Error("Invalid GitHub allowlist entries.");
  }
  return value.map(x => x.toLowerCase());
}

export class GithubWork {
  private readonly repos: string[];
  private readonly projects: string[];
  constructor(private readonly gh = new GhSession(), env: NodeJS.ProcessEnv = process.env) {
    this.repos = allowlist(env.SRE_BUDDY_GITHUB_ALLOWED_REPOSITORIES, false);
    this.projects = allowlist(env.SRE_BUDDY_GITHUB_ALLOWED_PROJECTS, true);
  }

  private checkOwner(owner?: string): asserts owner is string {
    if (!owner || !login.test(owner)) throw new Error("A valid owner is required.");
    if (![...this.repos, ...this.projects].some(x => x.startsWith(owner.toLowerCase() + "/"))) {
      throw new Error("Owner is not allowlisted.");
    }
  }
  private checkRepo(owner: string, repo?: string): asserts repo is string {
    if (!repo || !ident.test(repo) || !this.repos.includes(`${owner}/${repo}`.toLowerCase())) {
      throw new Error("Repository is not allowlisted.");
    }
  }
  private checkProject(owner: string, n?: number): asserts n is number {
    if (!n || !Number.isSafeInteger(n) || !this.projects.includes(`${owner}/${n}`.toLowerCase())) {
      throw new Error("Project is not allowlisted.");
    }
  }
  private path(owner: string, repo: string): string { return `repos/${owner}/${repo}`; }
  private async getIssue(owner: string, repo: string, n: number): Promise<any> {
    const result = await this.gh.api(`${this.path(owner, repo)}/issues/${n}`);
    if (result.pull_request) throw new Error("The number identifies a pull request, not an issue.");
    return issue(result);
  }
  private async project(owner: string, number: number): Promise<any> {
    const data = await this.gh.graphql(`query($owner:String!,$number:Int!){
      organization(login:$owner){ projectV2(number:$number){ id number title url
        fields(first:100){ pageInfo{hasNextPage} nodes{
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options{id name} }
          ... on ProjectV2IterationField { configuration { iterations{id title startDate duration} completedIterations{id title startDate duration} } }
        } }
      } }
    }`, { owner, number });
    const p = data.organization?.projectV2;
    if (!p) throw new Error("Project not found or inaccessible.");
    if (p.fields.pageInfo.hasNextPage) throw new Error("Project has too many fields to inspect safely.");
    return p;
  }
  private async membership(owner: string, repo: string, n: number, projectId: string): Promise<string | null> {
    const d = await this.gh.graphql(`query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){ issue(number:$number){ id projectItems(first:100){
        pageInfo{hasNextPage} nodes{id project{id}}
      } } }
    }`, { owner, repo, number: n });
    const i = d.repository?.issue;
    if (!i) throw new Error("Issue not found or inaccessible.");
    const found = i.projectItems.nodes.find((x: any) => x.project.id === projectId);
    if (!found && i.projectItems.pageInfo.hasNextPage) throw new Error("Issue has too many project memberships to inspect safely.");
    return found?.id ?? null;
  }
  private async add(owner: string, repo: string, n: number, p: any): Promise<string> {
    const existing = await this.membership(owner, repo, n, p.id);
    if (existing) return existing;
    const d = await this.gh.graphql(`query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){issue(number:$number){id}}}`, { owner, repo, number: n });
    const contentId = d.repository?.issue?.id;
    if (!contentId) throw new Error("Issue not found or inaccessible.");
    const r = await this.gh.graphql(`mutation($projectId:ID!,$contentId:ID!){
      addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id}}}`,
    { projectId: p.id, contentId });
    const id = r.addProjectV2ItemById?.item?.id;
    if (!id || await this.membership(owner, repo, n, p.id) !== id) throw new Error("Project addition could not be verified.");
    return id;
  }
  private async remove(owner: string, repo: string, n: number, p: any): Promise<void> {
    const id = await this.membership(owner, repo, n, p.id);
    if (!id) return;
    await this.gh.graphql(`mutation($projectId:ID!,$itemId:ID!){
      deleteProjectV2Item(input:{projectId:$projectId,itemId:$itemId}){deletedItemId}}`, { projectId: p.id, itemId: id });
    if (await this.membership(owner, repo, n, p.id)) throw new Error("Project removal could not be verified.");
  }
  private async preflight(owner: string, repo: string, input: Input): Promise<void> {
    const base = this.path(owner, repo);
    if (input.labels) {
      const labels = await this.gh.api(`${base}/labels?per_page=100`);
      for (const name of input.labels) if (!labels.some((x: any) => x.name === name)) throw new Error(`Unknown label: ${name}`);
    }
    if (input.assignees) {
      for (const name of input.assignees) {
        if (!login.test(name)) throw new Error("Invalid assignee.");
        await this.gh.api(`${base}/assignees/${name}`);
      }
    }
    if (input.milestone_number != null) {
      await this.gh.api(`${base}/milestones/${input.milestone_number}`);
    }
    if (input.issue_type !== undefined) {
      const types = await this.gh.api(`orgs/${owner}/issue-types?per_page=100`);
      if (!Array.isArray(types) || !types.some((x: any) => x.name === input.issue_type && x.is_enabled !== false)) {
        throw new Error("Unknown or disabled issue type.");
      }
    }
  }
  private verify(actual: any, input: Input): void {
    const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const k of ["title", "body", "state", "state_reason"] as const) {
      if (has(input, k) && actual[k] !== input[k]) throw new Error(`Issue ${k} verification failed.`);
    }
    for (const k of ["labels", "assignees"] as const) {
      if (has(input, k)) {
        const values = (actual[k] ?? []).map((x: any) => (k === "labels" ? x.name : x.login).toLowerCase()).sort();
        if (!eq(values, input[k]!.map(x => x.toLowerCase()).sort())) throw new Error(`Issue ${k} verification failed.`);
      }
    }
    if (has(input, "milestone_number") && (actual.milestone?.number ?? null) !== input.milestone_number) throw new Error("Issue milestone verification failed.");
    if (has(input, "issue_type") && actual.type?.name !== input.issue_type) throw new Error("Issue type verification failed.");
  }
  private resolveField(p: any, name: string, value: string | number | null): { field: any; update: Record<string, unknown> | null; expected: unknown } {
    const field = p.fields.nodes.find((x: any) => x.name === name);
    if (!field) throw new Error("Project field not found.");
    let update: Record<string, unknown> | null = null;
    let expected: unknown = value;
    if (value !== null) {
      switch (field.dataType) {
        case "SINGLE_SELECT": {
          const option = field.options.find((x: any) => x.name === value);
          if (!option) throw new Error("Invalid single-select option.");
          update = { singleSelectOptionId: option.id }; expected = option.name; break;
        }
        case "ITERATION": {
          const iterations = [...field.configuration.iterations, ...field.configuration.completedIterations];
          const now = new Date();
          const matches = iterations.filter((x: any) => value === "@current"
            ? now >= new Date(x.startDate + "T00:00:00Z") && now < new Date(Date.parse(x.startDate + "T00:00:00Z") + x.duration * 86400000)
            : x.title === value);
          if (matches.length !== 1) throw new Error("Iteration must resolve to exactly one live schema entry.");
          update = { iterationId: matches[0].id }; expected = matches[0].title; break;
        }
        case "TEXT": if (typeof value !== "string") throw new Error("Text value must be a string."); update = { text: value }; break;
        case "NUMBER": if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Number value must be finite."); update = { number: value }; break;
        case "DATE": if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Date must be a valid YYYY-MM-DD."); update = { date: value }; break;
        default: throw new Error("Unsupported project field type.");
      }
    } else if (!["SINGLE_SELECT", "ITERATION", "TEXT", "NUMBER", "DATE"].includes(field.dataType)) {
      throw new Error("Unsupported project field type.");
    }
    return { field, update, expected };
  }
  private async setField(owner: string, repo: string, n: number, p: any, name: string, value: string | number | null): Promise<void> {
    const { field, update, expected } = this.resolveField(p, name, value);
    const itemId = await this.membership(owner, repo, n, p.id);
    if (!itemId) throw new Error("Issue is not in the project.");
    if (update === null) {
      await this.gh.graphql(`mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!){clearProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId}){projectV2Item{id}}}`, { projectId: p.id, itemId, fieldId: field.id });
    } else {
      await this.gh.graphql(`mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:$value}){projectV2Item{id}}}`, { projectId: p.id, itemId, fieldId: field.id, value: update });
    }
    const d = await this.gh.graphql(`query($id:ID!,$name:String!){node(id:$id){... on ProjectV2Item{fieldValueByName(name:$name){
      ... on ProjectV2ItemFieldSingleSelectValue{name}
      ... on ProjectV2ItemFieldIterationValue{title}
      ... on ProjectV2ItemFieldTextValue{text}
      ... on ProjectV2ItemFieldNumberValue{number}
      ... on ProjectV2ItemFieldDateValue{date}
    }}}}`, { id: itemId, name });
    if (!d.node) throw new Error("Project item verification failed.");
    const f = d.node?.fieldValueByName;
    const actual = f == null ? null : f.name ?? f.title ?? f.text ?? f.number ?? f.date ?? null;
    if (actual !== expected) throw new Error("Project field verification failed.");
  }

  async execute(input: Input): Promise<Result> {
    let progress: Record<string, unknown> = input.action === "create_issue" ? { mutation_attempted: false } : {};
    try {
      const { action, owner, repo, issue_number: n } = input;
      if ((input.title?.length ?? 0) > 256 || (input.body?.length ?? 0) > 65536 ||
          (input.query?.length ?? 0) > 1024 || (input.field_name?.length ?? 0) > 256 ||
          (typeof input.field_value === "string" && input.field_value.length > 65536) ||
          (input.labels?.length ?? 0) > 100 || (input.assignees?.length ?? 0) > 100 ||
          [...(input.labels ?? []), ...(input.assignees ?? [])].some(x => !x || x.length > 256)) {
        throw new Error("Input exceeds supported size limits.");
      }
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new Error("limit must be between 1 and 100.");
      for (const num of [n, input.project_number, input.source_project_number, input.parent_issue_number, input.milestone_number]) {
        if (num != null && (!Number.isSafeInteger(num) || num < 1)) throw new Error("Numbers must be positive integers.");
      }
      if (input.request_key !== undefined && !keyPattern.test(input.request_key)) throw new Error("Invalid request_key.");
      if (input.state_reason && input.state &&
        ((input.state === "open" && input.state_reason !== "reopened") ||
         (input.state === "closed" && input.state_reason === "reopened"))) {
        throw new Error("state_reason is incompatible with state.");
      }
      if (action === "session") {
        if (owner) this.checkOwner(owner);
        const user = await this.gh.api("user");
        return { ok: true, data: { user: { login: user.login, name: user.name ?? null } } };
      }
      this.checkOwner(owner);
      if (action === "list_projects") {
        const projects = [];
        for (const key of this.projects.filter(x => x.startsWith(owner.toLowerCase() + "/")).slice(0, input.limit ?? 100)) {
          projects.push(await this.project(owner, Number(key.split("/")[1])));
        }
        return { ok: true, data: { items: projects } };
      }
      if (["get_project", "list_project_items"].includes(action)) {
        this.checkProject(owner, input.project_number);
        const p = await this.project(owner, input.project_number);
        if (action === "get_project") return { ok: true, data: { project: p } };
        if (input.issue_number !== undefined) {
          if (action === "list_issue_types") {
            if (repo) this.checkRepo(owner, repo);
            return { ok: true, data: { items: await this.gh.api(`orgs/${owner}/issue-types?per_page=${input.limit ?? 50}`) } };
          }
          this.checkRepo(owner, repo);
          const itemId = await this.membership(owner, repo, input.issue_number, p.id);
          if (!itemId) return { ok: true, data: { items: [], has_more: false } };
          const item = await this.getIssue(owner, repo, input.issue_number);
          return { ok: true, data: { items: [{ id: itemId, number: item.number, title: item.title, url: item.url, issue_url: item.url, repo: `${owner}/${repo}` }], has_more: false } };
        }
        const d = await this.gh.graphql(`query($owner:String!,$number:Int!,$limit:Int!){organization(login:$owner){projectV2(number:$number){items(first:$limit){pageInfo{hasNextPage} nodes{id type content{
          ... on Issue{number title url repository{nameWithOwner}}
          ... on PullRequest{number title url repository{nameWithOwner}}
        }}}}}}`, { owner, number: input.project_number, limit: input.limit ?? 100 });
        const items = d.organization?.projectV2?.items;
        if (!items) throw new Error("Project items inaccessible.");
        return { ok: true, data: { items: items.nodes.filter((x: any) => x.content?.repository && this.repos.includes(x.content.repository.nameWithOwner.toLowerCase())).map((x: any) => ({ id: x.id, type: x.type, ...x.content, issue_url: x.content.url, repo: x.content.repository.nameWithOwner })), has_more: items.pageInfo.hasNextPage } };
      }
      if (action === "validate_project_field") {
        this.checkProject(owner, input.project_number);
        if (!input.field_name || !has(input, "field_value")) throw new Error("field_name and field_value are required.");
        const p = await this.project(owner, input.project_number);
        this.resolveField(p, input.field_name, input.field_value!);
        return { ok: true, data: { valid: true } };
      }
      this.checkRepo(owner, repo);
      const base = this.path(owner, repo);
      const limit = input.limit ?? 50;
      if (["list_assignees", "list_labels", "list_milestones"].includes(action)) {
        const name = action.slice(5);
        return { ok: true, data: { items: await this.gh.api(`${base}/${name}?per_page=${limit}`) } };
      }
      if (action === "list_issues") {
        const items = await this.gh.api(`${base}/issues?state=${input.state ?? "open"}&per_page=${limit}`);
        return { ok: true, data: { items: items.filter((x: any) => !x.pull_request).map(issue) } };
      }
      if (action === "search_issues") {
        let terms = input.query ?? "";
        const recovery = /^repo:([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+) is:issue "(SRE-Buddy reference: [A-Za-z0-9][A-Za-z0-9_.:-]{0,127})" in:body$/i.exec(terms);
        if (recovery) {
          if (`${recovery[1]}/${recovery[2]}`.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw new Error("Search repository does not match allowlist scope.");
          terms = `"${recovery[3]}" in:body`;
        } else if (/[:\r\n]/.test(terms)) throw new Error("Search qualifiers are not supported.");
        const q = `repo:${owner}/${repo} is:issue ${terms}`;
        const r = await this.gh.api(`search/issues?${new URLSearchParams({ q, per_page: String(limit) })}`);
        return { ok: true, data: { items: r.items.map(issue), total_count: r.total_count, incomplete_results: r.incomplete_results } };
      }
      if (action === "create_issue") {
        if (!input.title?.trim()) throw new Error("title is required.");
        await this.preflight(owner, repo, input);
        const reference = input.request_key ? `SRE-Buddy reference: ${input.request_key}` : undefined;
        if (reference) {
          const q = `repo:${owner}/${repo} is:issue in:body "${reference}"`;
          const found = await this.gh.api(`search/issues?${new URLSearchParams({ q, per_page: "100" })}`);
          if (found.incomplete_results || found.total_count > 100) throw new Error("Duplicate recovery search is incomplete.");
          const matches = found.items.filter((x: any) => x.body?.split(/\r?\n/).includes(reference));
          if (matches.length > 1) throw new Error("Multiple issues match request_key.");
          if (matches.length === 1) return { ok: true, data: { issue: issue(matches[0]), recovered: true } };
        }
        const body = reference && !input.body?.split(/\r?\n/).includes(reference)
          ? `${input.body ?? ""}${input.body ? "\n\n" : ""}${reference}` : input.body;
        const payload: Record<string, unknown> = { title: input.title };
        for (const k of ["labels", "assignees", "state", "state_reason", "issue_type"] as const) if (has(input, k)) payload[k === "issue_type" ? "type" : k] = input[k];
        if (body !== undefined) payload.body = body;
        if (has(input, "milestone_number")) payload.milestone = input.milestone_number;
        progress = { mutation_attempted: true };
        const created = issue(await this.gh.api(`${base}/issues`, "POST", payload));
        progress = { mutation_attempted: true, issue: created };
        const verified = await this.getIssue(owner, repo, created.number);
        this.verify(verified, body === undefined ? input : { ...input, body });
        return { ok: true, data: { issue: verified, recovered: false } };
      }
      if (!n) throw new Error("issue_number is required.");
      if (action === "get_issue") return { ok: true, data: { issue: await this.getIssue(owner, repo, n) } };
      if (action === "list_comments") return { ok: true, data: { items: await this.gh.api(`${base}/issues/${n}/comments?per_page=${limit}`) } };
      if (action === "update_issue") {
        await this.getIssue(owner, repo, n);
        await this.preflight(owner, repo, input);
        if (has(input, "title") && !input.title?.trim()) throw new Error("title must not be empty.");
        const payload: Record<string, unknown> = {};
        for (const k of ["title", "body", "labels", "assignees", "state", "state_reason", "issue_type"] as const) if (has(input, k)) payload[k === "issue_type" ? "type" : k] = input[k];
        if (has(input, "milestone_number")) payload.milestone = input.milestone_number;
        if (!Object.keys(payload).length) throw new Error("No issue fields supplied.");
        progress = { issue: issue(await this.gh.api(`${base}/issues/${n}`, "PATCH", payload)) };
        const verified = await this.getIssue(owner, repo, n);
        this.verify(verified, input);
        return { ok: true, data: { issue: verified } };
      }
      if (["add_comment", "link_issue", "link_pr"].includes(action)) {
        await this.getIssue(owner, repo, n);
        let body = input.body;
        if (action !== "add_comment") {
          let u: URL;
          try { u = new URL(input.related_url ?? ""); } catch { throw new Error("Invalid related URL."); }
          const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d*)\/?$/.exec(u.pathname);
          if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port || u.username || u.password || u.search || u.hash || !match || match[3] !== (action === "link_pr" ? "pull" : "issues")) throw new Error("Invalid related GitHub URL.");
          this.checkOwner(match[1]); this.checkRepo(match[1], match[2]);
          body = `Related ${action === "link_pr" ? "pull request" : "issue"}: ${u.toString()}`;
        }
        if (!body?.trim()) throw new Error("body is required.");
        const comment = await this.gh.api(`${base}/issues/${n}/comments`, "POST", { body });
        progress = { comment };
        const verified = await this.gh.api(`${base}/issues/comments/${comment.id}`);
        if (verified.body !== body) throw new Error("Comment verification failed.");
        return { ok: true, data: { comment: verified } };
      }
      if (["add_to_project", "remove_from_project", "move_project", "set_project_field"].includes(action)) {
        this.checkProject(owner, input.project_number);
        if (action === "move_project") this.checkProject(owner, input.source_project_number);
        const p = await this.project(owner, input.project_number);
        if (action === "add_to_project") return { ok: true, data: { item_id: await this.add(owner, repo, n, p) } };
        if (action === "remove_from_project") { await this.remove(owner, repo, n, p); return { ok: true, data: { removed: true } }; }
        if (action === "move_project") {
          if (input.source_project_number === input.project_number) throw new Error("Source and destination must differ.");
          const source = await this.project(owner, input.source_project_number!);
          progress = { destination_add_attempted: true, source_removed: false };
          const id = await this.add(owner, repo, n, p);
          progress = { destination_add_attempted: true, destination_added: true, item_id: id, source_removed: false };
          progress = { ...progress, source_removal_attempted: true, source_removed: null };
          await this.remove(owner, repo, n, source);
          return { ok: true, data: { ...progress, source_removed: true } };
        }
        if (!input.field_name || !has(input, "field_value")) throw new Error("field_name and field_value are required.");
        await this.setField(owner, repo, n, p, input.field_name, input.field_value!);
        return { ok: true, data: { updated: true } };
      }
      if (action === "set_parent" || action === "remove_parent") {
        if (action === "set_parent" && (!input.parent_issue_number || input.parent_issue_number === n)) throw new Error("A different parent_issue_number is required.");
        const getParent = async () => {
          const d = await this.gh.graphql(`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){id parent{id number repository{nameWithOwner}}}}}`, { owner, repo, number: n });
          if (!d.repository?.issue) throw new Error("Issue not found or inaccessible.");
          return d.repository.issue;
        };
        const child = await getParent();
        const current = child.parent;
        if (current && current.repository.nameWithOwner.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw new Error("Existing parent belongs to another repository.");
        if (action === "remove_parent") {
          if (!current?.number) return { ok: true, data: { removed: true } };
          await this.gh.api(`${base}/issues/${current.number}/sub_issue`, "DELETE", { sub_issue_id: (await this.getIssue(owner, repo, n)).id });
        } else {
          if (current?.number === input.parent_issue_number) return { ok: true, data: { parent: current } };
          if (current) throw new Error("Issue already has a different parent; remove it first.");
          await this.gh.api(`${base}/issues/${input.parent_issue_number}/sub_issues`, "POST", { sub_issue_id: (await this.getIssue(owner, repo, n)).id });
        }
        const parent = (await getParent()).parent;
        if (action === "set_parent" ? parent?.number !== input.parent_issue_number : Boolean(parent?.number)) throw new Error("Parent verification failed.");
        return { ok: true, data: { parent: parent ?? null } };
      }
      throw new Error("Unsupported action.");
    } catch (error) {
      return { ok: false, ...(Object.keys(progress).length ? { data: progress } : {}), error: error instanceof Error ? error.message : "GitHub operation failed." };
    }
  }
}
