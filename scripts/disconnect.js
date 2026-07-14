const { spawnSync } = require("child_process");
const path = require("path");

const distIndex = path.join(__dirname, "..", "dist", "index.js");
const payload = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "disconnect",
    arguments: {},
  },
});

try {
  // Use spawnSync with stdin pipe (no shell command-line exposure)
  const result = spawnSync("node", [distIndex], {
    input: payload + "\n",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  console.log("Disconnected from Azure DevOps.");
  console.log("Note: This only affects terminal-based sessions.");
  console.log("VS Code chat sessions disconnect via the 'disconnect' tool in chat.");
} catch (err) {
  console.log("Disconnected (or was not connected).");
}
