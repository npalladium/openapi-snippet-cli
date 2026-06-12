/**
 * Split an OpenAPI document into one sub-document per tag, so docs/snippets
 * can be emitted as a folder of smaller files instead of one huge page.
 *
 * Each sub-document keeps only the operations carrying that tag (an operation
 * with several tags appears under each), and its `components` are pruned to the
 * transitive `$ref` closure of those operations — which is what keeps the
 * per-tag Redoc pages small.
 */
import type { OpenAPI } from 'openapi-types'
import { HTTP_METHODS } from './pipeline.ts'

export type TagDocument = { tag: string; document: OpenAPI.Document }

export type SplitOptions = {
  /** Bucket name for operations that declare no tags. Default: `untagged`. */
  untaggedName?: string
}

type AnyRecord = Record<string, unknown>

/** Collect every `$ref` string reachable from a value. */
function collectRefs(node: unknown, acc: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc)
    return
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') acc.add(value)
      else collectRefs(value, acc)
    }
  }
}

/** Parse a local component ref into `[section, name]`, or null if external. */
function parseComponentRef(ref: string): [string, string] | null {
  const prefix = '#/components/'
  if (!ref.startsWith(prefix)) return null
  const rest = ref.slice(prefix.length).split('/')
  if (rest.length < 2) return null
  const [section, ...nameParts] = rest
  return [section, nameParts.join('/')]
}

/**
 * Given seed refs, walk the document's components to find the full set of
 * components that must be retained (following refs between components).
 * Returns a map of `section -> Set<name>`.
 */
function transitiveComponents(
  components: AnyRecord,
  seedRefs: Iterable<string>,
): Map<string, Set<string>> {
  const needed = new Map<string, Set<string>>()
  const visited = new Set<string>()
  const queue = [...seedRefs]
  while (queue.length > 0) {
    const ref = queue.pop() as string
    if (visited.has(ref)) continue
    visited.add(ref)
    const parsed = parseComponentRef(ref)
    if (!parsed) continue
    const [section, name] = parsed
    const node = (components[section] as AnyRecord | undefined)?.[name]
    if (node === undefined) continue
    if (!needed.has(section)) needed.set(section, new Set())
    needed.get(section)?.add(name)
    const sub = new Set<string>()
    collectRefs(node, sub)
    for (const r of sub) if (!visited.has(r)) queue.push(r)
  }
  return needed
}

/**
 * Build a pruned `components` object containing only the needed entries.
 * `securitySchemes` are kept whole (they are referenced by name from
 * `security`, not via `$ref`, and are small).
 */
function pruneComponents(components: AnyRecord, needed: Map<string, Set<string>>): AnyRecord {
  const out: AnyRecord = {}
  for (const [section, names] of needed) {
    const src = components[section] as AnyRecord | undefined
    if (!src) continue
    const kept: AnyRecord = {}
    for (const name of names) if (name in src) kept[name] = src[name]
    if (Object.keys(kept).length > 0) out[section] = kept
  }
  if (components.securitySchemes) out.securitySchemes = components.securitySchemes
  return out
}

/** Tags of an operation, defaulting to `[untaggedName]` when none are present. */
function operationTags(op: AnyRecord, untaggedName: string): string[] {
  const tags = op.tags
  if (Array.isArray(tags) && tags.length > 0) return tags.filter((t) => typeof t === 'string')
  return [untaggedName]
}

const isMethod = (k: string): boolean => (HTTP_METHODS as readonly string[]).includes(k)

/**
 * Group operations by tag: returns `tag -> (path -> partial path-item)`, where
 * each partial path-item carries the path-level keys plus only the operations
 * bearing that tag. A multi-tag operation is added to every matching bucket.
 */
type BucketFn = (tag: string) => Record<string, AnyRecord>

/** Add one path-item's operations into the per-tag buckets. */
function assignPath(
  bucketFor: BucketFn,
  path: string,
  item: AnyRecord,
  untaggedName: string,
): void {
  const pathLevel: AnyRecord = {}
  for (const [k, v] of Object.entries(item)) if (!isMethod(k)) pathLevel[k] = v
  for (const method of Object.keys(item)) {
    if (!isMethod(method)) continue
    const op = item[method] as AnyRecord
    for (const tag of operationTags(op, untaggedName)) {
      const bucket = bucketFor(tag)
      if (!bucket[path]) bucket[path] = { ...pathLevel }
      bucket[path][method] = op
    }
  }
}

function groupByTag(
  paths: Record<string, AnyRecord>,
  untaggedName: string,
): Map<string, Record<string, AnyRecord>> {
  const byTag = new Map<string, Record<string, AnyRecord>>()
  const bucketFor: BucketFn = (tag) => {
    const existing = byTag.get(tag)
    if (existing) return existing
    const created: Record<string, AnyRecord> = {}
    byTag.set(tag, created)
    return created
  }

  for (const [path, item] of Object.entries(paths)) {
    if (item && typeof item === 'object') assignPath(bucketFor, path, item, untaggedName)
  }
  return byTag
}

/**
 * Split a (typically already snippet-enriched) document into one document per
 * tag. Returns the tags sorted alphabetically, with the untagged bucket last.
 */
export function splitByTag(api: OpenAPI.Document, options: SplitOptions = {}): TagDocument[] {
  const untaggedName = options.untaggedName ?? 'untagged'
  const components = ((api as AnyRecord).components ?? {}) as AnyRecord
  // Pull `tags` out of the base so each sub-doc starts without it; we re-add a
  // narrowed list per tag (avoids a `delete` on the spread copy).
  const { tags: topTags, ...baseApi } = api as AnyRecord
  const declaredTags = Array.isArray(topTags) ? (topTags as AnyRecord[]) : []

  const byTag = groupByTag((api.paths ?? {}) as Record<string, AnyRecord>, untaggedName)

  const tagNames = [...byTag.keys()].sort((a, b) => {
    if (a === untaggedName) return 1
    if (b === untaggedName) return -1
    return a < b ? -1 : a > b ? 1 : 0
  })

  return tagNames.map((tag) => {
    const subPaths = byTag.get(tag) as Record<string, AnyRecord>
    const seed = new Set<string>()
    collectRefs(subPaths, seed)
    const doc: AnyRecord = { ...baseApi, paths: subPaths }
    if ((api as AnyRecord).components) {
      doc.components = pruneComponents(components, transitiveComponents(components, seed))
    }
    const match = declaredTags.filter((t) => t.name === tag)
    if (match.length > 0) doc.tags = match
    return { tag, document: doc as OpenAPI.Document }
  })
}

/** Filesystem-safe slug for a tag name (used as the output file stem). */
export function slugifyTag(tag: string): string {
  const slug = tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'untitled'
}

const INDEX_HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => INDEX_HTML_ESCAPES[c] ?? c)

/**
 * Render a simple index page linking to per-tag HTML files. Used when splitting
 * HTML output so the folder has a browsable entry point.
 */
export function renderTagIndexHtml(
  title: string,
  entries: { tag: string; href: string }[],
): string {
  const items = entries
    .map((e) => `      <li><a href="${escapeHtml(e.href)}">${escapeHtml(e.tag)}</a></li>`)
    .join('\n')
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; }
      li { margin: 0.3rem 0; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <ul>
${items}
    </ul>
  </body>
</html>
`
}
