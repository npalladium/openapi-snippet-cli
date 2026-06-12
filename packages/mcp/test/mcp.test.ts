import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { OpenAPI } from 'openapi-types'
import { buildMcpServer } from '../src/server.ts'
import * as tools from '../src/tools.ts'

const BIN = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const FIXTURE = fileURLToPath(
  new URL('../../core/test/fixtures/petstore-3.0.yaml', import.meta.url),
)

const spec = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '2.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  components: {
    schemas: { User: { type: 'object', properties: { id: { type: 'string' } } } },
  },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List all users',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createUser',
        summary: 'Create a user',
        responses: { '201': { description: 'Created' } },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        summary: 'Get one user',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
} as unknown as OpenAPI.Document

describe('mcp tools', () => {
  it('overview reports counts and metadata', () => {
    const o = tools.overview(spec)
    assert.equal(o.title, 'Test API')
    assert.equal(o.version, '2.0.0')
    assert.equal(o.openapi, '3.0.0')
    assert.equal(o.pathCount, 2)
    assert.equal(o.operationCount, 3)
    assert.equal(o.schemaCount, 1)
  })

  it('listEndpoints returns one entry per operation', () => {
    const eps = tools.listEndpoints(spec)
    assert.equal(eps.length, 3)
    assert.ok(
      eps.some((e) => e.method === 'GET' && e.path === '/users' && e.operationId === 'listUsers'),
    )
  })

  it('getEndpoint returns the operation and throws for unknown ones', () => {
    const op = tools.getEndpoint(spec, '/users', 'get') as { operationId?: string }
    assert.equal(op.operationId, 'listUsers')
    assert.throws(() => tools.getEndpoint(spec, '/users', 'delete'))
    assert.throws(() => tools.getEndpoint(spec, '/nope', 'get'))
  })

  it('getSchema returns a named component schema and throws when absent', () => {
    const s = tools.getSchema(spec, 'User') as { type?: string }
    assert.equal(s.type, 'object')
    assert.throws(() => tools.getSchema(spec, 'Missing'))
  })

  it('searchEndpoints matches by substring and filters by method', () => {
    assert.equal(tools.searchEndpoints(spec, 'user').length, 3)
    const posts = tools.searchEndpoints(spec, 'user', 'POST')
    assert.equal(posts.length, 1)
    assert.equal(posts[0].operationId, 'createUser')
  })

  it('getCodeSnippets returns snippets for an operation', () => {
    const r = tools.getCodeSnippets(spec, '/users', 'get', ['shell_curl'])
    assert.equal(r.method, 'GET')
    assert.ok(r.snippets.length > 0)
    assert.equal(r.snippets[0].id, 'shell_curl')
  })
})

describe('mcp server (in-memory round trip)', () => {
  it('exposes the expected tools and answers get_overview', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = buildMcpServer(spec, { name: 'test', version: '1.0.0' })
    await server.connect(serverTransport)

    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(clientTransport)

    const { tools: listed } = await client.listTools()
    const names = listed.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'get_code_snippets',
      'get_endpoint',
      'get_overview',
      'get_schema',
      'list_endpoints',
      'search_endpoints',
    ])

    const res = (await client.callTool({ name: 'get_overview', arguments: {} })) as {
      content: Array<{ type: string; text: string }>
    }
    assert.match(res.content[0].text, /Test API/)

    await client.close()
    await server.close()
  })
})

describe('mcp command (spawned over stdio)', () => {
  it('serves the petstore spec via the built openapi-mcp binary', async () => {
    const transport = new StdioClientTransport({ command: 'node', args: [BIN, FIXTURE] })
    const client = new Client({ name: 'e2e-client', version: '1.0.0' })
    await client.connect(transport)
    try {
      const { tools: listed } = await client.listTools()
      assert.ok(
        listed.some((t) => t.name === 'list_endpoints'),
        'expected list_endpoints to be advertised',
      )
      const res = (await client.callTool({ name: 'list_endpoints', arguments: {} })) as {
        content: Array<{ type: string; text: string }>
      }
      const endpoints = JSON.parse(res.content[0].text) as Array<{ path: string }>
      assert.ok(endpoints.length > 0, 'expected the petstore to expose endpoints')
      assert.ok(endpoints.some((e) => e.path === '/pets'))
    } finally {
      await client.close()
    }
  })
})
