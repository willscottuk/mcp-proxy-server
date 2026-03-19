# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Build (compiles TypeScript to build/)
npm run build

# Development - Stdio mode (auto-restarts on changes)
npm run dev

# Development - SSE/HTTP mode with Admin UI
ENABLE_ADMIN_UI=true npm run dev:sse

# Watch and rebuild
npm run watch

# Debug with MCP Inspector (Stdio mode)
npm run inspector
```

There is no test suite.

## Architecture

This project is a Model Context Protocol (MCP) proxy that aggregates multiple backend MCP servers and exposes them through a single unified interface.

### Two entry points, one core

- **`src/index.ts`** — Stdio mode: wraps `createServer()` in a `StdioServerTransport`
- **`src/sse.ts`** — SSE/HTTP mode: Express server exposing `/sse` and `/mcp` endpoints, Admin UI, session auth, and install management

Both entry points use `createServer()` from `src/mcp-proxy.ts`.

### Core modules

- **`src/mcp-proxy.ts`** — The heart of the proxy. Maintains module-level maps (`toolToClientMap`, `resourceToClientMap`, `promptToClientMap`) that route incoming MCP requests to the correct backend client. Implements retry logic with exponential backoff for all three transport types (Stdio/SSE/HTTP). SSE backends are **always force-reconnected** before each tool call attempt (first attempt included), not just on error.

- **`src/client.ts`** — Creates `ConnectedClient` instances wrapping the MCP SDK's `Client` class. Handles transport construction for all three types and implements `reconnectSingleClient()` for per-server reconnection.

- **`src/config.ts`** — Loads `config/mcp_server.json` and `config/tool_config.json` from `process.cwd()/config/`. Environment variables override proxy retry settings from the JSON file. Exports type guards (`isSSEConfig`, `isStdioConfig`, `isHttpConfig`).

- **`src/logger.ts`** — Logging utility controlled by the `LOGGING` env var (error/warn/info/debug).

- **`src/terminal.ts`** — Web terminal using `node-pty`, served through the Admin UI.

### Tool naming

Tools are qualified as `<serverKey><separator><originalToolName>` (default separator: `__`, e.g. `my-server__tool-name`). This qualified name is the key in `toolToClientMap` and in `config/tool_config.json`. The `ToolSettings` interface uses `exposedName` and `exposedDescription` (not `displayName`/`description`) to override what clients see.

### Config files (runtime, not source)

- `config/mcp_server.json` — Backend server definitions (type, command/url, auth, install config)
- `config/tool_config.json` — Per-tool enable/disable and name/description overrides; managed via Admin UI
- `config/.session_secret` — Auto-generated session secret if `SESSION_SECRET` env var is not set

### Admin UI (SSE mode only)

Set `ENABLE_ADMIN_UI=true`. Static files are served from `public/`. The UI calls REST endpoints in `src/sse.ts` to reload config, trigger installations, and manage tools. Config reloads call `updateBackendConnections()` which diffs the current vs. new server list and only connects/disconnects what changed.
