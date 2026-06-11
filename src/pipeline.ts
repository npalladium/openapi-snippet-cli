/**
 * Pure-function pipeline for the snippet injection flow.
 * Extracted from the CLI so it can be unit/snapshot tested without
 * oclif's command machinery.
 */
import type { Writable } from 'node:stream'
import yaml from 'js-yaml'
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

/**
 * Inject code samples into every HTTP operation of the given spec.
 *
 * Avoids deep-cloning the entire document. Instead it builds a new
 * top-level spec object whose `paths` map is a fresh object, but
 * individual path/method objects are reused from the input unless
 * they receive new `x-codeSamples`. Unchanged parts of the spec
 * (info, components, servers, etc.) are shared by reference.
 *
 * This keeps memory roughly O(modified operations) instead of
 * O(full spec) — a big win for large swaggers.
 */
export function injectSnippets(
  api: OpenAPI.Document,
  targets: readonly string[],
): OpenAPI.Document {
  const originalPaths = api.paths ?? {}
  const newPaths: Record<string, unknown> = {}
  for (const path of Object.keys(originalPaths)) {
    const originalPathItem = originalPaths[path] as Record<string, unknown> | undefined
    if (!originalPathItem) continue

    let modified = false
    const newPathItem: Record<string, unknown> = {}
    for (const method of Object.keys(originalPathItem)) {
      if (!(HTTP_METHODS as readonly string[]).includes(method)) {
        newPathItem[method] = originalPathItem[method]
        continue
      }
      const originalOp = originalPathItem[method] as Record<string, unknown>
      newPathItem[method] = {
        ...originalOp,
        'x-codeSamples': fetchSnippets(api, path, method, targets),
      }
      modified = true
    }
    if (modified) {
      // Copy any other path-level keys (summary, parameters, servers, etc.)
      for (const k of Object.keys(originalPathItem)) {
        if (!(k in newPathItem)) newPathItem[k] = originalPathItem[k]
      }
      newPaths[path] = newPathItem
    } else {
      newPaths[path] = originalPathItem
    }
  }
  return { ...api, paths: newPaths } as OpenAPI.Document
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

/**
 * Iterate the spec's operations in chunks of `size`, yielding the
 * chunk's path keys. Used by the CLI's chunked serialization path.
 */
export function* iterPathChunks(api: OpenAPI.Document, size: number): Generator<string[]> {
  const paths = Object.keys(api.paths ?? {})
  for (let i = 0; i < paths.length; i += size) {
    yield paths.slice(i, i + size)
  }
}

export type SerializeFormat = 'yaml' | 'json'

/**
 * Serialize a spec in chunks, writing incrementally to a stream.
 * Drops peak memory and total time on large swaggers because
 * each chunk's `yaml.dump` is bounded by `chunkSize` paths.
 *
 * The output is a valid OpenAPI document equivalent to one built
 * by `yaml.dump(injectSnippets(spec))`. Empty trailing `paths:`
 * blocks in head/tail (if any) are elided.
 */
export function serializeChunked(
  spec: OpenAPI.Document,
  targets: readonly string[],
  format: SerializeFormat,
  chunkSize: number,
  out: Writable,
): void {
  if (format === 'json') {
    // JSON is dumped once because splitting across chunks produces
    // invalid JSON. The injection is still bounded — `injectSnippets`
    // does not deep-clone.
    const enriched = injectSnippets(spec, targets)
    out.write(JSON.stringify(enriched, null, 2))
    out.write('\n')
    return
  }

  const originalPaths = spec.paths ?? {}
  const allKeys = Object.keys(originalPaths)
  const { head, tail } = splitHeadTail(spec)

  // Write head (which already ends with `paths:\n`).
  out.write(head)

  for (let i = 0; i < allKeys.length; i += chunkSize) {
    const keys = allKeys.slice(i, i + chunkSize)
    const slice: Record<string, unknown> = {}
    for (const k of keys) slice[k] = originalPaths[k]
    const enriched = injectSnippets({ ...spec, paths: slice } as OpenAPI.Document, targets)
    // Dump the chunk's paths and strip the `paths:\n` prefix.
    const dumped = yaml.dump({ paths: enriched.paths }, { lineWidth: 100, sortKeys: false })
    const firstNewline = dumped.indexOf('\n')
    if (firstNewline !== -1) {
      out.write(dumped.slice(firstNewline + 1))
    }
  }

  // Write tail (everything after `paths:`). Skip a leading `paths:`
  // if present (defensive — our skeleton shouldn't have one).
  if (tail.trim() !== '') {
    out.write('\n')
    out.write(tail)
  }
  out.write('\n')
}

/**
 * Split the spec into a "head" (keys before `paths` in input order)
 * and a "tail" (keys after `paths` in input order). The head ends
 * with `paths:\n` so callers can append chunked path entries at
 * the right indent.
 */
function splitHeadTail(spec: OpenAPI.Document): { head: string; tail: string } {
  const entries = Object.entries(spec)
  const pathsIdx = entries.findIndex(([k]) => k === 'paths')
  const headEntries = pathsIdx >= 0 ? entries.slice(0, pathsIdx) : entries
  const tailEntries = pathsIdx >= 0 ? entries.slice(pathsIdx + 1) : []

  const headDoc: Record<string, unknown> = Object.fromEntries(headEntries)
  const tailDoc: Record<string, unknown> = Object.fromEntries(tailEntries)

  const headYaml = yaml.dump(headDoc, { lineWidth: 100, sortKeys: false })
  const tailYaml =
    tailEntries.length > 0 ? yaml.dump(tailDoc, { lineWidth: 100, sortKeys: false }) : ''

  return { head: headYaml === '' ? '' : `${headYaml}paths:\n`, tail: tailYaml }
}
