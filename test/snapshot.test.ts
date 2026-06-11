/**
 * Golden-file snapshot tests for the snippet injection pipeline.
 *
 * These tests load a real OpenAPI fixture, run the pure pipeline, and
 * compare against a checked-in expected file. Update the expected file
 * when the pipeline output legitimately changes:
 *   SNAPSHOT_UPDATE=1 pnpm test
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseOpenAPI } from '@readme/openapi-parser'
import yaml from 'js-yaml'
import { injectSnippets } from '../src/pipeline.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')
const SNAPSHOTS = join(__dirname, '__snapshots__')

const UPDATE = process.env.SNAPSHOT_UPDATE === '1'

async function runPipeline(fixturePath: string, targets: string[]): Promise<string> {
  const api = (await parseOpenAPI(fixturePath)) as unknown as Parameters<typeof injectSnippets>[0]
  const result = injectSnippets(api, targets)
  return yaml.dump(result, { lineWidth: 100 })
}

describe('snapshot — petstore-3.0', () => {
  it('matches the golden file for shell_curl', async () => {
    const fixture = join(FIXTURES, 'petstore-3.0.yaml')
    const snapshot = join(SNAPSHOTS, 'petstore-3.0.shell_curl.yaml')
    const actual = await runPipeline(fixture, ['shell_curl'])
    if (UPDATE) writeFileSync(snapshot, actual)
    assert.equal(
      actual,
      readFileSync(snapshot, 'utf8'),
      'Snapshot mismatch. Run with SNAPSHOT_UPDATE=1.',
    )
  })

  it('matches the golden file for multiple targets', async () => {
    const fixture = join(FIXTURES, 'petstore-3.0.yaml')
    const snapshot = join(SNAPSHOTS, 'petstore-3.0.multi.yaml')
    const actual = await runPipeline(fixture, ['shell_curl', 'node_native', 'python_requests'])
    if (UPDATE) writeFileSync(snapshot, actual)
    assert.equal(
      actual,
      readFileSync(snapshot, 'utf8'),
      'Snapshot mismatch. Run with SNAPSHOT_UPDATE=1.',
    )
  })

  it('golden files exist and are non-empty', () => {
    for (const name of ['petstore-3.0.shell_curl.yaml', 'petstore-3.0.multi.yaml']) {
      const body = readFileSync(join(SNAPSHOTS, name), 'utf8')
      assert.ok(body.length > 0, `expected ${name} to be non-empty`)
      assert.ok(body.includes('x-codeSamples'), `expected ${name} to contain x-codeSamples`)
    }
  })
})
