/**
 * CLI integration / smoke tests.
 * These run the actual `bin/run` script as a child process.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

const BIN = new URL('../bin/run', import.meta.url).pathname

type CliResult = {
  status: number | null
  stdout: string
  stderr: string
  signal: NodeJS.Signals | null
}

/**
 * Async spawn — keeps the event loop alive so an in-process HTTP server
 * (used by URL tests) can respond to the child process's fetch() calls.
 * spawnSync would deadlock because it blocks the parent event loop.
 */
function cliAsync(args: string[], opts: { timeout?: number } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN, ...args])
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout += d
    })
    child.stderr.on('data', (d: string) => {
      stderr += d
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ status: null, stdout, stderr, signal: 'SIGTERM' })
    }, opts.timeout ?? 15000)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr, signal })
    })
  })
}

const MINIMAL_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Smoke Test API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/ping': {
      get: {
        operationId: 'ping',
        description: 'Health check',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/items': {
      get: {
        operationId: 'listItems',
        description: 'List items',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createItem',
        description: 'Create item',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string', example: 'widget' } },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        description: 'Get item',
        parameters: [
          { name: 'id', in: 'path', required: true, example: '42', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
      delete: {
        operationId: 'deleteItem',
        description: 'Delete item',
        parameters: [
          { name: 'id', in: 'path', required: true, example: '42', schema: { type: 'string' } },
        ],
        responses: { '204': { description: 'No Content' } },
      },
    },
  },
}

const MINIMAL_SPEC_JSON = JSON.stringify(MINIMAL_SPEC)
const MINIMAL_SPEC_YAML = yaml.dump(MINIMAL_SPEC) as string

function cli(args: string[], opts: { timeout?: number } = {}) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    timeout: opts.timeout ?? 15000,
  })
}

type CodeSample = { lang: string; source: string }
type Operation = Record<string, unknown> & { 'x-codeSamples': CodeSample[] }
type PathItem = Record<string, unknown> & { get: Operation; post: Operation; delete: Operation }
type SpecDoc = {
  paths: Record<string, PathItem>
}

function readYaml(file: string): SpecDoc {
  return yaml.load(readFileSync(file, 'utf8')) as SpecDoc
}

let tmpDir: string
let httpServer: Server
let serverPort: number

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'openapi-snippet-cli-e2e-'))

  // Start a local HTTP server serving the minimal spec
  await new Promise<void>((resolve) => {
    httpServer = createServer((req, res) => {
      if (req.url === '/openapi.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(MINIMAL_SPEC_JSON)
      } else if (req.url === '/openapi.yaml') {
        res.writeHead(200, { 'Content-Type': 'application/yaml' })
        res.end(MINIMAL_SPEC_YAML)
      } else if (req.url === '/404') {
        res.writeHead(404)
        res.end('Not Found')
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(MINIMAL_SPEC_JSON)
      }
    })
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      serverPort = typeof addr === 'object' && addr ? addr.port : 0
      resolve()
    })
  })
})

