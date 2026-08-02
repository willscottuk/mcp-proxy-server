import { DEFAULT_REQUEST_TIMEOUT_MSEC, ProtocolError, Server, Tool } from "@modelcontextprotocol/server";
import {
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListResourceTemplatesResultSchema,
  GetPromptResultSchema,
  ResultSchema
} from "@modelcontextprotocol/core";
import { createClients, ConnectedClient, reconnectSingleClient } from './client.js';
import { logger, addBreadcrumbSink, addMcpNotificationSink } from './logger.js';
import { Config, loadConfig, TransportConfig, isSSEConfig, isStdioConfig, isHttpConfig, ToolConfig, loadToolConfig, DEFAULT_SERVER_TOOLNAME_SEPERATOR } from './config.js';
import * as eventsource from 'eventsource';
import { isSentryEnabled, Sentry } from './instrumentation.js';
import { sendToolCallNotification } from './slack-webhook.js';
import { wrapMcpServerWithSentry } from '@sentry/node';

global.EventSource = eventsource.EventSource;

// --- Shared State ---
// Keep track of connected clients and the maps globally within this module
let currentConnectedClients: ConnectedClient[] = [];
type ToolMapEntry = { client: ConnectedClient, toolInfo: Tool, mcpHeaderMappings: McpHeaderMapping[] };
const toolToClientMap = new Map<string, ToolMapEntry>(); // Store full tool info
const resourceToClientMap = new Map<string, ConnectedClient>();
const promptToClientMap = new Map<string, ConnectedClient>();
let notificationServer: Server | undefined;
let lastToolListFingerprint = '';
let currentToolConfig: ToolConfig = { tools: {} }; // Store loaded tool config
let currentActiveServersConfig: Record<string, TransportConfig> = {}; // Added for retry logic
let currentSeparator: string = DEFAULT_SERVER_TOOLNAME_SEPERATOR; // Store the current separator
type ToolType = 'read' | 'write' | 'destructive';
type ServerHealth = 'inactive' | 'checking' | 'connected' | 'error';
type ToolCatalogueEntry = ToolMapEntry & { qualifiedName: string; proxyState: 'exposed' | 'disabled' | 'rejected'; rejectionReason?: string };
const serverHealth = new Map<string, { state: ServerHealth; checkedAt: string; error?: string }>();
const toolCatalogue = new Map<string, ToolCatalogueEntry>();

const TOOLS_LIST_TTL_MS = 300_000;
const TOOLS_LIST_PAGE_SIZE = 1_000;
const MCP_HEADER_NAME_PATTERN = /^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/;
const MAX_SAFE_JSON_INTEGER = 9007199254740991;
const MIN_SAFE_JSON_INTEGER = -9007199254740991;

type JsonObject = Record<string, unknown>;
type McpHeaderMapping = {
  argumentPath: string[];
  headerName: string;
  primitiveType: 'string' | 'integer' | 'boolean';
};

class AsyncLock {
  private pending = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release: () => void = () => {};
    this.pending = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const httpTransportLocks = new WeakMap<object, AsyncLock>();

// Define Global Default Proxy Settings
const defaultProxySettingsFull: Required<NonNullable<Config['proxy']>> = {
    retrySseToolCall: true, // Renamed from retrySseToolCallOnDisconnect
    sseToolCallMaxRetries: 2,
    sseToolCallRetryDelayBaseMs: 300,
    retryHttpToolCall: true,
    httpToolCallMaxRetries: 2,
    httpToolCallRetryDelayBaseMs: 300,
    retryStdioToolCall: true,
    stdioToolCallMaxRetries: 2,
    stdioToolCallRetryDelayBaseMs: 300,
};

let currentProxyConfig: Required<NonNullable<Config['proxy']>> = { ...defaultProxySettingsFull }; // Initialize with full defaults

// Register Sentry structured log sink once at module init
if (isSentryEnabled) {
  addBreadcrumbSink((level, message) => {
    switch (level) {
      case 'error':   Sentry.logger.error(message); break;
      case 'warning': Sentry.logger.warn(message);  break;
      case 'debug':   Sentry.logger.debug(message); break;
      default:        Sentry.logger.info(message);
    }
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSchemaPrimitiveType(schema: JsonObject): 'string' | 'integer' | 'boolean' | undefined {
  const type = schema.type;
  if (type === 'string' || type === 'integer' || type === 'boolean') {
    return type;
  }
  return undefined;
}

function collectMcpHeaderMappings(
  schema: unknown,
  path: string[] = [],
  seenHeaders = new Map<string, string>(),
  errors: string[] = [],
): { mappings: McpHeaderMapping[], errors: string[] } {
  const mappings: McpHeaderMapping[] = [];
  if (!isJsonObject(schema)) {
    return { mappings, errors };
  }

  const headerName = schema['x-mcp-header'];
  if (headerName !== undefined) {
    const pathLabel = path.length > 0 ? path.join('.') : '<root>';
    const primitiveType = getSchemaPrimitiveType(schema);
    if (typeof headerName !== 'string' || headerName.length === 0) {
      errors.push(`${pathLabel}: x-mcp-header must be a non-empty string`);
    } else if (!MCP_HEADER_NAME_PATTERN.test(headerName)) {
      errors.push(`${pathLabel}: x-mcp-header '${headerName}' is not a valid HTTP field-name token`);
    } else if (!primitiveType) {
      errors.push(`${pathLabel}: x-mcp-header can only be used on string, integer, or boolean properties`);
    } else {
      const normalizedHeader = headerName.toLowerCase();
      const existingPath = seenHeaders.get(normalizedHeader);
      if (existingPath) {
        errors.push(`${pathLabel}: x-mcp-header '${headerName}' duplicates header from ${existingPath}`);
      } else {
        seenHeaders.set(normalizedHeader, pathLabel);
        mappings.push({ argumentPath: path, headerName, primitiveType });
      }
    }
  }

  const properties = schema.properties;
  if (isJsonObject(properties)) {
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      const nested = collectMcpHeaderMappings(propertySchema, [...path, propertyName], seenHeaders, errors);
      mappings.push(...nested.mappings);
    }
  }

  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    for (const subSchema of allOf) {
      const nested = collectMcpHeaderMappings(subSchema, path, seenHeaders, errors);
      mappings.push(...nested.mappings);
    }
  }

  return { mappings, errors };
}

function inspectToolForProxying(tool: Tool, connectedClient: ConnectedClient): { valid: boolean, mcpHeaderMappings: McpHeaderMapping[] } {
  if (connectedClient.transportType !== 'http') {
    return { valid: true, mcpHeaderMappings: [] };
  }

  const { mappings, errors } = collectMcpHeaderMappings(tool.inputSchema);
  if (errors.length > 0) {
    logger.warn(`Rejecting tool '${tool.name}' from HTTP backend '${connectedClient.name}' due to invalid x-mcp-header annotations: ${errors.join('; ')}`);
    return { valid: false, mcpHeaderMappings: [] };
  }
  return { valid: true, mcpHeaderMappings: mappings };
}

export function toolTypeFromAnnotations(annotations: Tool['annotations']): ToolType | undefined {
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.readOnlyHint === false && annotations.destructiveHint === false) return 'write';
  if (annotations?.readOnlyHint === false && annotations.destructiveHint === true) return 'destructive';
  return undefined;
}

function configuredToolType(settings: ToolConfig['tools'][string] | undefined): ToolType | undefined {
  return settings?.toolType || settings?.callType;
}

function annotationsForToolType(annotations: Tool['annotations'], toolType: ToolType | undefined): Tool['annotations'] {
  if (!toolType) return annotations;
  const next = { ...(annotations || {}) } as NonNullable<Tool['annotations']>;
  if (toolType === 'read') {
    next.readOnlyHint = true;
    delete next.destructiveHint;
  } else {
    next.readOnlyHint = false;
    next.destructiveHint = toolType === 'destructive';
  }
  return next;
}

/**
 * MCP tool names are stable identifiers and must remain valid machine-facing
 * names. The annotation title is the client-facing label, so use it to make
 * tools recognisable when several backend servers expose similarly named
 * operations.
 */
function toolDisplayTitle(serverKey: string, toolInfo: Tool): string {
  const serverDisplayName = currentActiveServersConfig[serverKey]?.name || serverKey;
  const upstreamTitle = toolInfo.title?.trim() || toolInfo.annotations?.title?.trim();
  const fallbackTitle = toolInfo.name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
  return `${serverDisplayName}: ${upstreamTitle || fallbackTitle}`;
}

function annotationsWithDisplayTitle(
  annotations: Tool['annotations'],
  serverKey: string,
  toolInfo: Tool,
): Tool['annotations'] {
  return { ...(annotations || {}), title: toolDisplayTitle(serverKey, toolInfo) } as Tool['annotations'];
}

function getArgumentAtPath(args: JsonObject, path: string[]): unknown {
  let current: unknown = args;
  for (const segment of path) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function extractMcpParamHeaders(mappings: McpHeaderMapping[], args: unknown, toolName: string): Record<string, string> {
  if (mappings.length === 0 || !isJsonObject(args)) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const mapping of mappings) {
    const value = getArgumentAtPath(args, mapping.argumentPath);
    if (value === undefined || value === null) {
      continue;
    }
    const pathLabel = mapping.argumentPath.join('.');
    if (mapping.primitiveType === 'string') {
      if (typeof value !== 'string') {
        throw new ProtocolError(-32602, `Tool '${toolName}' argument '${pathLabel}' must be a string for x-mcp-header '${mapping.headerName}'.`);
      }
      headers[`Mcp-Param-${mapping.headerName}`] = value;
    } else if (mapping.primitiveType === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new ProtocolError(-32602, `Tool '${toolName}' argument '${pathLabel}' must be a boolean for x-mcp-header '${mapping.headerName}'.`);
      }
      headers[`Mcp-Param-${mapping.headerName}`] = String(value);
    } else {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_SAFE_JSON_INTEGER || value > MAX_SAFE_JSON_INTEGER) {
        throw new ProtocolError(-32602, `Tool '${toolName}' argument '${pathLabel}' must be a safe integer for x-mcp-header '${mapping.headerName}'.`);
      }
      headers[`Mcp-Param-${mapping.headerName}`] = String(value);
    }
  }
  return headers;
}

