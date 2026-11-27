import assert from "node:assert/strict";
import test from "node:test";
import { GhSession, runGh } from "./gh-session.js";
import { GithubWork } from "./github-work.js";
import { createGithubServer } from "../github-index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const env = { SRE_BUDDY_GITHUB_ALLOWED_REPOSITORIES: '["org/repo"]', SRE_BUDDY_GITHUB_ALLOWED_PROJECTS: '["org/1","org/2"]' };
const sample = { number: 7, id: 700, title: "title", body: "details", state: "open", html_url: "https://github.com/org/repo/issues/7", labels: [], assignees: [] };
function fake(handler: (path: string, method: string, data: any) => any): GhSession {
  return new GhSession(async (args, stdin) => {
    if (args[0] === "auth") return JSON.stringify({ hosts: { "github.com": [{ active: true, state: "success", tokenSource: "keyring" }] } });
    const path = args[args.length - 1];
    const method = args[args.indexOf("--method") + 1];
    return JSON.stringify(await handler(path, method, stdin ? JSON.parse(stdin) : undefined));
  });
}

test("transport passes JSON via stdin with fixed host and reports errors without leaking output", async () => {
  let captured: { args: string[]; input?: string } | undefined;
  const gh = new GhSession(async (args, input) => {
    if (args[0] === "auth") return JSON.stringify({ hosts: { "github.com": [{ active: true, state: "success", tokenSource: "keyring" }] } });
    captured = { args, input }; return '{"number":1}';
  });
  const body = '"; $(echo secret) \n test';
  await gh.api("repos/org/repo/issues", "POST", { body });
  assert.equal(captured?.args.includes(body), false);
  assert.equal(captured?.args[captured.args.indexOf("--hostname") + 1], "github.com");
  assert.deepEqual(JSON.parse(captured!.input!), { body });
  const status = JSON.stringify({ hosts: { "github.com": [{ active: true, state: "success", tokenSource: "keyring" }] } });
  await assert.rejects(new GhSession(async args => args[0] === "auth" ? status : "not json").api("user"), /invalid JSON/);
  await assert.rejects(new GhSession(async args => args[0] === "auth" ? status : '{"errors":[{"message":"secret"}]}').graphql("query{}", {}), e => e instanceof Error && !e.message.includes("secret"));
});

test("session verification refuses plaintext, missing, expired and malformed auth status", async () => {
  for (const account of [
    { active: true, state: "success", tokenSource: "oauth_token" },
    { active: true, state: "failure", tokenSource: "keyring" },
    { active: false, state: "success", tokenSource: "keyring" },
  ]) {
    let calls = 0;
    const gh = new GhSession(async () => { calls++; return JSON.stringify({ hosts: { "github.com": [account] } }); });
    await assert.rejects(gh.api("user"));
    assert.equal(calls, 1);
  }
  await assert.rejects(new GhSession(async () => "garbage").api("user"), /verify/);
});

test("token overrides are rejected before gh is launched", async () => {
  const old = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "secret";
  try { await assert.rejects(runGh(["api", "user"]), /must be unset/); }
  finally { if (old === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = old; }
});

test("allowlists fail closed before access and recovery search cannot widen repository scope", async () => {
  let calls = 0;
  const service = new GithubWork(fake(() => { calls++; return {}; }), env);
  assert.equal((await service.execute({ action: "get_issue", owner: "org", repo: "other", issue_number: 1 })).ok, false);
  assert.equal((await service.execute({ action: "get_project", owner: "org", project_number: 3 })).ok, false);
  assert.equal((await service.execute({ action: "search_issues", owner: "org", repo: "repo", query: 'repo:other/repo is:issue "SRE-Buddy reference: k" in:body' })).ok, false);
  assert.equal(calls, 0);
  assert.throws(() => new GithubWork(fake(() => ({})), { SRE_BUDDY_GITHUB_ALLOWED_REPOSITORIES: '["org/repo/extra"]' }), /allowlist/);
});

test("create recovers exact marker without writing, and does not append an existing marker twice", async () => {
  let writes = 0;
  let existing = true;
  const body = "details\n\nSRE-Buddy reference: request-1";
  const gh = fake((path, method, data) => {
    if (path.startsWith("search/issues")) return { total_count: existing ? 1 : 0, items: existing ? [{ ...sample, body }] : [], incomplete_results: false };
    if (method === "POST") { writes++; assert.equal(data.body, body); return { ...sample, body }; }
    return { ...sample, body };
  });
  const service = new GithubWork(gh, env);
  const input = { action: "create_issue", owner: "org", repo: "repo", title: "title", body, request_key: "request-1" };
  const recovered = await service.execute(input);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data?.recovered, true);
  assert.equal(writes, 0);
  existing = false;
  assert.equal((await service.execute(input)).ok, true);
  assert.equal(writes, 1);
});