after(async () => {
  rmSync(tmpDir, { recursive: true, force: true })
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function specFile(name = 'spec.json', content = MINIMAL_SPEC_JSON) {
  const p = join(tmpDir, name)
  writeFileSync(p, content)
  return p
}

function outFile(name: string) {
  return join(tmpDir, name)
}

// ─── Basic invocation ─────────────────────────────────────────────────────────

describe('CLI — help and version', () => {
  it('--help exits 0 and mentions code snippets', () => {
    const r = cli(['--help'])
    assert.equal(r.status, 0)
    assert.ok(r.stdout.includes('openapi-snippet') || r.stdout.includes('code snippets'))
  })

  it('--version exits 0 and prints a version number', () => {
    const r = cli(['--version'])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /\d+\.\d+\.\d+/)
  })
})

// ─── File input ───────────────────────────────────────────────────────────────

describe('CLI — local file input', () => {
  it('reads a JSON spec and writes yaml output', () => {
    const out = outFile('file-json-to-yaml.yaml')
    const r = cli([specFile('s.json'), '-o', out, '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    const d = readYaml(out)
    assert.ok(Array.isArray(d.paths['/ping'].get['x-codeSamples']))
  })

  it('reads a YAML spec and writes yaml output', () => {
    const out = outFile('file-yaml-to-yaml.yaml')
    const r = cli([specFile('s.yaml', MINIMAL_SPEC_YAML), '-o', out, '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    const d = readYaml(out)
    assert.ok(d.paths['/ping'].get['x-codeSamples'])
  })

  it('writes json output with -e json', () => {
    const out = outFile('file-to-json.json')
    const r = cli([specFile(), '-o', out, '-e', 'json', '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    const d = JSON.parse(readFileSync(out, 'utf8'))
    assert.ok(d.paths['/ping'].get['x-codeSamples'])
  })

  it('creates nested output directories', () => {
    const out = outFile('a/b/c/out.yaml')
    const r = cli([specFile(), '-o', out, '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(readFileSync(out, 'utf8').length > 0)
  })

  it('exits non-zero for a missing file', () => {
    const r = cli(['nonexistent-spec.json'])
    assert.notEqual(r.status, 0)
  })
})

// ─── URL input ────────────────────────────────────────────────────────────────

describe('CLI — http URL input', () => {
  it('fetches a JSON spec from http URL', async () => {
    const out = outFile('url-json.yaml')
    const r = await cliAsync([
      `http://127.0.0.1:${serverPort}/openapi.json`,
      '-o',
      out,
      '-t',
      'shell_curl',
    ])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const d = readYaml(out)
    assert.ok(Array.isArray(d.paths['/ping'].get['x-codeSamples']))
    assert.ok(d.paths['/ping'].get['x-codeSamples'].length > 0)
  })

  it('fetches a YAML spec from http URL', async () => {
    const out = outFile('url-yaml.yaml')
    const r = await cliAsync([
      `http://127.0.0.1:${serverPort}/openapi.yaml`,
      '-o',
      out,
      '-t',
      'shell_curl',
    ])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const d = readYaml(out)
    assert.ok(d.paths['/ping'].get['x-codeSamples'])
  })

  it('exits non-zero on HTTP 404', async () => {
    const out = outFile('url-404.yaml')
    const r = await cliAsync([`http://127.0.0.1:${serverPort}/404`, '-o', out, '-t', 'shell_curl'])
    assert.notEqual(r.status, 0)
  })
})

// ─── Target filtering ─────────────────────────────────────────────────────────

describe('CLI — target filtering', () => {
  it('outputs only the specified target', () => {
    const out = outFile('target-curl.yaml')
    const r = cli([specFile(), '-o', out, '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    const d = readYaml(out)
    const samples = d.paths['/ping'].get['x-codeSamples']
    assert.equal(samples.length, 1)
    assert.equal(samples[0].lang, 'Shell + Curl')
  })

  it('outputs multiple targets when specified multiple times', () => {
    const out = outFile('target-multi.yaml')
    const r = cli([specFile(), '-o', out, '-t', 'shell_curl', '-t', 'node_native'])
    assert.equal(r.status, 0, r.stderr)
    const d = readYaml(out)
    const samples = d.paths['/ping'].get['x-codeSamples']
    assert.equal(samples.length, 2)
    const langs = samples.map((s: { lang: string }) => s.lang)
    assert.ok(langs.includes('Shell + Curl'))
    assert.ok(langs.includes('Node + Native'))
  })

  it('defaults to all targets when none specified', () => {
    const out = outFile('target-all.yaml')
    const r = cli([specFile(), '-o', out])
    assert.equal(r.status, 0, r.stderr)
    const d = readYaml(out)
    const samples = d.paths['/ping'].get['x-codeSamples']
    assert.ok(samples.length > 5, `expected many targets, got ${samples.length}`)
  })
})

// ─── Output correctness ───────────────────────────────────────────────────────

describe('CLI — output correctness', () => {
  it('annotates every HTTP method in every path', () => {
    const out = outFile('all-methods.yaml')
    const r = cli([specFile(), '-o', out, '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    const d = readYaml(out)
    // /ping GET, /items GET+POST, /items/{id} GET+DELETE
    assert.ok(d.paths['/ping'].get['x-codeSamples'])
    assert.ok(d.paths['/items'].get['x-codeSamples'])
    assert.ok(d.paths['/items'].post['x-codeSamples'])
    assert.ok(d.paths['/items/{id}'].get['x-codeSamples'])
    assert.ok(d.paths['/items/{id}'].delete['x-codeSamples'])
  })

  it('each snippet has lang and source fields', () => {
    const out = outFile('snippet-shape.yaml')
    const r = cli([specFile(), '-o', out, '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    const d = readYaml(out)
    const sample = d.paths['/ping'].get['x-codeSamples'][0]
    assert.ok(typeof sample.lang === 'string' && sample.lang.length > 0, 'lang missing')
    assert.ok(typeof sample.source === 'string' && sample.source.length > 0, 'source missing')
  })

  it('snippet source contains the request URL', () => {
    const out = outFile('snippet-url.yaml')
    const r = cli([specFile(), '-o', out, '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    const d = readYaml(out)
    const source: string = d.paths['/ping'].get['x-codeSamples'][0].source
    assert.ok(source.includes('api.example.com'), `expected URL in snippet, got:\n${source}`)
  })

  it('does not mutate non-HTTP path-level keys (e.g. summary, parameters)', () => {
    const specWithExtra = JSON.stringify({
      ...MINIMAL_SPEC,
      paths: {
        '/ping': {
          summary: 'Ping group',
          parameters: [{ name: 'X-Debug', in: 'header', schema: { type: 'string' } }],
          get: {
            operationId: 'ping',
            description: 'Health check',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    })
    const out = outFile('non-http-keys.yaml')
    const r = cli([specFile('extra.json', specWithExtra), '-o', out, '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    const d = readYaml(out)
    // summary and parameters should not have x-codeSamples
    assert.equal(d.paths['/ping'].summary, 'Ping group')
    assert.ok(!d.paths['/ping']['x-codeSamples'], 'path-level should not get x-codeSamples')
    assert.ok(d.paths['/ping'].get['x-codeSamples'], 'operation should get x-codeSamples')
  })
})