function getHttpTransportLock(connectedClient: ConnectedClient): AsyncLock {
  const transportKey = connectedClient.transport as unknown as object;
  const existing = httpTransportLocks.get(transportKey);
  if (existing) {
    return existing;
  }
  const created = new AsyncLock();
  httpTransportLocks.set(transportKey, created);
  return created;
}

async function withHttpRequestHeaders<T>(
  connectedClient: ConnectedClient,
  headersToAdd: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  if (connectedClient.transportType !== 'http' || Object.keys(headersToAdd).length === 0) {
    return fn();
  }

  return getHttpTransportLock(connectedClient).run(async () => {
    const transportWithRequestInit = connectedClient.transport as unknown as { _requestInit?: RequestInit };
    const originalRequestInit = transportWithRequestInit._requestInit;
    const mergedHeaders = new Headers(originalRequestInit?.headers || {});
    for (const [key, value] of Object.entries(headersToAdd)) {
      mergedHeaders.set(key, value);
    }
    transportWithRequestInit._requestInit = {
      ...originalRequestInit,
      headers: mergedHeaders,
    };
    try {
      return await fn();
    } finally {
      transportWithRequestInit._requestInit = originalRequestInit;
    }
  });
}

function buildExposedTools(): Tool[] {
  const toolOverrides = currentToolConfig.tools || {};
  const enabledTools: Tool[] = [];
  for (const [originalQualifiedName, { client, toolInfo }] of toolToClientMap.entries()) {
    const overrideSettings = toolOverrides[originalQualifiedName];
    const typeAnnotations = annotationsForToolType(toolInfo.annotations, configuredToolType(overrideSettings));
    enabledTools.push({
      ...toolInfo,
      name: overrideSettings?.exposedName || originalQualifiedName,
      title: toolDisplayTitle(client.name, toolInfo),
      description: overrideSettings?.exposedDescription || toolInfo.description,
      annotations: annotationsWithDisplayTitle(typeAnnotations, client.name, toolInfo),
    });
  }
  return enabledTools.sort((a, b) => a.name.localeCompare(b.name));
}

function encodeToolCursor(offset: number): string {
  return Buffer.from(`tools:${offset}`, 'utf8').toString('base64url');
}

function decodeToolCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded.startsWith('tools:')) {
      throw new Error('invalid prefix');
    }
    const offset = Number.parseInt(decoded.slice('tools:'.length), 10);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('invalid offset');
    }
    return offset;
  } catch {
    throw new ProtocolError(-32602, `Invalid tools/list cursor: ${cursor}`);
  }
}

function toolListFingerprint(): string {
  return JSON.stringify(buildExposedTools());
}

async function notifyToolListChangedIfNeeded() {
  const nextFingerprint = toolListFingerprint();
  if (nextFingerprint === lastToolListFingerprint) {
    return;
  }

  const hadPreviousList = lastToolListFingerprint !== '';
  lastToolListFingerprint = nextFingerprint;
  if (hadPreviousList && notificationServer) {
    try {
      await notificationServer.sendToolListChanged();
    } catch (error: any) {
      logger.warn(`Failed to send tools/list_changed notification: ${error?.message || error}`);
    }
  }
}

