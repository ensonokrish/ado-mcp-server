import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Handle graceful shutdown
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);

  // SIGTERM is unreliable on Windows; use 'exit' as a fallback
  if (process.platform !== "win32") {
    process.on("SIGTERM", shutdown);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
