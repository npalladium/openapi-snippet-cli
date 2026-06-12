import assert from 'node:assert/strict'
import type { OpenAPI } from 'openapi-types'
import { getEndpointSnippets } from '../src/openapi-snippet/index.ts'

const spec = {
  openapi: '3.0.0',
  info: { title: 'Samples', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    // path param with NO example/default — used to render as %7Bid%7D
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    // request body whose plain-string fields have no example/format
    '/users': {
      post: {
        operationId: 'createUser',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string' },
                  age: { type: 'integer' },
                  active: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    // media-type level example the author provided explicitly
    '/widgets': {
      post: {
        operationId: 'createWidget',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { label: { type: 'string' } } },
              example: { label: 'Deluxe Widget' },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
  },
} as unknown as OpenAPI.Document

const curl = (path: string, method: string, opts = {}) =>
  getEndpointSnippets(spec, path, method, ['shell_curl'], {}, opts).snippets[0].content as string

describe('snippet URL: path parameter substitution', () => {
  it('substitutes an un-exampled path param instead of emitting %7Bid%7D', () => {
    const result = getEndpointSnippets(spec, '/users/{id}', 'get', ['shell_curl'])
    assert.ok(!result.url.includes('%7B'), `url should not contain encoded braces: ${result.url}`)
    assert.ok(
      !result.url.includes('{id}'),
      `url should not contain a raw placeholder: ${result.url}`,
    )
    assert.match(result.url, /\/users\/[^/]+$/)
  })
})

describe('snippet body: example honoring', () => {
  it('uses an author-provided media-type example over the sampler', () => {
    assert.match(curl('/widgets', 'post'), /Deluxe Widget/)
  })

  it('keeps typed scalars typed (numbers/booleans are not quoted)', () => {
    const body = curl('/users', 'post')
    assert.match(body, /"age":\s*0/)
    assert.match(body, /"active":\s*true/)
  })
})

describe('snippet body: smart-samples heuristics', () => {
  it('emits the neutral "string" placeholder by default', () => {
    assert.match(curl('/users', 'post'), /"email":\s*"string"/)
  })

  it('infers a realistic value from the field name when enabled', () => {
    const body = curl('/users', 'post', { smartSamples: true })
    assert.doesNotMatch(body, /"email":\s*"string"/)
    assert.match(body, /"email":\s*"[^"]*@[^"]*"/)
  })

  it('applies heuristics to path params too', () => {
    const result = getEndpointSnippets(
      spec,
      '/users/{id}',
      'get',
      ['shell_curl'],
      {},
      {
        smartSamples: true,
      },
    )
    // `id` -> a uuid-shaped value, not the literal "string"
    assert.match(result.url, /\/users\/[0-9a-f-]{8,}/)
  })
})