// --- Function to update backend connections and maps ---
export const updateBackendConnections = async (newServerConfig: Config, newToolConfig: ToolConfig, forceReconnectKeys = new Set<string>()) => {
    return Sentry.startSpan(
        {
            name: 'updateBackendConnections',
            op: 'proxy.config_reload',
            attributes: { server_count: Object.keys(newServerConfig.mcpServers).length },
        },
        async () => {
    logger.log("Starting update of backend connections...");
    currentToolConfig = newToolConfig; // Update stored tool config
    currentProxyConfig = { // Update currentProxyConfig using full defaults
        ...defaultProxySettingsFull,
        ...(newServerConfig.proxy || {}),
    };
    // Update the current separator from the new config
    currentSeparator = newServerConfig.serverToolnameSeparator || DEFAULT_SERVER_TOOLNAME_SEPERATOR;
    logger.log(`Using server toolname separator: "${currentSeparator}"`);

    const activeServersConfigLocal: Record<string, TransportConfig> = {}; // Renamed to avoid conflict with module-level
    for (const serverKey in newServerConfig.mcpServers) {
        if (Object.prototype.hasOwnProperty.call(newServerConfig.mcpServers, serverKey)) {
            const serverConf = newServerConfig.mcpServers[serverKey];
            const isActive = !(serverConf.active === false || String(serverConf.active).toLowerCase() === 'false');
            if (isActive) {
                activeServersConfigLocal[serverKey] = serverConf;
                serverHealth.set(serverKey, { state: 'checking', checkedAt: new Date().toISOString() });
            } else {
                 serverHealth.set(serverKey, { state: 'inactive', checkedAt: new Date().toISOString() });
                 const serverName = serverKey;
                 logger.log(`Skipping inactive server during update: ${serverName}`);
            }
        }
    }
    currentActiveServersConfig = activeServersConfigLocal; // Update module-level variable

    const newClientKeys = new Set(Object.keys(activeServersConfigLocal));
    const currentClientKeys = new Set(currentConnectedClients.map(c => c.name));

    const clientsToReplace = currentConnectedClients.filter(c => newClientKeys.has(c.name) && (forceReconnectKeys.has(c.name) || JSON.stringify(c.config) !== JSON.stringify(activeServersConfigLocal[c.name])));
    const replacementKeys = new Set(clientsToReplace.map(c => c.name));
    const clientsToRemove = currentConnectedClients.filter(c => !newClientKeys.has(c.name) || replacementKeys.has(c.name));
    const clientsToKeep = currentConnectedClients.filter(c => newClientKeys.has(c.name) && !replacementKeys.has(c.name));
    const keysToAdd = Object.keys(activeServersConfigLocal).filter(key => !currentClientKeys.has(key) || replacementKeys.has(key));

    logger.log(`Clients to remove: ${clientsToRemove.map(c => c.name).join(', ') || 'None'}`);
    logger.log(`Clients to keep: ${clientsToKeep.map(c => c.name).join(', ') || 'None'}`);
    logger.log(`Server keys to add: ${keysToAdd.join(', ') || 'None'}`);

    // 1. Cleanup removed clients
    if (clientsToRemove.length > 0) {
        logger.log(`Cleaning up ${clientsToRemove.length} removed clients...`);
        await Promise.all(clientsToRemove.map(async ({ name, cleanup }) => {
            try {
                await cleanup();
                logger.log(`  Cleaned up client: ${name}`);
            } catch (error: any) {
                logger.error(`  Error cleaning up client ${name}: ${error.message}`);
            }
        }));
    }

    // 2. Connect new clients
    let newlyConnectedClients: ConnectedClient[] = [];
    if (keysToAdd.length > 0) {
        const configToAdd: Record<string, TransportConfig> = {};
        keysToAdd.forEach(key => { configToAdd[key] = activeServersConfigLocal[key]; });
        logger.log(`Connecting ${keysToAdd.length} new clients...`);
        newlyConnectedClients = await createClients(configToAdd);
        logger.log(`Successfully connected to ${newlyConnectedClients.length} out of ${keysToAdd.length} new clients.`);
    }

    // 3. Update the main list
    currentConnectedClients = [...clientsToKeep, ...newlyConnectedClients];
    const connectedKeys = new Set(currentConnectedClients.map(client => client.name));
    for (const key of Object.keys(activeServersConfigLocal)) {
      serverHealth.set(key, connectedKeys.has(key)
        ? { state: 'connected', checkedAt: new Date().toISOString() }
        : { state: 'error', checkedAt: new Date().toISOString(), error: 'Could not connect to the server. Check the server configuration and logs.' });
    }
    logger.log(`Total active clients after update: ${currentConnectedClients.length}`);

    // 4. Clear and repopulate maps immediately (important for consistency)
    logger.log("Clearing and repopulating internal maps (tools, resources, prompts)...");
    toolToClientMap.clear();
    toolCatalogue.clear();
    resourceToClientMap.clear();
    promptToClientMap.clear();

    // Repopulate Tools Map
    for (const connectedClient of currentConnectedClients) {
        try {
            const result = await connectedClient.client.request({ method: 'tools/list', params: {} }, ResultSchema) as any;
            if (Array.isArray(result.tools) && result.tools.length > 0) {
                for (const tool of result.tools as Tool[]) {
                    const qualifiedName = `${connectedClient.name}${currentSeparator}${tool.name}`; // Use the current separator
                    const toolSettings = currentToolConfig.tools[qualifiedName];
                    const isEnabled = !toolSettings || toolSettings.enabled !== false;
                    const inspection = inspectToolForProxying(tool, connectedClient);
                    const catalogueEntry: ToolCatalogueEntry = {
                      qualifiedName,
                      client: connectedClient,
                      toolInfo: tool,
                      mcpHeaderMappings: inspection.mcpHeaderMappings,
                      proxyState: !isEnabled ? 'disabled' : inspection.valid ? 'exposed' : 'rejected',
                      rejectionReason: inspection.valid ? undefined : 'Invalid HTTP header mappings',
                    };
                    toolCatalogue.set(qualifiedName, catalogueEntry);
                    if (isEnabled && inspection.valid) {
                        // Store the client and the full tool info from the backend
                        toolToClientMap.set(qualifiedName, { client: connectedClient, toolInfo: tool, mcpHeaderMappings: inspection.mcpHeaderMappings });
                    }
                }
            }
        } catch (error: any) {
             serverHealth.set(connectedClient.name, { state: 'error', checkedAt: new Date().toISOString(), error: `Connected, but tools discovery failed: ${error?.message || error}` });
             if (!(error?.code === -32601)) { // Ignore 'Method not found'
                 logger.error(`Error fetching tools from ${connectedClient.name} during map update:`, error?.message || error);
             }
        }
    }
    logger.log(`  Updated tool map with ${toolToClientMap.size} enabled tools.`);

    // Repopulate Resources Map
    for (const connectedClient of currentConnectedClients) {
         try {
             const result = await connectedClient.client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema);
             if (result.resources) {
                 result.resources.forEach(resource => resourceToClientMap.set(resource.uri, connectedClient));
             }
         } catch (error: any) {
              if (!(error?.code === -32601)) { // Ignore 'Method not found'
                  logger.error(`Error fetching resources from ${connectedClient.name} during map update:`, error?.message || error);
              }
         }
    }
     logger.log(`  Updated resource map with ${resourceToClientMap.size} resources.`);

    // Repopulate Prompts Map
    for (const connectedClient of currentConnectedClients) {
         try {
             const result = await connectedClient.client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema);
             if (result.prompts) {
                 result.prompts.forEach(prompt => promptToClientMap.set(prompt.name, connectedClient));
             }
         } catch (error: any) {
              if (!(error?.code === -32601)) { // Ignore 'Method not found'
                  logger.error(`Error fetching prompts from ${connectedClient.name} during map update:`, error?.message || error);
              }
         }
    }
    logger.log(`  Updated prompt map with ${promptToClientMap.size} prompts.`);
    await notifyToolListChangedIfNeeded();
    logger.log("Backend connections update finished.");
        } // end Sentry.startSpan callback
    ); // end Sentry.startSpan
};

