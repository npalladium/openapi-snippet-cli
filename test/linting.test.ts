/**
 * Meta-tests for the aggressive Biome linting setup.
 * These verify the configuration itself: rule strictness, script wiring,
 * and repo-wide conformance.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname

type JsonObject = Record<string, unknown>

const loadJson = (path: string): JsonObject => JSON.parse(readFileSync(path, 'utf8')) as JsonObject

const loadText = (path: string): string => readFileSync(path, 'utf8')

const getRule = (rules: JsonObject, group: string, name: string): unknown => {
  const groupRules = rules[group] as JsonObject | undefined
  return groupRules?.[name]
}

describe('biome.json', () => {
  const config = loadJson(join(REPO_ROOT, 'biome.json')) as JsonObject
  const linter = config.linter as JsonObject
  const rules = linter.rules as JsonObject
  const files = config.files as JsonObject
  const includes = files.includes as string[]

  it('uses Biome 2.4.4 schema (matches dev dep)', () => {
    const pkg = loadJson(join(REPO_ROOT, 'package.json')) as JsonObject
    const devDeps = pkg.devDependencies as Record<string, string>
    assert.ok(devDeps['@biomejs/biome'], '@biomejs/biome must be a devDependency')
  })

  it('enables recommended ruleset', () => {
    assert.equal(rules.recommended, true)
  })

  it('promotes noExplicitAny to error (stricter than habitat)', () => {
    assert.equal(getRule(rules, 'suspicious', 'noExplicitAny'), 'error')
  })

  it('promotes noDoubleEquals to error', () => {
    assert.equal(getRule(rules, 'suspicious', 'noDoubleEquals'), 'error')
  })

  it('disallows var', () => {
    assert.equal(getRule(rules, 'suspicious', 'noVar'), 'error')
  })

  it('requires useIsArray', () => {
    assert.equal(getRule(rules, 'suspicious', 'useIsArray'), 'error')
  })

  it('promotes noUnusedVariables and noUnusedImports to error', () => {
    assert.equal(getRule(rules, 'correctness', 'noUnusedVariables'), 'error')
    assert.equal(getRule(rules, 'correctness', 'noUnusedImports'), 'error')
  })

  it('enforces useExhaustiveDependencies as error', () => {
    assert.equal(getRule(rules, 'correctness', 'useExhaustiveDependencies'), 'error')
  })

  it('enforces useTemplate and useConst', () => {
    assert.equal(getRule(rules, 'style', 'useTemplate'), 'error')
    assert.equal(getRule(rules, 'style', 'useConst'), 'error')
  })

  it('enforces noParameterAssign', () => {
    assert.equal(getRule(rules, 'style', 'noParameterAssign'), 'error')
  })

  it('enforces useDefaultParameterLast (habitat rule)', () => {
    assert.equal(getRule(rules, 'style', 'useDefaultParameterLast'), 'error')
  })

  it('enforces useNumberNamespace (habitat rule)', () => {
    assert.equal(getRule(rules, 'style', 'useNumberNamespace'), 'error')
  })

  it('enforces useArrowFunction (replaces habitat off)', () => {
    assert.equal(getRule(rules, 'complexity', 'useArrowFunction'), 'error')
  })

  it('enforces useConsistentArrayType (shorthand)', () => {
    const rule = getRule(rules, 'style', 'useConsistentArrayType') as JsonObject
    assert.equal(rule?.level, 'error')
    assert.equal((rule?.options as JsonObject)?.syntax, 'shorthand')
  })

  it('enforces useExportType, useImportType, useNodejsImportProtocol', () => {
    assert.equal(getRule(rules, 'style', 'useExportType'), 'error')
    assert.equal(getRule(rules, 'style', 'useImportType'), 'error')
    assert.equal(getRule(rules, 'style', 'useNodejsImportProtocol'), 'error')
  })

  it('caps excessive cognitive complexity at 20 (warn)', () => {
    const rule = getRule(rules, 'complexity', 'noExcessiveCognitiveComplexity') as JsonObject
    assert.equal(rule?.level, 'warn')
    assert.equal((rule?.options as JsonObject)?.maxAllowedComplexity, 20)
  })

  it('organizes imports on save', () => {
    const assist = config.assist as JsonObject
    const actions = (assist.actions as JsonObject).source as JsonObject
    assert.equal(actions.organizeImports, 'on')
  })

  it('uses single quotes, trailing commas, no semicolons, 100-col width', () => {
    const formatter = config.formatter as JsonObject
    assert.equal(formatter.indentStyle, 'space')
    assert.equal(formatter.indentWidth, 2)
    assert.equal(formatter.lineWidth, 100)
    const js = (config.javascript as JsonObject).formatter as JsonObject
    assert.equal(js.quoteStyle, 'single')
    assert.equal(js.trailingCommas, 'all')
    assert.equal(js.semicolons, 'asNeeded')
  })

  it('ignores dist, node_modules, coverage, out, .nyc_output, tmp', () => {
    for (const dir of ['dist', 'node_modules', 'coverage', 'out', '.nyc_output', 'tmp']) {
      assert.ok(
        includes.includes(`!**/${dir}`) || includes.includes(`!**/${dir}/**`),
        `expected ignore for ${dir}`,
      )
    }
  })

  it('honors .gitignore via useIgnoreFile', () => {
    const vcs = config.vcs as JsonObject
    assert.equal(vcs.enabled, true)
    assert.equal(vcs.useIgnoreFile, true)
  })
})

describe('package.json scripts', () => {
  const pkg = loadJson(join(REPO_ROOT, 'package.json')) as JsonObject
  const scripts = pkg.scripts as Record<string, string>

  it('exposes lint and lint:fix', () => {
    assert.ok(scripts.lint?.includes('biome lint'))
    assert.ok(scripts['lint:fix']?.includes('--write'))
  })

  it('exposes check and check:fix', () => {
    assert.ok(scripts.check?.includes('biome check'))
    assert.ok(scripts['check:fix']?.includes('--write'))
  })

  it('exposes typecheck using tsgo (native TypeScript compiler)', () => {
    assert.ok(
      scripts.typecheck?.includes('tsgo'),
      `expected typecheck to use tsgo, got: ${scripts.typecheck}`,
    )
  })

  it('exposes a dev script using tsx for source-level runs', () => {
    assert.ok(scripts.dev?.includes('tsx'), `expected dev to use tsx, got: ${scripts.dev}`)
  })

  it('exposes a test:watch script using mocha --watch', () => {
    assert.ok(
      scripts['test:watch']?.includes('mocha --watch'),
      `expected test:watch to use mocha --watch, got: ${scripts['test:watch']}`,
    )
  })

  it('exposes a ci/verify script that chains check + typecheck + build + test', () => {
    const ci = scripts.verify ?? scripts.ci
    assert.ok(ci, 'expected a verify or ci script')
    assert.ok(ci.includes('check'))
    assert.ok(ci.includes('typecheck'))
    assert.ok(ci.includes('build'))
    assert.ok(ci.includes('test'))
  })

  it('exposes build:js using esbuild', () => {
    assert.ok(
      scripts['build:js']?.includes('esbuild'),
      `expected build:js to use esbuild, got: ${scripts['build:js']}`,
    )
  })

  it('exposes build:types using tsc --emitDeclarationOnly', () => {
    assert.ok(scripts['build:types']?.includes('--emitDeclarationOnly'))
  })

  it('does not declare unused oclif pack scripts', () => {
    for (const key of ['pack:tarballs', 'pack:win', 'pack:macos', 'pack:deb']) {
      assert.ok(!scripts[key], `expected ${key} to be removed`)
    }
  })
})

describe('engines', () => {
  const pkg = loadJson(join(REPO_ROOT, 'package.json')) as JsonObject
  const engines = pkg.engines as Record<string, string>

  it('requires Node >=22', () => {
    const node = engines.node ?? ''
    const m = node.match(/>=(\d+)/)
    assert.ok(m, `expected a >= constraint in engines.node, got: ${node}`)
    assert.ok(Number(m[1]) >= 22, `engines.node floor should be >=22, got: ${node}`)
  })
})

describe('repo lint conformance', () => {
  // Spawning biome on a project with 100% clean output is a direct proof
  // that the config works end-to-end on the current source.
  it('biome check reports zero errors and zero warnings', () => {
    let stdout = ''
    let stderr = ''
    try {
      stdout = execFileSync(
        'node',
        [join(REPO_ROOT, 'node_modules/@biomejs/biome/bin/biome'), 'check', '.'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        },
      )
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      stdout = e.stdout ?? ''
      stderr = e.stderr ?? ''
    }
    const combined = `${stdout}\n${stderr}`
    assert.ok(
      !/Found \d+ error/i.test(combined) && !/Found \d+ warning/i.test(combined),
      `biome check should be clean. Output:\n${combined}`,
    )
  })
})

describe('gitignore', () => {
  const gitignore = loadText(join(REPO_ROOT, '.gitignore'))

  it('ignores the out/ directory', () => {
    assert.match(gitignore, /^\/out$/m, 'expected /out in .gitignore')
  })
})

describe('mocha config', () => {
  const cfg = loadText(join(REPO_ROOT, '.mocharc.yml'))

  it('uses tsx as the test loader', () => {
    assert.ok(cfg.includes('tsx'), `expected .mocharc.yml to use tsx; got:\n${cfg}`)
  })

  it('does not reference ts-node', () => {
    assert.ok(!cfg.includes('ts-node'), `ts-node should be removed; got:\n${cfg}`)
  })
})

describe('bin/run', () => {
  const body = loadText(join(REPO_ROOT, 'bin/run'))

  it('is a single-mode production launcher (no dev branch)', () => {
    assert.ok(
      !body.includes('ts-node') && !body.includes('fs.existsSync(project)'),
      'bin/run should not contain the legacy dev branch with ts-node or a tsconfig check',
    )
  })

  it('invokes the compiled CLI from dist/', () => {
    assert.ok(body.includes('@oclif/core'), 'expected bin/run to delegate to @oclif/core')
  })
})

describe('build pipeline', () => {
  it('produces a non-empty dist/cli/index.js that is a valid ESM module', () => {
    const distCli = join(REPO_ROOT, 'dist/cli/index.js')
    if (!existsSync(distCli)) {
      execFileSync('node', [join(REPO_ROOT, 'node_modules/.bin/pnpm'), 'build'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    }
    const stat = statSync(distCli)
    assert.ok(stat.size > 0, 'dist/cli/index.js should be non-empty')
    const body = readFileSync(distCli, { encoding: 'utf8', flag: 'r' })
    assert.ok(
      body.includes('OpenapiSnippetCli') || body.includes('openapi-snippet'),
      'dist/cli/index.js should reference the CLI class or command name',
    )
  })
})

describe('dependency hygiene', () => {
  const pkg = loadJson(join(REPO_ROOT, 'package.json')) as JsonObject
  const deps = (pkg.dependencies ?? {}) as Record<string, string>
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>

  const srcFiles = readdirSync(join(REPO_ROOT, 'src'), { recursive: true })
    .map((p) => String(p))
    .filter((p) => p.endsWith('.ts'))
    .map((p) => loadText(join(REPO_ROOT, 'src', p)))
  const allSrc = srcFiles.join('\n')

  it('does not depend on lodash (dead dependency — cloneDeep was dropped)', () => {
    assert.ok(!deps.lodash, 'lodash should not be a runtime dependency')
    assert.ok(!devDeps['@types/lodash'], '@types/lodash should not be a devDependency')
  })

  it('does not import lodash anywhere in src/', () => {
    assert.ok(
      !/from ['"]lodash|require\(['"]lodash/.test(allSrc),
      'no src file should import lodash',
    )
  })
})

describe('LICENSE', () => {
  const pkg = loadJson(join(REPO_ROOT, 'package.json')) as JsonObject

  it('declares MIT in package.json', () => {
    assert.equal(pkg.license, 'MIT')
  })

  it('ships a LICENSE file with the MIT grant text', () => {
    const licensePath = join(REPO_ROOT, 'LICENSE')
    assert.ok(existsSync(licensePath), 'expected a LICENSE file at the repo root')
    const body = loadText(licensePath)
    assert.match(body, /MIT License/i)
    assert.match(body, /Permission is hereby granted, free of charge/)
  })

  it('retains the copyright holders credited in the README', () => {
    const body = loadText(join(REPO_ROOT, 'LICENSE'))
    // This is a fork; the MIT notice must keep the upstream authors.
    assert.match(body, /Nikhil Pallamreddy/)
    assert.match(body, /Richard Kabiling/)
    assert.match(body, /Erik Wittern/)
  })
})