test("create exposes issue if verification fails", async () => {
  const gh = fake((path, method) => {
    if (method === "POST") return sample;
    throw new Error("read unavailable");
  });
  const result = await new GithubWork(gh, env).execute({ action: "create_issue", owner: "org", repo: "repo", title: "title" });
  assert.equal(result.ok, false);
  assert.equal((result.data?.issue as any).url, sample.html_url);
});

test("create distinguishes preflight rejection from uncertain dispatch", async () => {
  const service = new GithubWork(fake((_path, method) => {
    if (method === "POST") throw new Error("transport lost");
    return [];
  }), env);
  const preflight = await service.execute({ action: "create_issue", owner: "org", repo: "repo", title: "x", labels: ["missing"] });
  assert.deepEqual(preflight.data, { mutation_attempted: false });
  const uncertain = await service.execute({ action: "create_issue", owner: "org", repo: "repo", title: "x" });
  assert.deepEqual(uncertain.data, { mutation_attempted: true });
});

test("move verifies destination before removing source and reports partial progress", async () => {
  let destinationAdded = false;
  const gh = fake((path, method, data) => {
    assert.equal(path, "graphql");
    const q: string = data.query;
    if (q.includes("projectV2(number")) return { data: { organization: { projectV2: { id: `P${data.variables.number}`, fields: { nodes: [], pageInfo: { hasNextPage: false } } } } } };
    if (q.includes("projectItems(first")) return { data: { repository: { issue: { id: "I", projectItems: { pageInfo: { hasNextPage: false }, nodes: destinationAdded ? [{ id: "D", project: { id: "P2" } }, { id: "S", project: { id: "P1" } }] : [{ id: "S", project: { id: "P1" } }] } } } } };
    if (q.includes("addProjectV2ItemById")) { destinationAdded = true; return { data: { addProjectV2ItemById: { item: { id: "D" } } } }; }
    if (q.includes("deleteProjectV2Item")) { assert.equal(destinationAdded, true); throw new Error("source removal failed"); }
    return { data: { repository: { issue: { id: "I" } } } };
  });
  const result = await new GithubWork(gh, env).execute({ action: "move_project", owner: "org", repo: "repo", issue_number: 7, project_number: 2, source_project_number: 1 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.data, { destination_add_attempted: true, destination_added: true, item_id: "D", source_removal_attempted: true, source_removed: null });
});

test("field schema and assignee preflight reject invalid writes", async () => {
  let mutations = 0;
  const gh = fake((path, method, data) => {
    if (method !== "GET" && path !== "graphql") { mutations++; return {}; }
    if (path.includes("/assignees/")) throw new Error("not assignable");
    if (data?.query?.includes("projectV2(number")) return { data: { organization: { projectV2: { id: "P1", fields: { pageInfo: { hasNextPage: false }, nodes: [{ id: "F", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "A", name: "Ready" }] }] } } } } };
    if (data?.query?.includes("projectItems(first")) return { data: { repository: { issue: { projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: "I", project: { id: "P1" } }] } } } } };
    return sample;
  });
  const service = new GithubWork(gh, env);
  assert.equal((await service.execute({ action: "create_issue", owner: "org", repo: "repo", title: "x", assignees: ["bad"] })).ok, false);
  assert.equal((await service.execute({ action: "set_project_field", owner: "org", repo: "repo", issue_number: 7, project_number: 1, field_name: "Status", field_value: "Wrong" })).ok, false);
  assert.equal(mutations, 0);
});