async function refreshBackendConnection(serverKey: string, serverConfig: TransportConfig): Promise<boolean> {
  logger.log(`Attempting to refresh backend connection for server: ${serverKey}`);
  const existingClientIndex = currentConnectedClients.findIndex(c => c.name === serverKey);
  let oldCleanup: (() => Promise<void>) | undefined = undefined;
  let existingConfig: TransportConfig | undefined = currentConnectedClients[existingClientIndex]?.config;

  if (existingClientIndex !== -1 && currentConnectedClients[existingClientIndex]) {
    oldCleanup = currentConnectedClients[existingClientIndex].cleanup;
    existingConfig = currentConnectedClients[existingClientIndex].config;
  } else {
    // Fallback to currentActiveServersConfig if not found in currentConnectedClients (should be rare for refresh)
    existingConfig = currentActiveServersConfig[serverKey];
  }

  if (!existingConfig) {
    logger.error(`Configuration for server ${serverKey} not found. Cannot refresh.`);
    return false;
  }
  // Use the passed serverConfig if available (e.g. from initial load), otherwise fallback to existingConfig.
  // The `serverConfig` parameter in refreshBackendConnection might be more up-to-date if called during a config reload.
  const configToUse = serverConfig || existingConfig;


  try {
    // reconnectSingleClient returns Omit<ConnectedClient, 'name'>
    const reconnectedClientParts = await reconnectSingleClient(serverKey, configToUse, oldCleanup);

    const newConnectedClientEntry: ConnectedClient = {
      ...reconnectedClientParts, // Spread the parts (client, cleanup, config, transportType)
      name: serverKey, // Add the name back
    };

    if (existingClientIndex !== -1) {
      currentConnectedClients[existingClientIndex] = newConnectedClientEntry;
      logger.log(`Updated existing client entry for ${serverKey} in currentConnectedClients.`);
    } else {
      currentConnectedClients.push(newConnectedClientEntry);
      logger.log(`Added new client entry for ${serverKey} to currentConnectedClients (this path might be taken if client was previously removed due to error).`);
    }

    // Clear existing entries for this client
    for (const [key, value] of toolToClientMap.entries()) {
      if (value.client.name === serverKey) {
        toolToClientMap.delete(key);
      }
    }
    for (const [key, value] of resourceToClientMap.entries()) {
      // Assuming value is ConnectedClient, so value.name is the server key
      if (value.name === serverKey) {
        resourceToClientMap.delete(key);
      }
    }
    for (const [key, value] of promptToClientMap.entries()) {
      // Assuming value is ConnectedClient, so value.name is the server key
      if (value.name === serverKey) {
        promptToClientMap.delete(key);
      }
    }
    logger.log(`Cleared map entries for ${serverKey}.`);

    // Repopulate maps for the reconnected client
    const connectedClient = newConnectedClientEntry;
    try {
        const result = await connectedClient.client.request({ method: 'tools/list', params: {} }, ResultSchema) as any;
        if (Array.isArray(result.tools) && result.tools.length > 0) {
            for (const tool of result.tools as Tool[]) {
                const qualifiedName = `${connectedClient.name}${currentSeparator}${tool.name}`; // Use the current separator
                const toolSettings = currentToolConfig.tools[qualifiedName];
                const isEnabled = !toolSettings || toolSettings.enabled !== false;
                if (isEnabled) {
                    const inspection = inspectToolForProxying(tool, connectedClient);
                    if (!inspection.valid) {
                        continue;
                    }
                    toolToClientMap.set(qualifiedName, { client: connectedClient, toolInfo: tool, mcpHeaderMappings: inspection.mcpHeaderMappings });
                }
            }
        }
    } catch (error: any) {
         if (!(error?.code === -32601)) {
             logger.error(`Error fetching tools from ${connectedClient.name} during refresh:`, error?.message || error);
         }
    }

    try {
         const result = await connectedClient.client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema);
         if (result.resources) {
             result.resources.forEach(resource => resourceToClientMap.set(resource.uri, connectedClient));
         }
     } catch (error: any) {
          if (!(error?.code === -32601)) {
              logger.error(`Error fetching resources from ${connectedClient.name} during refresh:`, error?.message || error);
          }
     }

    try {
         const result = await connectedClient.client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema);
         if (result.prompts) {
             result.prompts.forEach(prompt => promptToClientMap.set(prompt.name, connectedClient));
         }
     } catch (error: any) {
          if (!(error?.code === -32601)) {
              logger.error(`Error fetching prompts from ${connectedClient.name} during refresh:`, error?.message || error);
          }
    }
    logger.log(`Repopulated maps for ${serverKey}.`);
    await notifyToolListChangedIfNeeded();
    return true;

  } catch (error: any) {
    logger.error(`Failed to refresh backend connection for ${serverKey}: ${error.message}`);
    // If refresh failed, we remove the client to prevent further attempts with a known bad state.
    // This also cleans up its entries from the maps.
    if (existingClientIndex !== -1) {
        currentConnectedClients.splice(existingClientIndex, 1);
    }
    // Clear any potentially lingering map entries if refresh failed mid-way
    for (const [key, value] of toolToClientMap.entries()) {
      if (value.client.name === serverKey) toolToClientMap.delete(key);
    }
    for (const [key, value] of resourceToClientMap.entries()) {
      if (value.name === serverKey) resourceToClientMap.delete(key);
    }
    for (const [key, value] of promptToClientMap.entries()) {
      if (value.name === serverKey) promptToClientMap.delete(key);
    }
    logger.log(`Removed client ${serverKey} and its map entries after failed refresh.`);
    return false;
  }
}

