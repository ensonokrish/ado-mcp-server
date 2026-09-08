const readline = require("readline");
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

/** Masked input — shows * instead of characters. */
function askSecret(question, tooltip) {
  return new Promise((resolve) => {
    const prompt = tooltip ? `${question}\n  (${tooltip})\n  > ` : `${question}\n  > `;
    process.stdout.write(prompt);

    // Pause readline so it doesn't consume raw keystrokes
    rl.pause();

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let secret = "";
    const onData = (ch) => {
      const c = ch.toString("utf8");
      if (c === "\n" || c === "\r" || c === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        rl.resume();
        resolve(secret.trim());
      } else if (c === "\u0003") {
        process.exit(1);
      } else if (c === "\u007f" || c === "\b") {
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
  console.log("ADO MCP Server - GitHub Token Setup");
  console.log("============================================================");
  console.log("");
  console.log("This saves your GitHub PAT to Windows Credential Manager.");
  console.log("The token is never written to disk or shown in logs.");
  console.log("");
  console.log("Required GitHub PAT scopes:");
  console.log("  Classic token : repo  +  read:project");
  console.log("  Fine-grained  : Issues (Read)  +  Projects (Read)");
  console.log("");
  console.log("Create one at: https://github.com/settings/tokens");
  console.log("");

  const token = await askSecret(
    "Paste your GitHub Personal Access Token",
    "Input is masked — characters will show as *"
  );

  if (!token) {
    console.error("No token entered. Aborting.");
    rl.close();
    process.exit(1);
  }

  // Verify the token against the GitHub API before saving
  process.stdout.write("\nVerifying token with GitHub... ");
  let login, name;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const user = await res.json();
    login = user.login;
    name = user.name;
    console.log("OK");
  } catch (err) {
    console.log("FAILED");
    console.error(`\nToken verification failed: ${err.message}`);
    console.error("Check that the token is valid and has the required scopes.");
    rl.close();
    process.exit(1);
  }

  // Save to keychain using keytar
  const keytarPath = path.join(__dirname, "..", "node_modules", "keytar");
  const keytar = require(keytarPath);
  await keytar.setPassword("ado-mcp-server", "github:token", token);

  console.log("");
  console.log("============================================================");
  console.log(`Connected as: ${login}${name ? ` (${name})` : ""}`);
  console.log("Token saved to Windows Credential Manager.");
  console.log("");
  console.log('In VS Code chat, just say "connect_github" — no token needed.');
  console.log("============================================================");

  rl.close();
}

main().catch((err) => {
  console.error("Unexpected error:", err.message);
  rl.close();
  process.exit(1);
});
