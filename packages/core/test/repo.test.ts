/**
 * Workspace-wide conformance tests: package layout, dependency hygiene,
 * metadata, and a live biome run. Lives in core because it is the package
 * that is always present and built first.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = new URL('../../../', import.meta.url).pathname

type JsonObject = Record<string, unknown>
const loadJson = (p: string): JsonObject => JSON.parse(readFileSync(p, 'utf8')) as JsonObject
const pkgOf = (name: string): JsonObject =>
  loadJson(join(REPO_ROOT, 'packages', name, 'package.json'))

const srcFiles = (name: string): string[] => {
  const dir = join(REPO_ROOT, 'packages', name, 'src')
  return readdirSync(dir, { recursive: true })
    .map((p) => String(p))
    .filter((p) => p.endsWith('.ts'))
    .map((p) => readFileSync(join(dir, p), 'utf8'))
}
const allSrc = ['core', 'cli', 'mcp'].flatMap(srcFiles).join('\n')

describe('workspace layout', () => {
  it('declares a pnpm workspace', () => {
    const ws = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')
    assert.match(ws, /packages\/\*/)
  })

  it('root package is private with a >=22 engines floor', () => {
    const root = loadJson(join(REPO_ROOT, 'package.json'))
    assert.equal(root.private, true)
    const node = (root.engines as Record<string, string>)?.node ?? ''
    const m = node.match(/>=(\d+)/)
    assert.ok(m && Number(m[1]) >= 22, `engines.node should be >=22, got ${node}`)
  })

  it('has the three expected packages', () => {
    assert.equal(pkgOf('core').name, '@openapi-snippet/core')
    assert.equal(pkgOf('cli').name, 'openapi-snippet-cli')
    assert.equal(pkgOf('mcp').name, 'openapi-mcp')
  })
})

describe('package binaries and dependencies', () => {
  const cli = pkgOf('cli')
  const mcp = pkgOf('mcp')

  it('the snippet CLI binary points at its built executable', () => {
    assert.equal((cli.bin as Record<string, string>)['openapi-snippet'], 'dist/main.js')
  })

  it('the MCP CLI binary points at its built executable', () => {
    assert.equal((mcp.bin as Record<string, string>)['openapi-mcp'], 'dist/main.js')
  })

  it('cli and mcp depend on the shared core via the workspace protocol', () => {
    for (const pkg of [cli, mcp]) {
      const deps = pkg.dependencies as Record<string, string>
      assert.match(deps['@openapi-snippet/core'] ?? '', /^workspace:/)
      assert.ok(deps['@stricli/core'], 'expected @stricli/core')
    }
  })

  it('keeps the heavy optional/MCP deps off the wrong packages', () => {
    const coreDeps = pkgOf('core').dependencies as Record<string, string>
    const cliDeps = cli.dependencies as Record<string, string>
    // redoc is optional, only on the cli, and never a hard dependency.
    assert.ok((cli.optionalDependencies as Record<string, string>)?.redoc, 'cli redoc optional')
    assert.ok(!cliDeps.redoc, 'redoc must not be a hard cli dependency')
    // The MCP SDK lives only on the mcp package.
    assert.ok((mcp.dependencies as Record<string, string>)['@modelcontextprotocol/sdk'])
    assert.ok(!cliDeps['@modelcontextprotocol/sdk'], 'cli must not pull the MCP SDK')
    assert.ok(!coreDeps['@modelcontextprotocol/sdk'], 'core must not pull the MCP SDK')
    assert.ok(!coreDeps['@stricli/core'], 'core must stay CLI-framework-free')
    assert.ok(!coreDeps.redoc, 'core must not pull redoc')
  })
})

describe('dependency hygiene', () => {
  it('no package depends on lodash or oclif', () => {
    for (const name of ['core', 'cli', 'mcp']) {
      const pkg = pkgOf(name)
      const all = {
        ...(pkg.dependencies as object),
        ...(pkg.devDependencies as object),
        ...(pkg.optionalDependencies as object),
      } as Record<string, string>
      assert.ok(!all.lodash, `${name} should not depend on lodash`)
      assert.ok(!Object.keys(all).some((d) => d.startsWith('@oclif')), `${name} oclif-free`)
    }
  })

  it('no source file imports lodash or oclif', () => {
    assert.ok(!/from ['"]lodash|require\(['"]lodash/.test(allSrc), 'no lodash imports')
    assert.ok(!/from ['"]@oclif|require\(['"]@oclif/.test(allSrc), 'no oclif imports')
  })
})

describe('LICENSE', () => {
  it('ships an MIT LICENSE retaining the upstream holders', () => {
    const body = readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8')
    assert.match(body, /MIT License/i)
    assert.match(body, /Permission is hereby granted, free of charge/)
    for (const who of ['Nikhil Pallamreddy', 'Richard Kabiling', 'Erik Wittern']) {
      assert.match(body, new RegExp(who))
    }
  })
})

describe('biome', () => {
  it('reports zero errors and zero warnings across the workspace', () => {
    let combined = ''
    try {
      combined = execFileSync(
        'node',
        [join(REPO_ROOT, 'node_modules/@biomejs/biome/bin/biome'), 'check', '.'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      combined = `${e.stdout ?? ''}\n${e.stderr ?? ''}`
    }
    assert.ok(
      !/Found \d+ error/i.test(combined) && !/Found \d+ warning/i.test(combined),
      `biome check should be clean. Output:\n${combined}`,
    )
  })
})