// --- Function to get current proxy state ---
export const getCurrentProxyState = () => {
    const tools: any[] = Array.from(toolCatalogue.values()).map(({ qualifiedName, client: connectedClient, toolInfo, mcpHeaderMappings, proxyState, rejectionReason }) => {
        const settings = currentToolConfig.tools[qualifiedName];
        const overrideType = configuredToolType(settings);
        const upstreamToolType = toolTypeFromAnnotations(toolInfo.annotations);
        const effectiveToolType = overrideType || upstreamToolType;
        return {
          qualifiedName,
          name: toolInfo.name,
          displayName: toolDisplayTitle(connectedClient?.name || 'Unknown', toolInfo),
            serverName: connectedClient?.name || 'Unknown',
            transportType: connectedClient?.transportType || 'unknown',
            description: toolInfo.description,
            inputSchema: toolInfo.inputSchema,
            outputSchema: toolInfo.outputSchema,
            annotations: toolInfo.annotations,
            execution: (toolInfo as any).execution,
            icons: (toolInfo as any).icons,
            _meta: toolInfo._meta,
            mcpHeaderMappings,
            proxyState,
            rejectionReason,
            upstreamToolType: upstreamToolType || 'unspecified',
            effectiveToolType: effectiveToolType || 'unspecified',
            toolTypeSource: overrideType ? 'override' : upstreamToolType ? 'upstream' : 'unspecified',
            effectiveAnnotations: annotationsWithDisplayTitle(annotationsForToolType(toolInfo.annotations, overrideType), connectedClient?.name || 'Unknown', toolInfo),
        };
    });
    const configuredToolKeys = new Set(tools.map(tool => tool.qualifiedName));
    for (const [qualifiedName, settings] of Object.entries(currentToolConfig.tools || {})) {
      if (!configuredToolKeys.has(qualifiedName)) {
        const serverName = qualifiedName.split(currentSeparator)[0] || 'Unknown';
        tools.push({
          qualifiedName, name: qualifiedName.split(currentSeparator).slice(1).join(currentSeparator) || qualifiedName,
          displayName: `${currentActiveServersConfig[serverName]?.name || serverName}: ${qualifiedName.split(currentSeparator).slice(1).join(currentSeparator) || qualifiedName}`,
          serverName, transportType: 'unknown', description: undefined, inputSchema: undefined, outputSchema: undefined,
          annotations: undefined, execution: undefined, icons: undefined, _meta: undefined, mcpHeaderMappings: [],
          proxyState: 'missing', rejectionReason: 'Configured but not currently discovered from this server.',
          upstreamToolType: 'unspecified', effectiveToolType: configuredToolType(settings) || 'unspecified',
          toolTypeSource: configuredToolType(settings) ? 'override' : 'unspecified', effectiveAnnotations: undefined,
        });
      }
    }
    const servers: any[] = Object.entries(currentActiveServersConfig).map(([key, config]) => {
      const health = serverHealth.get(key) || { state: 'checking' as ServerHealth, checkedAt: new Date().toISOString() };
      const serverTools = tools.filter(tool => tool.serverName === key);
      return { key, name: config.name || key, transportType: config.type, active: true, health, toolCounts: {
        discovered: serverTools.filter(tool => tool.proxyState !== 'missing').length,
        exposed: serverTools.filter(tool => tool.proxyState === 'exposed').length,
        disabled: serverTools.filter(tool => tool.proxyState === 'disabled').length,
        problems: serverTools.filter(tool => tool.proxyState === 'rejected' || tool.proxyState === 'missing').length,
      }};
    });
    for (const [key, health] of serverHealth.entries()) {
      if (!servers.some(server => server.key === key) && health.state === 'inactive') {
        servers.push({ key, name: key, transportType: 'unknown', active: false, health, toolCounts: { discovered: 0, exposed: 0, disabled: 0, problems: 0 } });
      }
    }
    return { tools, servers, checkedAt: new Date().toISOString(), serverToolnameSeparator: currentSeparator };
};

// Helper function to identify connection errors
const isConnectionError = (err: any): boolean => {
  if (err && err.message) {
    const lowerMessage = err.message.toLowerCase();
    return lowerMessage.includes("disconnected") ||
           lowerMessage.includes("not connected") ||
           lowerMessage.includes("connection closed") ||
           lowerMessage.includes("transport is closed") || // SDK specific
           lowerMessage.includes("failed to fetch") || 
           lowerMessage.includes("not found") || //Error POSTING session not found
           lowerMessage.includes("404") || 
           lowerMessage.includes("eof") || // Network level
           lowerMessage.includes("tls") || // TLS handshake
           lowerMessage.includes("timeout") ||
           lowerMessage.includes("timed out"); 
  }
  return false;
};

