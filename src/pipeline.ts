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

/** Options controlling how snippet injection handles per-operation failures. */
export type InjectOptions = {
  /** When true, an operation whose snippet generation throws is skipped
   *  instead of aborting the whole document. */
  skipErrors?: boolean
  /** Invoked for each skipped operation (only when skipErrors is true). */
  onSkip?: (path: string, method: string, err: Error) => void
}

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
 *
 * By default a single operation that the snippet generator cannot handle
 * aborts the whole run. Pass `{ skipErrors: true }` to skip such operations
 * (leaving them intact, without `x-codeSamples`) and continue.
 */
export function injectSnippets(
  api: OpenAPI.Document,
  targets: readonly string[],
  options?: InjectOptions,
): OpenAPI.Document {
  const originalPaths = api.paths ?? {}
  const newPaths: Record<string, unknown> = {}
  for (const path of Object.keys(originalPaths)) {
    const originalPathItem = originalPaths[path] as Record<string, unknown> | undefined
    if (!originalPathItem) continue
    newPaths[path] = enrichPathItem(api, path, originalPathItem, targets, options)
  }
  return { ...api, paths: newPaths } as OpenAPI.Document
}

/**
 * Return a path-item with `x-codeSamples` added to each HTTP operation.
 * Returns the original object unchanged (shared by reference) when no
 * operation was annotated, keeping memory bounded to modified operations.
 */
function enrichPathItem(
  api: OpenAPI.Document,
  path: string,
  originalPathItem: Record<string, unknown>,
  targets: readonly string[],
  options: InjectOptions | undefined,
): Record<string, unknown> {
  let modified = false
  const newPathItem: Record<string, unknown> = {}
  for (const method of Object.keys(originalPathItem)) {
    if (!(HTTP_METHODS as readonly string[]).includes(method)) {
      newPathItem[method] = originalPathItem[method]
      continue
    }
    const originalOp = originalPathItem[method] as Record<string, unknown>
    try {
      newPathItem[method] = {
        ...originalOp,
        'x-codeSamples': fetchSnippets(api, path, method, targets),
      }
      modified = true
    } catch (err) {
      if (!options?.skipErrors) throw err
      options.onSkip?.(path, method, err instanceof Error ? err : new Error(String(err)))
      newPathItem[method] = originalOp
    }
  }
  if (!modified) return originalPathItem
  // Copy any other path-level keys (summary, parameters, servers, etc.)
  for (const k of Object.keys(originalPathItem)) {
    if (!(k in newPathItem)) newPathItem[k] = originalPathItem[k]
  }
  return newPathItem
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
  options?: InjectOptions,
): void {
  if (format === 'json') {
    // JSON is dumped once because splitting across chunks produces
    // invalid JSON. The injection is still bounded — `injectSnippets`
    // does not deep-clone.
    const enriched = injectSnippets(spec, targets, options)
    out.write(JSON.stringify(enriched, null, 2))
    out.write('\n')
    return
  }

  const originalPaths = spec.paths ?? {}
  const allKeys = Object.keys(originalPaths)
  const { head, tail } = splitHeadTail(spec)

  // Write head (which already ends with `paths:\n`).
  out.write(head)

  let lastChunkEndedWithNewline = false
  for (let i = 0; i < allKeys.length; i += chunkSize) {
    const keys = allKeys.slice(i, i + chunkSize)
    const slice: Record<string, unknown> = {}
    for (const k of keys) slice[k] = originalPaths[k]
    const enriched = injectSnippets({ ...spec, paths: slice } as OpenAPI.Document, targets, options)
    // Dump the chunk's paths and strip the leading `paths:\n` line.
    // Keep the trailing newline: it terminates any literal block
    // scalars (`|-`) at the end of the chunk, and the next chunk's
    // leading line will be a properly-indented `  /path:` key.
    const dumped = yaml.dump({ paths: enriched.paths }, { lineWidth: 100, sortKeys: false })
    const firstNewline = dumped.indexOf('\n')
    if (firstNewline !== -1) {
      const body = dumped.slice(firstNewline + 1)
      out.write(body)
      lastChunkEndedWithNewline = body.endsWith('\n')
    }
  }

  // Write tail (everything after `paths:`). If the previous write
  // ended with a newline, no separator is needed; otherwise add one.
  // This keeps the boundary tight (one `\n` between blocks) without
  // corrupting any in-flight literal block scalars.
  if (tail !== '') {
    if (!lastChunkEndedWithNewline) out.write('\n')
    out.write(tail)
  }
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

/** Default CDN bundle used to render the Redoc HTML page. */
export const REDOC_BUNDLE_URL = 'https://cdn.redocly.com/redoc/latest/bundles/redoc.standalone.js'

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}

/**
 * Render a standalone Redoc HTML page for the given spec. The spec is inlined
 * (so the page is self-contained apart from the Redoc bundle, which is loaded
 * from {@link REDOC_BUNDLE_URL}). Redoc renders `x-codeSamples` natively, so an
 * enriched spec shows its code snippets.
 *
 * `<` characters in the inlined JSON are escaped to `<` so a string such
 * as `</script>` in the spec cannot break out of the script tag.
 */
export function renderHtml(api: OpenAPI.Document): string {
  const title = (api as { info?: { title?: string } }).info?.title ?? 'API documentation'
  const specJson = JSON.stringify(api).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <div id="redoc"></div>
    <script src="${REDOC_BUNDLE_URL}"></script>
    <script>
      Redoc.init(${specJson}, {}, document.getElementById('redoc'))
    </script>
  </body>
</html>
`
}
