/**
 * Typed request snippets + their wiring into the snippet pipeline.
 *   SNAPSHOT_UPDATE=1 pnpm test   # to refresh
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseOpenAPI } from '@readme/openapi-parser'
import { getEndpointSnippets } from '../../src/openapi-snippet/index.ts'
import { injectSnippets } from '../../src/pipeline.ts'
import { generateTypedSnippet } from '../../src/schema-codegen/snippet.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const SNAPSHOTS = join(__dirname, '__snapshots__')
const UPDATE = process.env.SNAPSHOT_UPDATE === '1'

// biome-ignore lint/suspicious/noExplicitAny: test fixtures are loosely typed
type AnyApi = any

async function loadApi(): Promise<AnyApi> {
  return (await parseOpenAPI(join(FIXTURES, 'petstore-3.0.yaml'))) as AnyApi
}

describe('schema-codegen / typed snippets', () => {
  it('inlines the response model and parses through it (zod)', async () => {
    const api = await loadApi()
    const out = generateTypedSnippet(api, '/pets/{petId}', 'get', 'typescript_zod')
    assert.match(out, /import \{ z \} from 'zod'/)
    assert.match(out, /export const Pet = z\.object\(/)
    assert.match(out, /const data = Pet\.parse\(await response\.json\(\)\)/)
    assert.match(out, /method: 'GET'/)
    assert.ok(out.includes('https://petstore.example.com/v1/pets/{petId}'))
  })

  it('uses v.parse for valibot', async () => {
    const api = await loadApi()
    const out = generateTypedSnippet(api, '/pets/{petId}', 'get', 'typescript_valibot')
    assert.match(out, /import \* as v from 'valibot'/)
    assert.match(out, /const data = v\.parse\(Pet, await response\.json\(\)\)/)
  })

  it('uses model_validate for a Pydantic class response', async () => {
    const api = await loadApi()
    const out = generateTypedSnippet(api, '/pets/{petId}', 'get', 'python_pydantic')
    assert.match(out, /class Pet\(BaseModel\):/)
    assert.match(out, /data = Pet\.model_validate\(response\.json\(\)\)/)
    assert.match(out, /import requests/)
  })

  it('uses TypeAdapter for a Pydantic array (alias) response', async () => {
    const api = await loadApi()
    const out = generateTypedSnippet(api, '/pets', 'get', 'python_pydantic')
    assert.match(out, /Pets = list\[Pet\]/)
    assert.match(out, /from pydantic import TypeAdapter/)
    assert.match(out, /data = TypeAdapter\(Pets\)\.validate_python\(response\.json\(\)\)/)
  })

  it('emits a request-only snippet when there is no typed JSON body', async () => {
    const api = await loadApi()
    // createPet (POST /pets) has a 201 with no response content.
    const out = generateTypedSnippet(api, '/pets', 'post', 'typescript_zod')
    assert.match(out, /No typed JSON response body/)
    assert.ok(!out.includes('.parse('))
  })

  describe('pipeline wiring', () => {
    it('adds an x-codeSamples entry titled "Typescript + Zod"', async () => {
      const api = await loadApi()
      const result = injectSnippets(api, ['typescript_zod']) as AnyApi
      const samples = result.paths['/pets/{petId}'].get['x-codeSamples']
      assert.equal(samples.length, 1)
      assert.equal(samples[0].lang, 'Typescript + Zod')
      assert.match(samples[0].source, /Pet\.parse\(/)
    })

    it('mixes httpsnippet and schema targets in one operation', async () => {
      const api = await loadApi()
      const result = injectSnippets(api, ['shell_curl', 'typescript_zod']) as AnyApi
      const langs = result.paths['/pets/{petId}'].get['x-codeSamples'].map(
        (s: { lang: string }) => s.lang,
      )
      assert.deepEqual(langs, ['Shell + Curl', 'Typescript + Zod'])
    })

    it('getEndpointSnippets returns the schema snippet with its title', async () => {
      const api = await loadApi()
      const { snippets } = getEndpointSnippets(api, '/pets/{petId}', 'get', ['python_pydantic'])
      assert.equal(snippets.length, 1)
      assert.equal(snippets[0].title, 'Python + Pydantic')
    })
  })

  for (const target of ['typescript_zod', 'typescript_valibot', 'python_pydantic']) {
    it(`matches the golden typed snippet for ${target}`, async () => {
      const api = await loadApi()
      const actual = generateTypedSnippet(api, '/pets/{petId}', 'get', target)
      const snapshot = join(SNAPSHOTS, `snippet.${target}.snap`)
      if (UPDATE) {
        mkdirSync(SNAPSHOTS, { recursive: true })
        writeFileSync(snapshot, actual)
      }
      assert.equal(
        actual,
        readFileSync(snapshot, 'utf8'),
        `Run with SNAPSHOT_UPDATE=1 for ${target}.`,
      )
    })
  }
})