// --- Server Creation ---
export const createServer = async (initializeProxy = true, registerNotificationSink = true) => {
  if (initializeProxy) {
    // Load initial config
    const initialServerConfig = await loadConfig(); // This now includes proxy settings
    const initialToolConfig = await loadToolConfig();

  // Initialize currentActiveServersConfig AND currentProxyConfig from the initial load
  const initialActiveServers: Record<string, TransportConfig> = {};
    for (const serverKey in initialServerConfig.mcpServers) {
        if (Object.prototype.hasOwnProperty.call(initialServerConfig.mcpServers, serverKey)) {
            const serverConf = initialServerConfig.mcpServers[serverKey];
            const isActive = !(serverConf.active === false || String(serverConf.active).toLowerCase() === 'false');
            if (isActive) {
                initialActiveServers[serverKey] = serverConf;
            }
        }
    }
    currentActiveServersConfig = initialActiveServers;
    // Update currentProxyConfig using initialServerConfig and global defaults
    currentProxyConfig = {
        ...defaultProxySettingsFull,
        ...(initialServerConfig.proxy || {}),
    };


    // Perform initial connection and map population
    await updateBackendConnections(initialServerConfig, initialToolConfig);
  }

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)); // Define sleep

  // Create the main proxy server instance
  const server = new Server(
    {
      name: "mcp_proxy_server",
      version: "1.0.0", // Consider updating version dynamically
    },
    {
      capabilities: {
        prompts: {},
        resources: { subscribe: true },
        tools: { listChanged: true },
        logging: {},
      },
    },
  );
  if (registerNotificationSink) {
    notificationServer = server;
  }

  // Auto-instrument transport-level MCP monitoring via Sentry.
  // wrapMcpServerWithSentry validates for McpServer's high-level API (tool/resource/prompt).
  // We use the low-level Server class with setRequestHandler, so we add stubs to pass
  // validation — the key instrumentation is the connect() wrapping that hooks the transport.
  const serverAsAny = server as unknown as Record<string, unknown>;
  if (!('tool' in serverAsAny)) serverAsAny['tool'] = () => { /* stub for Sentry validation */ };
  if (!('resource' in serverAsAny)) serverAsAny['resource'] = () => { /* stub for Sentry validation */ };
  if (!('prompt' in serverAsAny)) serverAsAny['prompt'] = () => { /* stub for Sentry validation */ };
  wrapMcpServerWithSentry(server as unknown as Parameters<typeof wrapMcpServerWithSentry>[0]);

  // Register MCP notification sink so connected clients receive warning/error log notifications
  if (registerNotificationSink) {
    addMcpNotificationSink((level, message) => {
      server.sendLoggingMessage({
        level: level as 'info' | 'warning' | 'error' | 'debug',
        logger: 'mcp-proxy',
        data: message,
      }).catch(() => {}); // fire-and-forget; clients may disconnect
    });
  }

  // --- Request Handlers ---
  // These handlers now rely on the maps populated by updateBackendConnections
  // Note: InitializeRequest is handled by the SDK's Server default behavior.

  server.setRequestHandler('tools/list', async (request) => {
    logger.log("Received tools/list request - applying overrides from config");
    const enabledTools = buildExposedTools();
    const offset = decodeToolCursor(request.params?.cursor);
    const pagedTools = enabledTools.slice(offset, offset + TOOLS_LIST_PAGE_SIZE);
    const nextOffset = offset + pagedTools.length;
    const nextCursor = nextOffset < enabledTools.length ? encodeToolCursor(nextOffset) : undefined;
    logger.log(`Returning ${pagedTools.length}/${enabledTools.length} enabled tools with applied overrides.`);
    return {
      resultType: 'complete',
      tools: pagedTools,
      nextCursor,
      ttlMs: TOOLS_LIST_TTL_MS,
      cacheScope: 'public',
    } as any;
  });

  server.setRequestHandler('tools/call', async (request) => {
    const { name: requestedExposedName, arguments: args } = request.params;
    const callStartTime = Date.now();
    let originalQualifiedName: string | undefined;
    let mapEntry: ToolMapEntry | undefined;

    // Need to find the original tool based on the potentially overridden exposed name
    const toolOverrides = currentToolConfig.tools || {};

    // Iterate through the live tool map to find which original tool corresponds
    // to the requested exposed name.
    for (const [key, { client, toolInfo: currentToolInfo }] of toolToClientMap.entries()) { // Renamed toolInfo to currentToolInfo to avoid conflict
        const overrideSettings = toolOverrides[key];
        const currentExposedName = overrideSettings?.exposedName || key; // Calculate the exposed name for this tool

        if (currentExposedName === requestedExposedName) {
            originalQualifiedName = key; // Found the original key
            mapEntry = { client, toolInfo: currentToolInfo, mcpHeaderMappings: toolToClientMap.get(key)?.mcpHeaderMappings || [] }; // Get the corresponding entry
            break;
        }
    }

    // If no entry was found after checking all enabled tools and their potential overrides
    if (!mapEntry || !originalQualifiedName) {
        const errorMessage = `Attempted to call tool with exposed name "${requestedExposedName}", but no corresponding enabled tool or override configuration found.`;
        logger.error(errorMessage);
        throw new ProtocolError(-32601, errorMessage); // Method not found error code
    }

    // Now we have the correct mapEntry and the originalQualifiedName
    let { client: clientForTool, toolInfo } = mapEntry; // toolInfo here is the correct one from the found mapEntry
    let mcpHeaderMappings = mapEntry.mcpHeaderMappings;
    const originalToolNameForBackend = toolInfo.name; // The actual name the backend server expects (from the original toolInfo)

    // --- Retry Logic ---
    // Use HTTP retry settings for SSE as a fallback for retry count and delay
    const maxRetries = clientForTool.transportType === 'sse' ? (currentProxyConfig.retrySseToolCall ? currentProxyConfig.sseToolCallMaxRetries : 0) : // Use SSE specific max retries, check retrySseToolCall
                       clientForTool.transportType === 'stdio' ? (currentProxyConfig.retryStdioToolCall ? currentProxyConfig.stdioToolCallMaxRetries : 0) :
                       clientForTool.transportType === 'http' ? (currentProxyConfig.retryHttpToolCall ? currentProxyConfig.httpToolCallMaxRetries : 0) : 0;
    const retryDelayBaseMs = clientForTool.transportType === 'sse' ? currentProxyConfig.sseToolCallRetryDelayBaseMs : // Use SSE specific retry delay
                             clientForTool.transportType === 'stdio' ? (currentProxyConfig.retryStdioToolCall ? currentProxyConfig.stdioToolCallRetryDelayBaseMs : 0) : // Added check for stdio retry enabled
                             clientForTool.transportType === 'http' ? (currentProxyConfig.retryHttpToolCall ? currentProxyConfig.httpToolCallRetryDelayBaseMs : 0) : 0; // Added check for http retry enabled

    let lastError: any = null;

    // Loop includes the initial attempt (attempt 0) plus maxRetries
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt >= 0) {            
            if (attempt > 0) {
              const delay = retryDelayBaseMs * Math.pow(2, attempt - 1) + (Math.random() * retryDelayBaseMs * 0.5);
              logger.log(`Tool call failed for '${requestedExposedName}'. Attempt ${attempt}/${maxRetries}. Retrying in ${delay.toFixed(0)}ms...`);
              await sleep(delay);
            }
            // For SSE, attempt reconnect before retrying the call if the last error was a connection error
            // For SSE, attempt reconnect before retrying the call if the last error was a connection error OR if it's the first attempt
            if (clientForTool.transportType === 'sse') {
                if (attempt === 0 || isConnectionError(lastError)) { // Force reconnect on first attempt for SSE, or if there was a connection error
                    logger.log(`SSE connection handling for tool '${requestedExposedName}' on server '${clientForTool.name}'. Attempting reconnect.`);
                    const clientTransportConfig = currentActiveServersConfig[clientForTool.name];
                    if (!clientTransportConfig) {
                        logger.error(`Cannot proceed with SSE: TransportConfig for server '${clientForTool.name}' not found.`);
                        throw new ProtocolError(-32000, `SSE TransportConfig for server '${clientForTool.name}' not found for tool '${requestedExposedName}'.`);
                    }
                    const refreshed = await refreshBackendConnection(clientForTool.name, clientTransportConfig);
                    if (refreshed) {
                        logger.log(`Successfully reconnected to server '${clientForTool.name}' via SSE.`);
                        // Update clientForTool and toolInfo references after refresh
                        const newMapEntry = toolToClientMap.get(originalQualifiedName);
                        if (!newMapEntry) {
                            logger.error(`Tool '${originalQualifiedName}' not found in map after successful SSE refresh for server '${clientForTool.name}'.`);
                            throw new ProtocolError(-32000, `Tool '${originalQualifiedName}' disappeared after SSE refresh for server '${clientForTool.name}'.`);
                        }
                        clientForTool = newMapEntry.client;
                        toolInfo = newMapEntry.toolInfo;
                        mcpHeaderMappings = newMapEntry.mcpHeaderMappings;
                    } else {
                        logger.error(`SSE Reconnection to server '${clientForTool.name}' failed.`);
                        throw new ProtocolError(-32000, `SSE Reconnection to server '${clientForTool.name}' failed for tool '${requestedExposedName}'.`);
                    }
                }
            }
         }

        Sentry.addBreadcrumb({
            category: 'tool_call.attempt',
            message: `Attempt ${attempt + 1}/${maxRetries + 1} for "${requestedExposedName}" on "${clientForTool.name}"`,
            level: 'info',
            data: { attempt: attempt + 1, serverKey: clientForTool.name, transportType: clientForTool.transportType },
        });

        try {
            logger.log(`Forwarding tool call for exposed name '${requestedExposedName}' (original qualified name: '${originalQualifiedName}'). Forwarding to server '${clientForTool.name}' as tool '${originalToolNameForBackend}' (Attempt ${attempt + 1})`);
            const backendParams = {
                ...request.params,
                name: originalToolNameForBackend,
                arguments: args || {},
            } as any;
            const mcpParamHeaders = extractMcpParamHeaders(mcpHeaderMappings, backendParams.arguments, requestedExposedName);
            // Explicitly set a timeout for the request using SDK's RequestOptions
            const backendResponse = await withHttpRequestHeaders(
                clientForTool,
                mcpParamHeaders,
                () => clientForTool.client.request(
                    {
                        method: 'tools/call',
                        params: backendParams
                    },
                    ResultSchema,
                    { timeout: DEFAULT_REQUEST_TIMEOUT_MSEC } // Set timeout explicitly
                )
            );
            logger.log(`[Tool Call] Backend response received for '${requestedExposedName}'. Passing to SDK Server.`);
            sendToolCallNotification({
                toolExposedName: requestedExposedName,
                toolOriginalName: originalToolNameForBackend,
                serverKey: clientForTool.name,
                transportType: clientForTool.transportType,
                args: args || {},
                success: true,
                durationMs: Date.now() - callStartTime,
                callTypeOverride: currentToolConfig.tools?.[originalQualifiedName]?.callType,
            }).catch(() => {});
            return backendResponse as any; // Backend response is validated by the upstream server.
        } catch (error: any) {
            lastError = error;
            logger.warn(`Attempt ${attempt + 1} to call tool '${requestedExposedName}' failed: ${error.message}`);

            Sentry.addBreadcrumb({
                category: 'tool_call.attempt',
                message: `Attempt ${attempt + 1} failed: ${error.message}`,
                level: 'warning',
                data: { error: error.message, code: error?.code },
            });

            // Check if this error warrants a retry based on type and configuration
            const isRetryableError = isConnectionError(error) || error?.code === -32001; // Consider timeout as retryable
            const shouldRetry = (clientForTool.transportType === 'sse' && currentProxyConfig.retrySseToolCall && isRetryableError) || // Check retrySseToolCall
                                (clientForTool.transportType === 'stdio' && currentProxyConfig.retryStdioToolCall && isRetryableError) ||
                                (clientForTool.transportType === 'http' && currentProxyConfig.retryHttpToolCall && isRetryableError);


            if (!shouldRetry && attempt === 0) {
                 // If it's the first attempt and not a retryable error type, re-throw immediately
                 logger.error(`Tool call for '${requestedExposedName}' failed with non-retryable error on first attempt: ${error.message}`, error);
                 Sentry.withScope(scope => {
                     scope.setTag('mcp.server_key', clientForTool.name);
                     scope.setTag('mcp.transport_type', clientForTool.transportType);
                     scope.setTag('mcp.tool_name', requestedExposedName);
                     scope.setContext('tool_call', { exposedName: requestedExposedName, originalName: originalToolNameForBackend, serverKey: clientForTool.name });
                     Sentry.captureException(error);
                 });
                 sendToolCallNotification({
                     toolExposedName: requestedExposedName,
                     toolOriginalName: originalToolNameForBackend,
                     serverKey: clientForTool.name,
                     transportType: clientForTool.transportType,
                     args: args || {},
                     success: false,
                     errorMessage: error.message,
                     durationMs: Date.now() - callStartTime,
                     callTypeOverride: currentToolConfig.tools?.[originalQualifiedName]?.callType,
                 }).catch(() => {});
                 // If the error is already a protocol error, re-throw it directly. Otherwise, wrap it.
                 if (error instanceof ProtocolError) {
                     throw error;
                 } else {
                     throw new ProtocolError(error?.code || -32000, error.message || 'An unknown error occurred', error?.data);
                 }
            }

             if (!shouldRetry && attempt > 0) {
                 // If it's a subsequent attempt and the error is no longer retryable (e.g., backend returned a specific error after reconnect)
                 logger.error(`Tool call for '${requestedExposedName}' failed with non-retryable error after retries: ${error.message}`, error);
                 Sentry.withScope(scope => {
                     scope.setTag('mcp.server_key', clientForTool.name);
                     scope.setTag('mcp.transport_type', clientForTool.transportType);
                     scope.setTag('mcp.tool_name', requestedExposedName);
                     scope.setContext('tool_call', { exposedName: requestedExposedName, originalName: originalToolNameForBackend, serverKey: clientForTool.name, attempt: attempt + 1, maxRetries });
                     Sentry.captureException(error);
                 });
                 sendToolCallNotification({
                     toolExposedName: requestedExposedName,
                     toolOriginalName: originalToolNameForBackend,
                     serverKey: clientForTool.name,
                     transportType: clientForTool.transportType,
                     args: args || {},
                     success: false,
                     errorMessage: error.message,
                     durationMs: Date.now() - callStartTime,
                     callTypeOverride: currentToolConfig.tools?.[originalQualifiedName]?.callType,
                 }).catch(() => {});
                 // If the error is already a protocol error, re-throw it directly. Otherwise, wrap it.
                 if (error instanceof ProtocolError) {
                     throw error;
                 } else {
                     throw new ProtocolError(error?.code || -32000, error.message || 'An unknown error occurred', error?.data);
                 }
            }

            // If it's a retryable error and we are within maxRetries, the loop continues.
            // If it's a retryable error but we are at maxRetries, the loop will exit after this iteration.
        }
    }

    // If the loop finishes without returning, it means all retries failed.
    const errorMessage = `Error calling tool '${requestedExposedName}' after ${maxRetries} retries (on backend server '${clientForTool.name}', original tool name '${originalToolNameForBackend}'): ${lastError?.message || 'An unknown error occurred'}`;
    logger.error(errorMessage, lastError);
    Sentry.withScope(scope => {
        scope.setTag('mcp.server_key', clientForTool.name);
        scope.setTag('mcp.transport_type', clientForTool.transportType);
        scope.setTag('mcp.tool_name', requestedExposedName);
        scope.setContext('tool_call', { exposedName: requestedExposedName, originalName: originalToolNameForBackend, serverKey: clientForTool.name, attempt: maxRetries + 1, maxRetries });
        Sentry.captureException(lastError || new Error(errorMessage));
    });
    sendToolCallNotification({
        toolExposedName: requestedExposedName,
        toolOriginalName: originalToolNameForBackend,
        serverKey: clientForTool.name,
        transportType: clientForTool.transportType,
        args: args || {},
        success: false,
        errorMessage: lastError?.message || 'An unknown error occurred',
        durationMs: Date.now() - callStartTime,
        callTypeOverride: currentToolConfig.tools?.[originalQualifiedName]?.callType,
    }).catch(() => {});
    // Ensure a structured protocol error is returned to the client
    throw new ProtocolError(lastError?.code || -32000, errorMessage, lastError?.data);
});

