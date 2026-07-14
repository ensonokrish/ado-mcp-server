const readline = require("readline");
const { execSync, spawnSync } = require("child_process");
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

/**
 * Ask for sensitive input with masked echo (shows * instead of characters).
 */
function askSecret(question, tooltip) {
  return new Promise((resolve) => {
    const prompt = tooltip ? `${question}\n  (${tooltip})\n  > ` : `${question}\n  > `;
    process.stdout.write(prompt);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let secret = "";
    const onData = (ch) => {
      const c = ch.toString("utf8");
      if (c === "\n" || c === "\r" || c === "\u0004") {
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(secret.trim());
      } else if (c === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (c === "\u007f" || c === "\b") {
        // Backspace
        if (secret.length > 0) {
          secret = secret.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        secret += c;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
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

  const pat = await askSecret(
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
    // Use spawnSync with stdin input to avoid PAT appearing in process args or shell history
    const result = spawnSync("node", [distIndex], {
      input: payload + "\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0 && result.stderr) {
      throw new Error(result.stderr);
    }
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
