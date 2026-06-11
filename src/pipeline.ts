/**
 * Pure-function pipeline for the snippet injection flow.
 * Extracted from the CLI so it can be unit/snapshot tested without
 * oclif's command machinery.
 */
import cloneDeep from 'lodash/cloneDeep.js'
import type { OpenAPI } from 'openapi-types'
import * as OpenAPISnippet from './openapi-snippet/index.ts'

export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const

export type Snippet = { lang: string; source: string }

export function injectSnippets(
  api: OpenAPI.Document,
  targets: readonly string[],
): OpenAPI.Document {
  const clone = cloneDeep(api)
  const paths = clone.paths ?? {}
  for (const path of Object.keys(paths)) {
    const pathItem = paths[path]
    if (!pathItem) continue
    for (const method of Object.keys(pathItem)) {
      if ((HTTP_METHODS as readonly string[]).includes(method)) {
        const samples = fetchSnippets(clone, path, method, targets)
        ;(pathItem as Record<string, Record<string, unknown>>)[method]['x-codeSamples'] = samples
      }
    }
  }
  return clone
}

export function fetchSnippets(
  api: OpenAPI.Document,
  path: string,
  method: string,
  targets: readonly string[],
): Snippet[] {
  return OpenAPISnippet.getEndpointSnippets(api, path, method, [...targets]).snippets.map(
    (snippet: { title: string; content: string }) => ({
      lang: snippet.title,
      source: snippet.content,
    }),
  )
}
