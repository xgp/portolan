/** MCP server construction (SPEC.md §15, §40, §41). */
import { McpServer } from '@modelcontextprotocol/server';
import type { Portolan } from '../app.js';
import { registerTools, SERVER_INSTRUCTIONS } from './tools/index.js';

export const SERVER_NAME = 'portolan';
export const SERVER_VERSION = '0.1.0';

export function createMcpServer(app: Portolan): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Portolan API Catalog' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, app);
  return server;
}
