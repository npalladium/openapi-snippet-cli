/**
 * Performance / large-spec tests.
 *
 * Generates a synthetic OpenAPI document of N operations and asserts
 * the snippet injection pipeline finishes within a time and memory
 * budget. This is the choke-point test: when this fails, the tool
 * is too slow or too memory-hungry for real-world swaggers.
 */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { Writable } from 'node:stream'
import { parse as parseOpenAPI } from '@readme/openapi-parser'
import yaml from 'js-yaml'
import { injectSnippets, serializeChunked } from '../src/pipeline.ts'

/**
 * Build a synthetic spec with `paths * methodsPerPath` operations.
 * Each operation references a shared schema so we exercise the ref
 * resolver (the typical hot path for large swaggers).
 */
function buildLargeSpec(paths: number, methodsPerPath: number) {
  const methodList = ['get', 'post', 'put', 'delete'].slice(0, methodsPerPath)
  const out: Record<string, unknown> = {}
  for (let i = 0; i < paths; i++) {
    const pathItem: Record<string, unknown> = {}
    for (const m of methodList) {
      pathItem[m] = {
        operationId: `${m}${i}`,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: `r${i}` },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Resource' },
              },
            },
          },
        },
        requestBody:
          m === 'post' || m === 'put'
            ? {
                required: true,
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Resource' } },
                },
              }
            : undefined,
      }
    }
    out[`/resource${i}`] = pathItem
  }
  return {
    openapi: '3.0.3',
    info: { title: 'Large', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: out,
    components: {
      schemas: {
        Resource: {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' } },
        },
      },
    },
  }
}

const MEMORY_BUDGET_MB = 300
const TIME_BUDGET_MS = 5000

describe('large spec — performance', () => {
  it('handles 10000 operations in under 5s and under 300 MB', async function () {
    this.timeout(30_000) // mocha timeout

    const spec = buildLargeSpec(2500, 4) // 10000 operations
    const json = JSON.stringify(spec)
    // Force the spec to be parsed (this is the dominant cost in practice).
    const t0 = performance.now()
    const parsed = (await parseOpenAPI(JSON.parse(json))) as Parameters<typeof injectSnippets>[0]
    const tParsed = performance.now() - t0
    assert.ok(
      tParsed < TIME_BUDGET_MS,
      `parseOpenAPI took ${tParsed.toFixed(0)}ms (budget ${TIME_BUDGET_MS}ms)`,
    )

    const memBefore = process.memoryUsage().rss
    const t1 = performance.now()
    const result = injectSnippets(parsed, ['shell_curl'])
    const tInject = performance.now() - t1
    const memAfter = process.memoryUsage().rss
    const memDeltaMB = (memAfter - memBefore) / 1024 / 1024

    assert.ok(
      tInject < TIME_BUDGET_MS,
      `injectSnippets took ${tInject.toFixed(0)}ms (budget ${TIME_BUDGET_MS}ms)`,
    )
    assert.ok(
      memDeltaMB < MEMORY_BUDGET_MB,
      `injectSnippets used ${memDeltaMB.toFixed(0)}MB (budget ${MEMORY_BUDGET_MB}MB)`,
    )

    // Sanity: every operation has at least one code sample.
    let sampleCount = 0
    for (const path of Object.keys(result.paths ?? {})) {
      const pathItem = (result.paths as Record<string, Record<string, unknown>>)[path]
      for (const m of ['get', 'post', 'put', 'delete']) {
        const op = pathItem[m] as { ['x-codeSamples']?: unknown[] } | undefined
        if (op?.['x-codeSamples']) sampleCount += op['x-codeSamples'].length
      }
    }
    assert.ok(sampleCount === 10000, `expected 10000 code samples, got ${sampleCount}`)
  })

  it('serializes to YAML without throwing on a 10000-operation spec', () => {
    const spec = buildLargeSpec(2500, 4)
    const t0 = performance.now()
    const result = injectSnippets(spec as Parameters<typeof injectSnippets>[0], ['shell_curl'])
    const t1 = performance.now()
    const dump = yaml.dump(result, { lineWidth: 100 })
    const t2 = performance.now()
    assert.ok(dump.length > 0)
    // Soft assertions: just report the timings. Hard cap is 5x the inject time.
    assert.ok(
      t2 - t1 < (t1 - t0) * 5 + 2000,
      `yaml.dump took ${(t2 - t1).toFixed(0)}ms vs inject ${(t1 - t0).toFixed(0)}ms`,
    )
  })
})

