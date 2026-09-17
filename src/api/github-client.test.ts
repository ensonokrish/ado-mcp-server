import assert from "node:assert/strict";
import test from "node:test";
import { GithubClient } from "./github-client.js";

test("createIssue sends the expected authenticated REST request", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({
      number: 42,
      title: "Q4 work",
      body: "details",
      state: "open",
      html_url: "https://github.com/dfinsolutions/cloudops/issues/42",
      labels: [], assignees: [], created_at: "2026-09-17T00:00:00Z", updated_at: "2026-09-17T00:00:00Z", milestone: null, user: { login: "user" },
    }), { status: 201 });
  };
  try {
    const client = new GithubClient("test-token");
    const issue = await client.createIssue("dfinsolutions", "cloudops", { title: "Q4 work", labels: ["type:task"] });
    assert.equal(issue.number, 42);
    assert.equal(request?.url, "https://api.github.com/repos/dfinsolutions/cloudops/issues");
    assert.equal(request?.init?.method, "POST");
    assert.equal((request?.init?.headers as Record<string, string>).Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(String(request?.init?.body)), { title: "Q4 work", labels: ["type:task"] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getProjectContext exposes live Status options", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      organization: {
        projectV2: {
          id: "PVT_kwDO", number: 52, title: "Ensono CloudOps Team", url: "https://github.com/orgs/dfinsolutions/projects/52",
          fields: { nodes: [
            { id: "PVTSSF_status", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "backlog", name: "Backlog" }, { id: "done", name: "Done" }] },
          ] },
        },
      },
    },
  }), { status: 200 });
  try {
    const context = await new GithubClient("test-token").getProjectContext("dfinsolutions", 52);
    assert.equal(context.id, "PVT_kwDO");
    assert.deepEqual(context.fields[0].options.map((option) => option.name), ["Backlog", "Done"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});