test("project field updates use live option IDs and verify the resulting value", async () => {
  let write: any;
  const gh = fake((_path, _method, data) => {
    const q: string = data.query;
    if (q.includes("projectV2(number")) return { data: { organization: { projectV2: { id: "P1", fields: { pageInfo: { hasNextPage: false }, nodes: [{ id: "F", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "A", name: "Ready" }] }] } } } } };
    if (q.includes("projectItems(first")) return { data: { repository: { issue: { projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: "I", project: { id: "P1" } }] } } } } };
    if (q.includes("updateProjectV2ItemFieldValue")) { write = data.variables.value; return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "I" } } } }; }
    return { data: { node: { fieldValueByName: { name: "Ready" } } } };
  });
  const result = await new GithubWork(gh, env).execute({ action: "set_project_field", owner: "org", repo: "repo", issue_number: 7, project_number: 1, field_name: "Status", field_value: "Ready" });
  assert.equal(result.ok, true);
  assert.deepEqual(write, { singleSelectOptionId: "A" });
  const validation = await new GithubWork(gh, env).execute({ action: "validate_project_field", owner: "org", project_number: 1, field_name: "Status", field_value: "Ready" });
  assert.deepEqual(validation, { ok: true, data: { valid: true } });
  const invalid = await new GithubWork(gh, env).execute({ action: "validate_project_field", owner: "org", project_number: 1, field_name: "Status", field_value: "Nope" });
  assert.equal(invalid.ok, false);
});

test("session and recovery search return the coordinated data shapes", async () => {
  const gh = fake((path) => {
    if (path === "user") return { login: "alice", name: "Alice" };
    const q = new URLSearchParams(path.split("?")[1]).get("q");
    assert.equal(q, 'repo:org/repo is:issue "SRE-Buddy reference: k" in:body');
    return { items: [sample], total_count: 1, incomplete_results: false };
  });
  const service = new GithubWork(gh, env);
  assert.deepEqual((await service.execute({ action: "session", owner: "org" })).data, { user: { login: "alice", name: "Alice" } });
  const result = await service.execute({ action: "search_issues", owner: "org", repo: "repo", query: 'repo:org/repo is:issue "SRE-Buddy reference: k" in:body' });
  assert.equal(((result.data?.items as any[])[0]).url, sample.html_url);
});

test("MCP tool returns JSON success and structured errors", async () => {
  const service = new GithubWork(fake(path => path === "user" ? { login: "alice", name: null } : sample), env);
  const server = createGithubServer(() => service);
  const client = new Client({ name: "test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const ok = await client.callTool({ name: "github_work", arguments: { action: "session", owner: "org" } });
    assert.equal(ok.isError, false);
    assert.deepEqual(JSON.parse((ok.content as any[])[0].text), { ok: true, data: { user: { login: "alice", name: null } } });
    const failed = await client.callTool({ name: "github_work", arguments: { action: "create_issue", owner: "org", repo: "nope", title: "x" } });
    assert.equal(failed.isError, true);
    const result = JSON.parse((failed.content as any[])[0].text);
    assert.equal(result.ok, false);
    assert.equal(result.data.mutation_attempted, false);
    const invalid = await client.callTool({ name: "github_work", arguments: { action: "create_issue", owner: "org", issue_number: -1 } });
    assert.equal(invalid.isError, true);
    assert.deepEqual(JSON.parse((invalid.content as any[])[0].text), { ok: false, data: { mutation_attempted: false }, error: "Invalid github_work arguments." });
  } finally { await client.close(); await server.close(); }
});