/** Collect chunks written to a Writable stream. */
function makeCollector(): Writable & { data: string } {
  const w = new Writable({
    write(chunk, _enc, cb) {
      w.data += chunk.toString()
      cb()
    },
  })
  w.data = ''
  return w
}

describe('large spec — chunked serialization', () => {
  it('chunked output round-trips to the same data as the one-shot version', () => {
    const spec = buildLargeSpec(500, 4) as Parameters<typeof injectSnippets>[0]
    const oneShot = yaml.dump(injectSnippets(spec, ['shell_curl']), { lineWidth: 100 })

    const sink = makeCollector()
    serializeChunked(spec, ['shell_curl'], 'yaml', 100, sink)
    const chunked = sink.data

    // Both must parse to equivalent data.
    const oneShotDoc = yaml.load(oneShot) as Record<string, unknown>
    const chunkedDoc = yaml.load(chunked) as Record<string, unknown>
    assert.deepEqual(
      Object.keys(oneShotDoc.paths ?? {}).sort(),
      Object.keys((chunkedDoc.paths ?? {}) as object).sort(),
      'chunked output has different path set',
    )
    // Compare a sampled path's operation content.
    const samplePath = Object.keys(oneShotDoc.paths ?? {})[0]
    const oneOp = (oneShotDoc.paths as Record<string, Record<string, unknown>>)[samplePath]
    const chOp = (chunkedDoc.paths as Record<string, Record<string, unknown>>)[samplePath]
    assert.equal(oneOp.get?.['x-codeSamples']?.length, chOp.get?.['x-codeSamples']?.length)
  })

  it('chunked serialization is faster than one-shot on a 5000-path spec', function () {
    this.timeout(15_000)
    const spec = buildLargeSpec(1250, 4) as Parameters<typeof injectSnippets>[0]

    const t0 = performance.now()
    yaml.dump(injectSnippets(spec, ['shell_curl']), { lineWidth: 100 })
    const tOneShot = performance.now() - t0

    const t1 = performance.now()
    const sink = makeCollector()
    serializeChunked(spec, ['shell_curl'], 'yaml', 100, sink)
    const tChunked = performance.now() - t1

    // The chunked path should be at least 1.5x faster on this size.
    // (Empirically ~3-7x in profiling; 1.5x is a loose floor to avoid
    // CI flakes on slow machines.)
    assert.ok(
      tChunked < tOneShot / 1.5,
      `chunked=${tChunked.toFixed(0)}ms, one-shot=${tOneShot.toFixed(0)}ms (chunked should be 1.5x faster)`,
    )
  })

  it('chunked output is byte-identical to no-chunk at any chunk size', () => {
    // Use a spec that generates long literal block scalars so we
    // exercise the `|-` boundary handling. Both one-shot and chunked
    // paths must produce byte-identical output because the pipeline
    // code is responsible for emitting the same boundary whitespace.
    const spec = buildLargeSpec(60, 4) as Parameters<typeof injectSnippets>[0]
    // Inject once to get the reference one-shot output.
    const oneShot = yaml.dump(injectSnippets(spec, ['shell_curl']), { lineWidth: 100 })

    // Test multiple chunk sizes; all must produce byte-identical output.
    for (const chunkSize of [1, 5, 10, 20, 60, 200]) {
      const sink = makeCollector()
      serializeChunked(spec, ['shell_curl'], 'yaml', chunkSize, sink)
      assert.equal(
        sink.data,
        oneShot,
        `chunk-size=${chunkSize}: chunked output should be byte-identical to one-shot`,
      )
    }
  })
})
