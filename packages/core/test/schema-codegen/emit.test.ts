/**
 * Golden-file tests for the schema-codegen backends. Snapshots use a `.snap`
 * extension so Biome/TypeScript ignore the generated source.
 *   SNAPSHOT_UPDATE=1 pnpm test   # to refresh
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseOpenAPI } from '@readme/openapi-parser'
import {
  generateModels,
  isSchemaTarget,
  SCHEMA_TARGET_IDS,
} from '../../src/schema-codegen/index.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const SNAPSHOTS = join(__dirname, '__snapshots__')
const UPDATE = process.env.SNAPSHOT_UPDATE === '1'

async function schemasOf(fixture: string): Promise<Record<string, unknown>> {
  const api = (await parseOpenAPI(join(FIXTURES, fixture))) as unknown as {
    components?: { schemas?: Record<string, unknown> }
  }
  return api.components?.schemas ?? {}
}

describe('schema-codegen / emit', () => {
  it('recognizes exactly the three schema targets', () => {
    assert.deepEqual([...SCHEMA_TARGET_IDS].sort(), [
      'python_pydantic',
      'typescript_valibot',
      'typescript_zod',
    ])
    assert.equal(isSchemaTarget('typescript_zod'), true)
    assert.equal(isSchemaTarget('shell_curl'), false)
  })

  for (const target of ['typescript_zod', 'typescript_valibot', 'python_pydantic']) {
    it(`matches the golden models for ${target}`, async () => {
      const schemas = await schemasOf('petstore-3.0.yaml')
      const actual = generateModels(schemas, target)
      const snapshot = join(SNAPSHOTS, `petstore-3.0.${target}.snap`)
      if (UPDATE) {
        mkdirSync(SNAPSHOTS, { recursive: true })
        writeFileSync(snapshot, actual)
      }
      assert.equal(
        actual,
        readFileSync(snapshot, 'utf8'),
        `Snapshot mismatch for ${target}. Run with SNAPSHOT_UPDATE=1.`,
      )
    })
  }

  it('orders dependencies before dependents (Pet before Pets)', () => {
    const out = generateModels(
      {
        Pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
        Pet: { type: 'object', properties: { id: { type: 'integer' } } },
      },
      'python_pydantic',
    )
    assert.ok(out.indexOf('class Pet(') < out.indexOf('Pets ='), 'Pet must precede Pets')
  })
})