// ... rest of the file ...

  server.setRequestHandler('prompts/get', async (request) => {
    const { name } = request.params;
    const clientForPrompt = promptToClientMap.get(name);

    if (!clientForPrompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }

    try {
      logger.log('Forwarding prompt request:', name);

      const response = await clientForPrompt.client.request(
        {
          method: 'prompts/get' as const,
          params: {
            name,
            arguments: request.params.arguments || {},
            _meta: request.params._meta || {
              progressToken: undefined
            }
          }
        },
        GetPromptResultSchema
      );

      logger.log('Prompt result:', response);
      return response;
    } catch (error: any) {
      const errorMessage = `Error getting prompt '${name}' from backend server '${clientForPrompt.name}': ${error.message || 'An unknown error occurred'}`;
      logger.error(errorMessage, error);
      throw new Error(errorMessage);
    }
  });

  server.setRequestHandler('prompts/list', async (request) => {
    logger.log("Received prompts/list request - returning from cached map");
    // Directly use the pre-populated map
    const allPrompts: any[] = [];
     for (const [name, connectedClient] of promptToClientMap.entries()) {
         // Similar simplification as tools/list
         allPrompts.push({
             name: name, // The map key is the original name
             description: `[${connectedClient.name}] Prompt (details omitted in list)`,
         });
        }
       logger.log(`Returning ${allPrompts.length} prompts from map.`);
       return {
         prompts: allPrompts,
      nextCursor: undefined // Caching doesn't support pagination easily here
    };
  });

   server.setRequestHandler('resources/list', async (request) => {
       logger.log("Received resources/list request - returning from cached map");
       const allResources: any[] = [];
       for (const [uri, connectedClient] of resourceToClientMap.entries()) {
           // Simplified response
           allResources.push({
               uri: uri,
               name: `[${connectedClient.name}] Resource (details omitted in list)`,
               description: undefined,
           });
       }
       logger.log(`Returning ${allResources.length} resources from map.`);
       return {
           resources: allResources,
           nextCursor: undefined // Caching doesn't support pagination easily here
       };
   });

  server.setRequestHandler('resources/read', async (request) => {
    // This logic remains the same, using the map
    const { uri } = request.params;
    const clientForResource = resourceToClientMap.get(uri);

    if (!clientForResource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    try {
      return await clientForResource.client.request(
        {
          method: 'resources/read',
          params: {
            uri,
            _meta: request.params._meta
          }
        },
        ReadResourceResultSchema
      );
    } catch (error: any) {
      const errorMessage = `Error reading resource '${uri}' from backend server '${clientForResource.name}': ${error.message || 'An unknown error occurred'}`;
      logger.error(errorMessage, error);
      throw new Error(errorMessage);
    }
  });

  server.setRequestHandler('resources/templates/list', async (request) => {
    const allTemplates: any[] = [];

    // Iterate over the correct client list
    for (const connectedClient of currentConnectedClients) { // FIX: Use currentConnectedClients
      try {
        const result = await connectedClient.client.request(
          {
            method: 'resources/templates/list' as const,
            params: {
              cursor: request.params?.cursor,
              _meta: request.params?._meta || {
                progressToken: undefined
              }
            }
          },
          ListResourceTemplatesResultSchema
        );

        if (result.resourceTemplates) {
          // Add explicit type for template parameter
          const templatesWithSource = result.resourceTemplates.map(template => ({
            ...template,
            name: `[${connectedClient.name}] ${template.name || ''}`,
            description: template.description ? `[${connectedClient.name}] ${template.description}` : undefined
          }));
          allTemplates.push(...templatesWithSource);
        }
      } catch (error: any) {
        const isMethodNotFoundError = error?.code === -32601;

        if (isMethodNotFoundError) {
          logger.warn(`Warning: Method 'resources/templates/list' not found on server ${connectedClient.name}. Proceeding without templates from this source.`);
        } else {
          // Standardize error propagation for other errors
          const errorMessage = `Error fetching resource templates from backend server '${connectedClient.name}': ${error.message || 'An unknown error occurred'}`;
          logger.error(errorMessage, error); // Log the detailed error
          // We are in a loop, so we might not want to throw and stop the whole process.
          // Instead, we log the error and continue to try fetching from other clients.
          // If we needed to inform the client that partial data occurred, we'd need a different strategy.
          // For now, just logging and continuing. If *all* sources fail, the client gets an empty list.
        }
      }
    }

    return {
      resourceTemplates: allTemplates,
      nextCursor: request.params?.cursor
    } as any;
  });

  // Cleanup function needs to handle the *current* list of clients
  const cleanup = async () => {
    logger.log(`Cleaning up ${currentConnectedClients.length} connected clients...`);
    await Promise.all(currentConnectedClients.map(async ({ name, cleanup: clientCleanup }) => {
        try {
            await clientCleanup();
             logger.log(`  Cleaned up client: ${name}`);
        } catch(error: any) {
             logger.error(`  Error cleaning up client ${name}: ${error.message}`);
        }
    }));
    currentConnectedClients = []; // Clear the list after cleanup
  };

  // Return the server instance and the cleanup function
  // We don't return connectedClients anymore as it's managed internally
  return { server, cleanup };
};
