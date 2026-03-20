#!/usr/bin/env node

import { Sentry } from './instrumentation.js';
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from './logger.js';
import { createServer } from "./mcp-proxy.js";

async function main() {
  const transport = new StdioServerTransport();
  const { server, cleanup } = await createServer();

  await server.connect(transport);

  process.on("SIGINT", async () => {
    await cleanup();
    await server.close();
    Sentry.profiler.stopProfiler();
    await Sentry.close(2000);
    process.exit(0);
  });
}

main().catch((error) => {
  Sentry.captureException(error);
  logger.error("Server error:", error.message);
  Sentry.close(2000).finally(() => process.exit(1));
});
