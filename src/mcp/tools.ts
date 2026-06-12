/**
 * Pure tool logic for the MCP server. Each function reads a (preferably
 * dereferenced) OpenAPI document and returns plain data, so it can be unit
 * tested without the MCP transport.
 */
import type { OpenAPI } from 'openapi-types'
import { getEndpointSnippets } from '../openapi-snippet/index.ts'
import { HTTP_METHODS } from '../pipeline.ts'

type AnyRecord = Record<string, unknown>

export type EndpointSummary = {
  method: string
  path: string
  operationId?: string
  summary?: string
}

function pathsOf(api: OpenAPI.Document): Record<string, AnyRecord> {
  return (api.paths ?? {}) as Record<string, AnyRecord>
}

function operationsOf(pathItem: AnyRecord): [string, AnyRecord][] {
  return Object.entries(pathItem).filter(([m]) =>
    (HTTP_METHODS as readonly string[]).includes(m),
  ) as [string, AnyRecord][]
}

function schemasOf(api: OpenAPI.Document): AnyRecord {
  return ((api as { components?: { schemas?: AnyRecord } }).components?.schemas ?? {}) as AnyRecord
}

export function overview(api: OpenAPI.Document): {
  title: string | null
  version: string | null
  openapi: string | null
  pathCount: number
  operationCount: number
  schemaCount: number
} {
  const paths = pathsOf(api)
  let operationCount = 0
  for (const item of Object.values(paths)) operationCount += operationsOf(item).length
  const meta = api as {
    info?: { title?: string; version?: string }
    openapi?: string
    swagger?: string
  }
  return {
    title: meta.info?.title ?? null,
    version: meta.info?.version ?? null,
    openapi: meta.openapi ?? meta.swagger ?? null,
    pathCount: Object.keys(paths).length,
    operationCount,
    schemaCount: Object.keys(schemasOf(api)).length,
  }
}

export function listEndpoints(api: OpenAPI.Document): EndpointSummary[] {
  const out: EndpointSummary[] = []
  const paths = pathsOf(api)
  for (const path of Object.keys(paths)) {
    for (const [method, op] of operationsOf(paths[path])) {
      out.push({
        method: method.toUpperCase(),
        path,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
      })
    }
  }
  return out
}

export function getEndpoint(api: OpenAPI.Document, path: string, method: string): AnyRecord {
  const item = pathsOf(api)[path]
  const op = item?.[method.toLowerCase()] as AnyRecord | undefined
  if (!op) throw new Error(`No ${method.toUpperCase()} operation at path "${path}"`)
  return op
}

export function getSchema(api: OpenAPI.Document, name: string): unknown {
  const schema = schemasOf(api)[name]
  if (schema === undefined) throw new Error(`No schema named "${name}" in components.schemas`)
  return schema
}

export function searchEndpoints(
  api: OpenAPI.Document,
  query: string,
  method?: string,
): EndpointSummary[] {
  const q = query.toLowerCase()
  const wantMethod = method?.toUpperCase()
  return listEndpoints(api).filter((e) => {
    if (wantMethod && e.method !== wantMethod) return false
    const hay = `${e.path} ${e.operationId ?? ''} ${e.summary ?? ''}`.toLowerCase()
    return hay.includes(q)
  })
}

export type CodeSnippetsResult = {
  method: string
  url: string
  snippets: Array<{ id: string; title: string; content: string }>
}

export function getCodeSnippets(
  api: OpenAPI.Document,
  path: string,
  method: string,
  targets?: readonly string[],
): CodeSnippetsResult {
  const chosen = targets && targets.length > 0 ? [...targets] : ['shell_curl']
  const result = getEndpointSnippets(api, path, method.toLowerCase(), chosen) as {
    method: string
    url: string
    snippets: Array<{ id: string; title: string; content: string }>
  }
  return {
    method: result.method,
    url: result.url,
    snippets: result.snippets.map((s) => ({ id: s.id, title: s.title, content: s.content })),
  }
}
