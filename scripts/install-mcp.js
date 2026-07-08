const fs = require("fs");
const path = require("path");

const targetWorkspace = process.argv[2];

if (!targetWorkspace) {
  console.log("Usage: node scripts/install-mcp.js <target-workspace-path>");
  console.log("Example: node scripts/install-mcp.js C:\\Repos\\dfin-harness-pipelines");
  process.exit(1);
}

const resolvedTarget = path.resolve(targetWorkspace);
if (!fs.existsSync(resolvedTarget)) {
  console.error(`Error: Target workspace does not exist: ${resolvedTarget}`);
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, "..");
const distIndex = path.join(repoRoot, "dist", "index.js").replace(/\\/g, "/");

const vscodeDir = path.join(resolvedTarget, ".vscode");
const mcpJsonPath = path.join(vscodeDir, "mcp.json");

const mcpConfig = {
  servers: {
    "ado-mcp-server": {
      type: "stdio",
      command: "node",
      args: [distIndex],
    },
  },
};

// Merge with existing mcp.json if present
if (fs.existsSync(mcpJsonPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
    if (existing.servers) {
      existing.servers["ado-mcp-server"] = mcpConfig.servers["ado-mcp-server"];
      fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + "\n");
      console.log(`[ado-mcp-server] Added to existing MCP config: ${mcpJsonPath}`);
      process.exit(0);
    }
  } catch (e) {
    // If parse fails, overwrite
  }
}

if (!fs.existsSync(vscodeDir)) {
  fs.mkdirSync(vscodeDir, { recursive: true });
}

fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
console.log(`[ado-mcp-server] MCP config installed to: ${mcpJsonPath}`);
console.log(`[ado-mcp-server] Server path: ${distIndex}`);
