/**
 * CLI integration / smoke tests.
 * These run the built executable (dist/main.js) as a child process.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

const BIN = new URL('../dist/main.js', import.meta.url).pathname

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
function cliAsync(
  args: string[],
  opts: { timeout?: number; input?: string } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
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
    if (opts.input) {
      child.stdin.setEncoding('utf8')
      child.stdin.write(opts.input)
      child.stdin.end()
    } else {
      child.stdin.end()
    }
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

// ─── New flags: --list-targets, --stdin, --dry-run, --verbose ────────────────

describe('CLI — --list-targets', () => {
  it('prints all targets and exits 0', () => {
    const r = cli(['--list-targets'])
    assert.equal(r.status, 0, r.stderr)
    const lines = r.stdout.trim().split('\n')
    assert.ok(lines.length > 5, `expected many targets, got ${lines.length}`)
    assert.ok(lines.includes('shell_curl'))
    assert.ok(lines.includes('node_native'))
  })

  it('ignores the file argument when --list-targets is set', () => {
    const r = cli(['--list-targets', '/nonexistent/path.yaml'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes('shell_curl'))
  })
})

describe('CLI — --stdin', () => {
  it('reads the spec from stdin when piped', async () => {
    const out = outFile('stdin.yaml')
    const r = await cliAsync(['--stdin', '-o', out, '-t', 'shell_curl'], {
      input: MINIMAL_SPEC_JSON,
    })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const d = readYaml(out)
    assert.ok(d.paths['/ping'].get['x-codeSamples'])
  })

  it('reads the spec from stdin without the --stdin flag (oclif auto-stdin)', async () => {
    const out = outFile('auto-stdin.yaml')
    const r = await cliAsync(['-o', out, '-t', 'shell_curl'], { input: MINIMAL_SPEC_JSON })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const d = readYaml(out)
    assert.ok(d.paths['/ping'].get['x-codeSamples'])
  })

  it('reads YAML from stdin', async () => {
    const out = outFile('stdin-yaml.yaml')
    const r = await cliAsync(['-o', out, '-t', 'shell_curl'], { input: MINIMAL_SPEC_YAML })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const d = readYaml(out)
    assert.ok(d.paths['/ping'].get['x-codeSamples'])
  })

  it('errors when stdin is a TTY and no file is given', () => {
    const r = cli([])
    assert.notEqual(r.status, 0, 'expected non-zero exit when no input and TTY')
  })
})

describe('CLI — --dry-run', () => {
  it('writes the resolved spec to stdout, not to --output', () => {
    const out = outFile('dry-run-should-not-exist.yaml')
    const r = cli([specFile(), '-o', out, '-t', 'shell_curl', '--dry-run'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes('openapi:'), 'expected spec on stdout')
    assert.ok(!existsSync(out), 'expected output file NOT to exist')
  })

  it('respects --ext when dry-running', () => {
    const r = cli([specFile(), '-t', 'shell_curl', '--dry-run', '-e', 'json'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.trim().startsWith('{'), 'expected JSON on stdout')
  })
})

describe('CLI — --verbose', () => {
  it('is accepted without error and produces identical output to silent mode', () => {
    const out1 = outFile('verbose.yaml')
    const out2 = outFile('silent.yaml')
    const r1 = cli([specFile(), '-o', out1, '-t', 'shell_curl', '--verbose'])
    const r2 = cli([specFile(), '-o', out2, '-t', 'shell_curl'])
    assert.equal(r1.status, 0, r1.stderr)
    assert.equal(r2.status, 0, r2.stderr)
    assert.equal(readFileSync(out1, 'utf8'), readFileSync(out2, 'utf8'))
  })

  it('emits trace output on stderr when --verbose is set (no NODE_DEBUG)', () => {
    const r = cli([
      specFile(),
      '-o',
      outFile('verbose-trace.yaml'),
      '-t',
      'shell_curl',
      '--verbose',
    ])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /spec loaded/i, 'expected trace output on stderr with --verbose')
  })

  it('stays quiet on stderr without --verbose or NODE_DEBUG', () => {
    const r = cli([specFile(), '-o', outFile('quiet.yaml'), '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /spec loaded/i, 'expected no trace output without --verbose')
  })

  it('emits debug output when NODE_DEBUG=openapi-snippet is set', () => {
    const r = spawnSync(
      'node',
      [BIN, specFile(), '-o', outFile('node-debug.yaml'), '-t', 'shell_curl'],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_DEBUG: 'openapi-snippet' },
      },
    )
    assert.equal(r.status, 0, r.stderr)
    assert.match(
      r.stderr,
      /OPENAPI-SNIPPET|openapi-snippet/i,
      'expected debug output in stderr when NODE_DEBUG is set',
    )
  })
})

// ─── Exit codes ───────────────────────────────────────────────────────────────

describe('CLI — exit codes', () => {
  it('exits 0 on success', () => {
    const r = cli([specFile(), '-o', outFile('ok.yaml'), '-t', 'shell_curl'])
    assert.equal(r.status, 0)
  })

  it('exits non-zero on unknown --ext', () => {
    const r = cli([specFile(), '-o', outFile('bad-ext.yaml'), '-e', 'xml', '-t', 'shell_curl'])
    assert.notEqual(r.status, 0)
  })

  it('exits 3 on HTTP fetch failure (connection refused)', () => {
    const r = cli(['http://127.0.0.1:1/spec.json', '-o', outFile('net.yaml'), '-t', 'shell_curl'])
    assert.equal(r.status, 3, `stderr: ${r.stderr}`)
  })

  it('exits 3 on HTTP 4xx', async () => {
    const r = await cliAsync([
      `http://127.0.0.1:${serverPort}/404`,
      '-o',
      outFile('404.yaml'),
      '-t',
      'shell_curl',
    ])
    assert.equal(r.status, 3, `stderr: ${r.stderr}`)
  })
})

// ─── --chunk-size ──────────────────────────────────────────────────────────────

describe('CLI — --chunk-size', () => {
  it('produces equivalent output with --chunk-size=10 vs the default (no chunking)', () => {
    const spec = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Chunked', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `/p${i}`,
          { get: { operationId: `g${i}`, responses: { '200': { description: 'OK' } } } },
        ]),
      ),
    })
    const inFile = outFile('chunked-input.json')
    writeFileSync(inFile, spec)

    const outDefault = outFile('chunked-default.yaml')
    const outChunked = outFile('chunked-chunked.yaml')
    const r1 = cli([inFile, '-o', outDefault, '-t', 'shell_curl'])
    const r2 = cli([inFile, '-o', outChunked, '-t', 'shell_curl', '--chunk-size', '10'])
    assert.equal(r1.status, 0, r1.stderr)
    assert.equal(r2.status, 0, r2.stderr)

    const d1 = readYaml(outDefault)
    const d2 = readYaml(outChunked)
    assert.deepEqual(
      Object.keys(d1.paths).sort(),
      Object.keys(d2.paths).sort(),
      'chunked output has different path set',
    )
    // Sample a path and compare its operation content.
    const samplePath = Object.keys(d1.paths)[0]
    assert.equal(
      d1.paths[samplePath].get['x-codeSamples'].length,
      d2.paths[samplePath].get['x-codeSamples'].length,
    )
  })

  it('accepts --chunk-size=0 (legacy / no chunking)', () => {
    const out = outFile('chunk-zero.yaml')
    const r = cli([specFile(), '-o', out, '-t', 'shell_curl', '--chunk-size', '0'])
    assert.equal(r.status, 0, r.stderr)
    const d = readYaml(out)
    assert.ok(d.paths['/ping'].get['x-codeSamples'])
  })

  it('rejects negative --chunk-size', () => {
    const r = cli([specFile(), '-o', outFile('neg.yaml'), '-t', 'shell_curl', '--chunk-size', '-1'])
    assert.notEqual(r.status, 0)
  })

  it('warns (but succeeds) when --chunk-size is combined with -e json', () => {
    const out = outFile('chunk-json.json')
    const r = cli([specFile(), '-o', out, '-e', 'json', '-t', 'shell_curl', '--chunk-size', '10'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /--chunk-size only speeds up YAML/i)
    // Output is still valid JSON with snippets.
    const d = JSON.parse(readFileSync(out, 'utf8'))
    assert.ok(d.paths['/ping'].get['x-codeSamples'])
  })

  it('does not warn when --chunk-size is used with yaml output', () => {
    const out = outFile('chunk-yaml-nowarn.yaml')
    const r = cli([specFile(), '-o', out, '-t', 'shell_curl', '--chunk-size', '10'])
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /--chunk-size only speeds up YAML/i)
  })
})

// ─── --skip-errors ──────────────────────────────────────────────────────────────

// A spec where one operation trips the HAR converter (query param missing `name`)
// while another operation is fine.
const SPEC_WITH_BAD_OP = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Partial', version: '1' },
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
})

describe('CLI — --skip-errors', () => {
  it('aborts (non-zero) on an unprocessable operation by default', () => {
    const r = cli([
      specFile('bad.json', SPEC_WITH_BAD_OP),
      '-o',
      outFile('strict.yaml'),
      '-t',
      'shell_curl',
    ])
    assert.notEqual(r.status, 0)
  })

  it('skips the bad operation, warns, and still writes the rest with --skip-errors', () => {
    const out = outFile('skipped.yaml')
    const r = cli([
      specFile('bad.json', SPEC_WITH_BAD_OP),
      '-o',
      out,
      '-t',
      'shell_curl',
      '--skip-errors',
    ])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /skip.*\/bad/i, 'expected a stderr warning naming the skipped op')
    const d = readYaml(out)
    assert.ok(d.paths['/ok'].get['x-codeSamples'], '/ok should still get snippets')
    assert.ok(!d.paths['/bad'].get['x-codeSamples'], '/bad should be left without snippets')
  })
})

// ─── HTML output ─────────────────────────────────────────────────────────────

describe('CLI — html output', () => {
  it('writes a Redoc HTML page with -e html, embedding the enriched spec', () => {
    const out = outFile('docs.html')
    const r = cli([specFile(), '-o', out, '-e', 'html', '-t', 'shell_curl'])
    assert.equal(r.status, 0, r.stderr)
    const html = readFileSync(out, 'utf8')
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'expected an HTML document')
    assert.match(html, /redoc\.standalone\.js/, 'expected the Redoc bundle')
    assert.match(html, /x-codeSamples/, 'expected the injected snippets to be embedded')
  })

  it('warns that --chunk-size does not apply to -e html', () => {
    const out = outFile('docs-chunk.html')
    const r = cli([specFile(), '-o', out, '-e', 'html', '-t', 'shell_curl', '--chunk-size', '10'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /--chunk-size only speeds up YAML/i)
  })

  it('produces a self-contained page (no CDN) with --inline-redoc', () => {
    const out = outFile('docs-offline.html')
    const r = cli([specFile(), '-o', out, '-e', 'html', '-t', 'shell_curl', '--inline-redoc'])
    assert.equal(r.status, 0, r.stderr)
    const html = readFileSync(out, 'utf8')
    assert.doesNotMatch(html, /src="https:\/\/cdn\.redocly\.com/, 'should not reference the CDN')
    // The inlined standalone bundle is large; the page should dwarf the CDN variant.
    assert.ok(html.length > 200_000, `expected an inlined bundle, page was ${html.length} bytes`)
    assert.match(html, /Redoc\.init\(/)
  })
})
