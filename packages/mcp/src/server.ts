/**
 * stdio MCP server exposing tools to explore a single OpenAPI document.
 * Modeled on github.com/LLM-MCP-Servers/swagger-json-mcp, adapted to one
 * already-loaded spec (so there is no swaggerName dimension), plus a
 * code-snippet tool that reuses this project's snippet generator.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { OpenAPI } from 'openapi-types'
import { z } from 'zod'
import * as tools from './tools.ts'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function fail(err: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  }
}

export type ServerInfo = { name?: string; version?: string }

/**
 * Build (but do not connect) an MCP server exposing the spec's tools.
 *
 * `api` should be dereferenced (so inspection tools return resolved schemas).
 * `rawApi` is the non-dereferenced document used by the schema-codegen tools so
 * they can emit named models; it defaults to `api` when not supplied.
 */
export function buildMcpServer(
  api: OpenAPI.Document,
  info?: ServerInfo,
  rawApi: OpenAPI.Document = api,
): McpServer {
  const server = new McpServer({
    name: info?.name ?? 'openapi-snippet',
    version: info?.version ?? '0.0.0',
  })

  server.registerTool(
    'get_overview',
    {
      description: 'API title, version, and counts of paths, operations, and component schemas.',
      inputSchema: {},
    },
    () => ok(tools.overview(api)),
  )

  server.registerTool(
    'list_endpoints',
    {
      description: 'List every operation as { method, path, operationId, summary }.',
      inputSchema: {},
    },
    () => ok(tools.listEndpoints(api)),
  )

  server.registerTool(
    'get_endpoint',
    {
      description: 'Get the full operation object for a given path and method.',
      inputSchema: { path: z.string(), method: z.string() },
    },
    ({ path, method }) => {
      try {
        return ok(tools.getEndpoint(api, path, method))
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'get_schema',
    {
      description: 'Get a named component schema (components.schemas[name]).',
      inputSchema: { name: z.string() },
    },
    ({ name }) => {
      try {
        return ok(tools.getSchema(api, name))
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'search_endpoints',
    {
      description:
        'Search operations by substring across path, operationId, and summary; optional method filter.',
      inputSchema: { query: z.string(), method: z.string().optional() },
    },
    ({ query, method }) => ok(tools.searchEndpoints(api, query, method)),
  )

  server.registerTool(
    'get_code_snippets',
    {
      description:
        'Generate request code snippets for an operation. `targets` are openapi-snippet ids (e.g. shell_curl, python_requests); defaults to shell_curl.',
      inputSchema: {
        path: z.string(),
        method: z.string(),
        targets: z.array(z.string()).optional(),
      },
    },
    ({ path, method, targets }) => {
      try {
        return ok(tools.getCodeSnippets(api, path, method, targets))
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'generate_models',
    {
      description:
        'Generate typed data models from components.schemas. `target` is one of ' +
        'typescript_zod, typescript_valibot, python_pydantic.',
      inputSchema: { target: z.string() },
    },
    ({ target }) => {
      try {
        return ok(tools.generateModels(rawApi, target))
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'get_typed_snippet',
    {
      description:
        'Generate a self-contained typed request snippet (inline models + request + ' +
        'typed parse) for an operation. `target` is one of typescript_zod, ' +
        'typescript_valibot, python_pydantic.',
      inputSchema: { path: z.string(), method: z.string(), target: z.string() },
    },
    ({ path, method, target }) => {
      try {
        return ok(tools.getTypedSnippet(rawApi, path, method, target))
      } catch (err) {
        return fail(err)
      }
    },
  )

  return server
}

/** Build the server and serve it over stdio until the client disconnects. */
export async function runMcpStdio(
  api: OpenAPI.Document,
  info?: ServerInfo,
  rawApi?: OpenAPI.Document,
): Promise<void> {
  const server = buildMcpServer(api, info, rawApi)
  await server.connect(new StdioServerTransport())
}
