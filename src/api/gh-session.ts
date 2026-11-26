import { execFile } from "node:child_process";

export type GhRunner = (args: string[], input?: string) => Promise<string>;

export const runGh: GhRunner = (args, input) => new Promise((resolve, reject) => {
  if (process.env.GH_TOKEN !== undefined || process.env.GITHUB_TOKEN !== undefined) {
    reject(new Error("GH_TOKEN and GITHUB_TOKEN must be unset for GitHub CLI session authentication."));
    return;
  }
  const child = execFile("gh", args, {
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
  }, (error, stdout, stderr) => {
    if (error) {
      const status = /HTTP (\d{3})/.exec(stderr)?.[1];
      reject(new Error(`GitHub CLI request failed${status ? ` (HTTP ${status})` : ""}; check gh authentication, access, network and project permissions.`));
      return;
    }
    resolve(stdout);
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(input);
});

export class GhSession {
  private authenticated = false;
  constructor(private readonly run: GhRunner = runGh) {}

  private async ensureSession(): Promise<void> {
    if (this.authenticated) return;
    const output = await this.run(["auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"]);
    let status: any;
    try { status = JSON.parse(output); } catch { throw new Error("Cannot verify GitHub CLI session storage."); }
    const accounts = status?.hosts?.["github.com"];
    const active = Array.isArray(accounts) ? accounts.filter((x: any) => x.active === true) : [];
    if (active.length !== 1 || active[0].state !== "success") {
      throw new Error("No valid active github.com CLI session; authenticate outside this server.");
    }
    if (active[0].tokenSource !== "keyring") {
      throw new Error("GitHub CLI session must use secure keyring storage; plaintext or unknown storage is refused.");
    }
    this.authenticated = true;
  }

  async api(path: string, method = "GET", data?: unknown): Promise<any> {
    await this.ensureSession();
    const args = ["api", "--hostname", "github.com", "--method", method,
      "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2022-11-28"];
    if (data !== undefined) args.push("--input", "-");
    args.push(path);
    const output = await this.run(args, data === undefined ? undefined : JSON.stringify(data));
    if (!output.trim()) return null;
    try {
      return JSON.parse(output);
    } catch {
      throw new Error("GitHub CLI returned invalid JSON.");
    }
  }

  async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    const result = await this.api("graphql", "POST", { query, variables });
    if (result.errors?.length || !result.data) {
      throw new Error("GitHub GraphQL request failed; check access and project permissions.");
    }
    return result.data;
  }
}
