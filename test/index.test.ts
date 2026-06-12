import assert from 'node:assert/strict'
import type { OpenAPI } from 'openapi-types'
import { getEndpointSnippets, getSnippets } from '../src/openapi-snippet/index.ts'
import { injectSnippets, renderHtml } from '../src/pipeline.ts'

const minimalSpec: OpenAPI.Document = {
  openapi: '3.0.0',
  info: { title: 'Test', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        description: 'List all users',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createUser',
        description: 'Create a user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string', example: 'Alice' } },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/users/{userId}': {
      get: {
        operationId: 'getUser',
        description: 'Get a user',
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            example: 'user123',
            schema: { type: 'string' },
          },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
}

describe('getEndpointSnippets', () => {
  it('returns correct method and url', () => {
    const result = getEndpointSnippets(minimalSpec, '/users', 'get', ['shell_curl'])
    assert.equal(result.method, 'GET')
    assert.equal(result.url, 'https://api.example.com/users')
  })

  it('returns snippet with matching id', () => {
    const result = getEndpointSnippets(minimalSpec, '/users', 'get', ['shell_curl'])
    assert.ok(result.snippets.length > 0)
    assert.equal(result.snippets[0].id, 'shell_curl')
  })

  it('returns snippet content as non-empty string', () => {
    const result = getEndpointSnippets(minimalSpec, '/users', 'get', ['node_native'])
    assert.equal(typeof result.snippets[0].content, 'string')
    assert.ok((result.snippets[0].content as string).length > 0)
  })

  it('handles POST with JSON body', () => {
    const result = getEndpointSnippets(minimalSpec, '/users', 'post', ['shell_curl'])
    assert.equal(result.method, 'POST')
    assert.ok(result.snippets.length > 0)
  })

  it('handles path parameters in url', () => {
    const result = getEndpointSnippets(minimalSpec, '/users/{userId}', 'get', ['shell_curl'])
    assert.equal(result.method, 'GET')
    assert.ok(result.url.includes('/users/'))
  })

  it('throws on invalid target', () => {
    assert.throws(
      () => getEndpointSnippets(minimalSpec, '/users', 'get', ['invalid_target']),
      /Invalid target/,
    )
  })

  it('sets resource from last non-placeholder path segment', () => {
    const result = getEndpointSnippets(minimalSpec, '/users/{userId}', 'get', ['shell_curl'])
    // example value 'user123' is substituted, so the last segment is 'user123'
    assert.equal(result.resource, 'user123')
  })
})

describe('getSnippets', () => {
  it('returns entries for all paths and methods', () => {
    const results = getSnippets(minimalSpec, ['shell_curl'])
    // 3 operations: GET /users, POST /users, GET /users/{userId}
    assert.equal(results.length, 3)
  })

  it('sorts GET before POST for the same resource', () => {
    const results = getSnippets(minimalSpec, ['shell_curl'])
    const usersResults = results.filter((r) => r.url === 'https://api.example.com/users')
    assert.equal(usersResults.length, 2)
    assert.equal(usersResults[0].method, 'GET')
    assert.equal(usersResults[1].method, 'POST')
  })

  it('each result has required fields', () => {
    const results = getSnippets(minimalSpec, ['shell_curl'])
    for (const r of results) {
      assert.ok(r.method, 'method missing')
      assert.ok(r.url, 'url missing')
      assert.ok(r.description, 'description missing')
      assert.equal(typeof r.resource, 'string', 'resource not string')
      assert.ok(Array.isArray(r.snippets), 'snippets not array')
    }
  })

  it('sorts methods in canonical order across multiple', () => {
    const spec: OpenAPI.Document = {
      ...minimalSpec,
      paths: {
        '/items': {
          delete: { operationId: 'deleteItem', responses: { '200': { description: 'OK' } } },
          post: { operationId: 'createItem', responses: { '201': { description: 'Created' } } },
          get: { operationId: 'listItems', responses: { '200': { description: 'OK' } } },
        },
      },
    }
    const results = getSnippets(spec, ['shell_curl'])
    const methods = results.map((r) => r.method)
    assert.deepEqual(methods, ['GET', 'POST', 'DELETE'])
  })
})

describe('injectSnippets — skipErrors', () => {
  // /bad trips the HAR converter (query param missing `name`); /ok is fine.
  const specWithBadOp: OpenAPI.Document = {
    openapi: '3.0.0',
    info: { title: 'Partial', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/ok': { get: { responses: { '200': { description: 'OK' } } } },
      '/bad': {
        get: {
          parameters: [{ in: 'query', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  }

  it('throws by default when an operation cannot be processed', () => {
    assert.throws(() => injectSnippets(specWithBadOp, ['shell_curl']))
  })

  it('skips the failing operation and reports it via onSkip when skipErrors is set', () => {
    const skipped: Array<{ path: string; method: string }> = []
    const result = injectSnippets(specWithBadOp, ['shell_curl'], {
      skipErrors: true,
      onSkip: (path, method) => skipped.push({ path, method }),
    })
    const paths = result.paths as Record<string, Record<string, { 'x-codeSamples'?: unknown }>>
    assert.ok(paths['/ok'].get['x-codeSamples'], '/ok should be annotated')
    assert.ok(!paths['/bad'].get['x-codeSamples'], '/bad should be left untouched')
    assert.deepEqual(skipped, [{ path: '/bad', method: 'get' }])
  })
})

describe('renderHtml', () => {
  const api = {
    openapi: '3.0.0',
    info: { title: 'My API', version: '1.0.0' },
    paths: {},
  } as unknown as OpenAPI.Document

  it('produces a standalone Redoc HTML page embedding the spec', () => {
    const html = renderHtml(api)
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'should be an HTML document')
    assert.match(html, /redoc\.standalone\.js/, 'should load the Redoc bundle')
    assert.match(html, /Redoc\.init\(/, 'should initialize Redoc with the spec')
    assert.match(html, /<title>My API<\/title>/, 'should use the spec title')
    assert.match(html, /"openapi":\s*"3\.0\.0"/, 'should inline the spec JSON')
  })

  it('escapes < so an embedded </script> cannot break out of the script tag', () => {
    const hostile = {
      openapi: '3.0.0',
      info: { title: 'pwn', version: '1' },
      paths: { '/x': { get: { description: '</script><script>alert(1)</script>' } } },
    } as unknown as OpenAPI.Document
    const html = renderHtml(hostile)
    assert.ok(
      !html.includes('</script><script>alert(1)'),
      'a raw script-breakout sequence must not survive into the output',
    )
    assert.match(html, /\\u003c/, 'angle brackets in the spec should be unicode-escaped')
  })

  it('HTML-escapes the title', () => {
    const t = { openapi: '3.0.0', info: { title: 'a<b>&"c', version: '1' }, paths: {} }
    const html = renderHtml(t as unknown as OpenAPI.Document)
    assert.match(html, /<title>a&lt;b&gt;&amp;&quot;c<\/title>/)
  })
})
