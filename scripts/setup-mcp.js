const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const distIndex = path.join(repoRoot, "dist", "index.js").replace(/\\/g, "/");

// Create .vscode/mcp.json in this repo
const vscodeDir = path.join(repoRoot, ".vscode");
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

if (!fs.existsSync(vscodeDir)) {
  fs.mkdirSync(vscodeDir, { recursive: true });
}

fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
console.log(`[ado-mcp-server] MCP config written to: ${mcpJsonPath}`);
console.log(`[ado-mcp-server] Server path: ${distIndex}`);
