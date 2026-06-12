import assert from 'node:assert/strict'
import type { OpenAPI } from 'openapi-types'
import { renderTagIndexHtml, slugifyTag, splitByTag } from '../src/split.ts'

const spec = {
  openapi: '3.0.0',
  info: { title: 'Split Me', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  tags: [
    { name: 'pets', description: 'Pet ops' },
    { name: 'store', description: 'Store ops' },
  ],
  paths: {
    '/pets': {
      get: { operationId: 'listPets', tags: ['pets'], responses: { '200': { description: 'OK' } } },
      post: {
        operationId: 'addPet',
        // multi-tag: should appear under BOTH pets and store
        tags: ['pets', 'store'],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/orders': {
      get: {
        operationId: 'listOrders',
        tags: ['store'],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
        },
      },
    },
    '/health': {
      // no tags -> untagged bucket
      get: { operationId: 'health', responses: { '200': { description: 'OK' } } },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        properties: { id: { type: 'string' }, category: { $ref: '#/components/schemas/Category' } },
      },
      Category: { type: 'object', properties: { name: { type: 'string' } } },
      Order: { type: 'object', properties: { id: { type: 'string' } } },
      Unused: { type: 'object', properties: { x: { type: 'string' } } },
    },
  },
} as unknown as OpenAPI.Document

const byTag = (docs: ReturnType<typeof splitByTag>) =>
  Object.fromEntries(docs.map((d) => [d.tag, d.document]))

describe('splitByTag', () => {
  it('produces one document per tag, untagged last', () => {
    const docs = splitByTag(spec)
    assert.deepEqual(
      docs.map((d) => d.tag),
      ['pets', 'store', 'untagged'],
    )
  })

  it('duplicates a multi-tag operation under each of its tags', () => {
    const t = byTag(splitByTag(spec))
    assert.ok((t.pets.paths as Record<string, unknown>)['/pets'])
    // addPet is tagged pets+store, so /pets POST shows up in the store doc too
    const storePets = (t.store.paths as Record<string, Record<string, unknown>>)['/pets']
    assert.ok(storePets?.post, 'addPet should appear under store')
    assert.ok(!storePets?.get, 'listPets (pets-only) should NOT appear under store')
  })

  it('buckets untagged operations under "untagged"', () => {
    const t = byTag(splitByTag(spec))
    assert.ok((t.untagged.paths as Record<string, unknown>)['/health'])
    assert.ok(!(t.untagged.paths as Record<string, unknown>)['/pets'])
  })

  it('prunes components to each tag’s transitive $ref closure', () => {
    const t = byTag(splitByTag(spec))
    const petsSchemas = Object.keys(
      (t.pets.components as { schemas: Record<string, unknown> }).schemas,
    )
    // pets references Pet -> Category (transitive); never Order or Unused
    assert.deepEqual(petsSchemas.sort(), ['Category', 'Pet'])
    const storeSchemas = Object.keys(
      (t.store.components as { schemas: Record<string, unknown> }).schemas,
    ).sort()
    // store has addPet (Pet->Category) and listOrders (Order)
    assert.deepEqual(storeSchemas, ['Category', 'Order', 'Pet'])
    // Unused is referenced by nobody and must not leak anywhere
    for (const d of Object.values(t)) {
      const schemas = (d.components as { schemas?: Record<string, unknown> })?.schemas ?? {}
      assert.ok(!('Unused' in schemas), 'Unused schema must be pruned everywhere')
    }
  })

  it('narrows the top-level tags list to the current tag', () => {
    const t = byTag(splitByTag(spec))
    assert.deepEqual((t.pets as { tags: { name: string }[] }).tags, [
      { name: 'pets', description: 'Pet ops' },
    ])
    assert.ok(!('tags' in t.untagged) || (t.untagged as { tags?: unknown }).tags === undefined)
  })

  it('preserves shared top-level fields', () => {
    const t = byTag(splitByTag(spec))
    assert.equal((t.pets as { info: { title: string } }).info.title, 'Split Me')
    assert.deepEqual((t.pets as { servers: unknown }).servers, [{ url: 'https://api.example.com' }])
  })
})

describe('slugifyTag', () => {
  it('makes a filesystem-safe stem', () => {
    assert.equal(slugifyTag('Pet Store'), 'pet-store')
    assert.equal(slugifyTag('User/Admin (v2)'), 'user-admin-v2')
    assert.equal(slugifyTag('   '), 'untitled')
  })
})

describe('renderTagIndexHtml', () => {
  it('lists links to each per-tag page and escapes content', () => {
    const html = renderTagIndexHtml('My API', [
      { tag: 'pets', href: 'pets.html' },
      { tag: 'a&b', href: 'a-b.html' },
    ])
    assert.match(html, /<a href="pets\.html">pets<\/a>/)
    assert.match(html, /a&amp;b/)
    assert.match(html, /<title>My API<\/title>/)
  })
})
