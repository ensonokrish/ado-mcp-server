const { execSync } = require("child_process");
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
  const result = execSync(`echo '${payload}' | node "${distIndex}"`, {
    encoding: "utf8",
    shell: "powershell.exe",
  });
  console.log("Disconnected from Azure DevOps.");
} catch (err) {
  console.log("Disconnected (or was not connected).");
}
