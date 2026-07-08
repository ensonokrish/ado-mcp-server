const readline = require("readline");
const { execSync } = require("child_process");
const path = require("path");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question, tooltip) {
  return new Promise((resolve) => {
    const prompt = tooltip ? `${question}\n  (${tooltip})\n  > ` : `${question}\n  > `;
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  console.log("============================================================");
  console.log("ADO MCP Server - First Time Connection Setup");
  console.log("============================================================\n");

  const organization = await ask(
    "1. Organization name:",
    "Your Azure DevOps org name, e.g., 'DFIN' from https://dev.azure.com/DFIN"
  );

  const pat = await ask(
    "2. Personal Access Token (PAT):",
    "Generate at https://dev.azure.com/<org>/_usersSettings/tokens. Needs Work Items (Read/Write/Manage) + Project and Team (Read)"
  );

  const project = await ask(
    "3. Default project:",
    "The ADO project to use by default, e.g., 'SRE Operations and BAU'"
  );

  const profileName = await ask(
    "4. Save profile as:",
    "A short name to recall this connection later, e.g., 'dfin'"
  );

  rl.close();

  console.log("\nConnecting to Azure DevOps...\n");

  const distIndex = path.join(__dirname, "..", "dist", "index.js");
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "connect",
      arguments: {
        organization,
        pat,
        project,
        save_as: profileName,
      },
    },
  });

  try {
    const result = execSync(`echo '${payload}' | node "${distIndex}"`, {
      encoding: "utf8",
      shell: "powershell.exe",
    });
    console.log("Connection successful!");
    console.log("Profile saved to system keychain.\n");
    console.log("You can now use in VS Code chat:");
    console.log(`  "connect with profile ${profileName}"`);
    console.log('  "show my work items"');
  } catch (err) {
    console.error("Connection failed:", err.message);
    process.exit(1);
  }
}

main();
