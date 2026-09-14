/**
 * Library entry point.
 *
 * Portolan's core is usable without MCP (SPEC.md §58): the catalog, search, execution
 * runtime and sandbox are all reachable from here.
 */
export { createPortolan, type Portolan, type CreatePortolanOptions } from './app.js';
export { Catalog, networkPolicyFrom } from './catalog/catalog.js';
export { inspectOperations } from './catalog/inspector.js';
export { loadConfig, parseConfig, type PortolanConfig } from './config/config.js';
export { PortolanError, ERROR_CODES, type ErrorCode, type ErrorEnvelope } from './errors/errors.js';
export { createMcpServer, SERVER_NAME, SERVER_VERSION } from './mcp/server.js';
export { TOOL_NAMES, TOOL_DESCRIPTIONS, SERVER_INSTRUCTIONS } from './mcp/tools/index.js';
export { FtsSearchProvider } from './search/fts-search-provider.js';
export { SandboxRunner } from './sandbox/runner.js';
export { Caller } from './execution/caller.js';
export type * from './services/types.js';
