import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { debuglog, format } from 'node:util'
import {
  CliError,
  ExitCode,
  generateModels,
  type InjectOptions,
  injectSnippets,
  isSchemaTarget,
  loadSpec,
  type RenderHtmlOptions,
  renderHtml,
  renderTagIndexHtml,
  SCHEMA_TARGET_IDS,
  SCHEMA_TARGETS,
  serializeChunked,
  slugifyTag,
  splitByTag,
} from '@npalladium/openapi-snippet-core'
import {
  buildApplication,
  buildCommand,
  type CommandContext,
  numberParser,
  run,
} from '@stricli/core'
import yaml from 'js-yaml'
import type { OpenAPI } from 'openapi-types'

export { CliError, ExitCode } from '@npalladium/openapi-snippet-core'

/**
 * Warn when the no-chunk path would dominate runtime on a large spec.
 * Empirically, `yaml.dump` on a 10000-path spec takes ~11s and grows
 * quadratically with size; below ~5000 paths the no-chunk path is
 * still well under a second.
 */
export const LARGE_SPEC_PATH_THRESHOLD = 5000

/** httpsnippet (HTTP-request) targets — the default set when none are given. */
export const httpTargets = [
  'c_libcurl',
  'csharp_restsharp',
  'go_native',
  'java_okhttp',
  'java_unirest',
  'javascript_jquery',
  'javascript_fetch',
  'javascript_xhr',
  'javascript',
  'node_native',
  'node_request',
  'node_unirest',
  'objc_nsurlsession',
  'ocaml_cohttp',
  'php_curl',
  'php_http1',
  'php_http2',
  'python_python3',
  'python_requests',
  'ruby_native',
  'shell_curl',
  'shell_httpie',
  'shell_wget',
  'swift_nsurlsession',
]

/**
 * All recognized targets: httpsnippet request targets plus the schema-codegen
 * targets (zod/valibot/pydantic). Schema targets are opt-in — they are NOT in
 * the default set, so a bare run keeps emitting only HTTP-request samples.
 */
export const allTargets = [...httpTargets, ...SCHEMA_TARGET_IDS]

const debug = debuglog('openapi-snippet')

/** Set by --verbose; mirrors trace output to stderr without NODE_DEBUG. */
let verbose = false

/**
 * Emit a trace line. Honors NODE_DEBUG=openapi-snippet (via debuglog) and,
 * when --verbose is set, writes the same message to stderr directly. The
 * two paths are mutually exclusive so a line is never printed twice.
 */
function trace(fmt: string, ...args: unknown[]): void {
  if (debug.enabled) {
    debug(fmt, ...args)
  } else if (verbose) {
    process.stderr.write(`openapi-snippet ${format(fmt, ...args)}\n`)
  }
}

/** Context handed to the command — carries the host process for I/O. */
interface LocalContext extends CommandContext {
  readonly process: NodeJS.Process
}

interface CliFlags {
  readonly targets?: readonly string[]
  readonly ext: string
  readonly output: string
  readonly listTargets: boolean
  readonly stdin: boolean
  readonly dryRun: boolean
  readonly verbose: boolean
  readonly chunkSize: number
  readonly skipErrors: boolean
  readonly inlineRedoc: boolean
  readonly redocBundleUrl?: string
  readonly smartSamples: boolean
  readonly splitByTag: boolean
  readonly schemaModelsDir?: string
}

const pkgVersion = (() => {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

async function runSnippets(
  this: LocalContext,
  flags: CliFlags,
  file?: string,
): Promise<Error | undefined> {
  // Returning (rather than throwing) the error lets Stricli print a clean
  // message via `commandErrorResult` instead of a stack trace, while
  // `determineExitCode` still maps CliError.exitCode to the process code.
  try {
    await execute(this.process, flags, file)
    return undefined
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

async function execute(proc: NodeJS.Process, flags: CliFlags, file?: string): Promise<void> {
  verbose = flags.verbose

  if (flags.listTargets) {
    for (const t of allTargets) proc.stdout.write(`${t}\n`)
    return
  }

  const input = resolveInput(proc, file, flags.stdin)
  trace('input source: %s', input.source)
  const api = await loadSpec(input)
  const pathCount = Object.keys(api.paths ?? {}).length
  trace('spec loaded: %d paths', pathCount)

  // Warn when the no-chunk path would be slow on a large spec.
  // Threshold matches the empirical 5s cliff at ~5000 paths.
  if (flags.chunkSize === 0 && pathCount >= LARGE_SPEC_PATH_THRESHOLD) {
    proc.stderr.write(
      `Tip: this spec has ${pathCount} paths. Pass --chunk-size 100 for ~6x faster serialization.\n`,
    )
  }

  if (flags.chunkSize < 0) {
    throw new CliError(`--chunk-size must be >= 0 (got ${flags.chunkSize})`, ExitCode.USER_ERROR)
  }
  if (flags.ext !== 'yaml' && flags.ext !== 'json' && flags.ext !== 'html') {
    throw new CliError(`Unknown --ext value: ${flags.ext}`, ExitCode.USER_ERROR)
  }
  const ext = flags.ext

  // Chunked streaming only applies to YAML. JSON/HTML are serialized all at
  // once (splitting either across chunks would produce an invalid document).
  if (flags.chunkSize > 0 && ext !== 'yaml') {
    proc.stderr.write(
      `--chunk-size only speeds up YAML output; -e ${ext} is serialized all at once.\n`,
    )
  }

  const targets = resolveTargets(flags.targets)
  trace('targets: %o', targets)

  // Optionally emit canonical, de-duplicated model files for schema targets.
  // These are additive to the enriched document written below.
  if (flags.schemaModelsDir) {
    if (flags.dryRun) {
      throw new CliError(
        '--schema-models-dir writes files and cannot be combined with --dry-run.',
        ExitCode.USER_ERROR,
      )
    }
    writeSchemaModels(proc, api, targets, flags.schemaModelsDir)
  }

  const injectOptions: InjectOptions = {
    skipErrors: flags.skipErrors,
    smartSamples: flags.smartSamples,
    onSkip: (p, m, err) => {
      proc.stderr.write(`Skipped ${m.toUpperCase()} ${p}: ${err.message}\n`)
    },
  }
  // Chunked YAML injects per chunk inside serializeChunked; everything else
  const useChunked = flags.chunkSize > 0 && ext === 'yaml'
  const htmlOptions = resolveHtmlOptions(flags, ext)

  if (flags.splitByTag) {
    if (flags.dryRun) {
      throw new CliError(
        '--split-by-tag writes a folder and cannot be combined with --dry-run.',
        ExitCode.USER_ERROR,
      )
    }
    writeSplitByTag(proc, api, targets, ext, injectOptions, htmlOptions, flags.output)
    return
  }

  writeSingleOutput(proc, api, targets, ext, flags, injectOptions, htmlOptions, useChunked)
}
function resolveHtmlOptions(
  flags: Pick<CliFlags, 'inlineRedoc' | 'redocBundleUrl'>,
  ext: 'yaml' | 'json' | 'html',
): RenderHtmlOptions | undefined {
  if (flags.inlineRedoc && flags.redocBundleUrl) {
    throw new CliError(
      '--inline-redoc and --redoc-bundle-url are mutually exclusive.',
      ExitCode.USER_ERROR,
    )
  }
  if (ext !== 'html') return undefined
  if (flags.inlineRedoc) return { inlineBundle: loadRedocBundle() }
  if (flags.redocBundleUrl) return { bundleUrl: flags.redocBundleUrl }
  return undefined
}

/** Dry-run to stdout, or write a single output file (chunked YAML or one-shot). */
function writeSingleOutput(
  proc: NodeJS.Process,
  api: OpenAPI.Document,
  targets: readonly string[],
  ext: 'yaml' | 'json' | 'html',
  flags: CliFlags,
  injectOptions: InjectOptions,
  htmlOptions: RenderHtmlOptions | undefined,
  useChunked: boolean,
): void {
  if (flags.dryRun) {
    if (useChunked) {
      serializeChunked(api, targets, 'yaml', flags.chunkSize, proc.stdout as never, injectOptions)
    } else {
      const output = serialize(injectSnippets(api, targets, injectOptions), ext, htmlOptions)
      proc.stdout.write(output)
      trace('dry-run: wrote %d bytes to stdout', output.length)
    }
    return
  }

  const absoluteFileName = path.resolve(flags.output)
  fs.mkdirSync(path.dirname(absoluteFileName), { recursive: true })

  if (useChunked) {
    const stream = fs.createWriteStream(absoluteFileName)
    serializeChunked(api, targets, 'yaml', flags.chunkSize, stream as never, injectOptions)
    stream.end()
    trace('wrote chunked output to %s', absoluteFileName)
  } else {
    const output = serialize(injectSnippets(api, targets, injectOptions), ext, htmlOptions)
    fs.writeFileSync(absoluteFileName, output)
    trace('wrote %d bytes to %s', output.length, absoluteFileName)
  }
}

const REDOC_BUNDLE_SPECIFIER = 'redoc/bundles/redoc.standalone.js'

/**
 * Resolvers tried, in order, to locate the optional `redoc` package's
 * standalone bundle:
 *   1. from this CLI's own module — finds redoc whether the CLI is installed
 *      locally in a project or globally, under npm, yarn, or pnpm (redoc is an
 *      optional dependency, so the package manager places it alongside the CLI);
 *   2. from the user's project (cwd) — covers a globally-installed CLI using a
 *      redoc that lives in the current project.
 */
function redocResolvers(): ((id: string) => string)[] {
  const fromCli = createRequire(import.meta.url)
  const fromCwd = createRequire(path.join(process.cwd(), 'noop.js'))
  return [(id) => fromCli.resolve(id), (id) => fromCwd.resolve(id)]
}

/**
 * Load the Redoc standalone bundle from the optional `redoc` dependency.
 * Throws a CliError with install guidance when it cannot be found in any
 * candidate location.
 */
export function loadRedocBundle(
  resolvers: ((id: string) => string)[] = redocResolvers(),
  read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string {
  for (const resolve of resolvers) {
    try {
      return read(resolve(REDOC_BUNDLE_SPECIFIER))
    } catch {
      // Not found via this resolver — try the next.
    }
  }
  throw new CliError(
    '`--inline-redoc` needs the optional `redoc` package, which was not found. ' +
      'Install it alongside the CLI with `npm i redoc` (or `yarn add redoc`, or ' +
      '`pnpm add redoc`); add `-g`/`global` if you installed this CLI globally, ' +
      'or run it from a project that has `redoc` installed.',
    ExitCode.USER_ERROR,
  )
}

function resolveInput(
  proc: NodeJS.Process,
  file: string | undefined,
  stdin: boolean,
): { source: string; stdin: boolean } {
  if (file) return { source: file, stdin: false }
  // No positional value. Read from stdin when piped (the --stdin flag is an
  // explicit signal of the same intent). A TTY with no input is an error.
  if (stdin || !proc.stdin.isTTY) return { source: '', stdin: true }
  throw new CliError(
    'No input provided. Pass a file path/URL or pipe a spec on stdin.',
    ExitCode.USER_ERROR,
  )
}

function resolveTargets(input: readonly string[] | undefined): string[] {
  const inputTargets = input?.flatMap((t) => t.split(',')) ?? []
  // Default to HTTP targets only; schema targets must be requested explicitly.
  const resolved = (inputTargets.length ? inputTargets : httpTargets)
    .map((arg) => allTargets.find((target) => target.startsWith(arg)))
    .filter((t): t is string => t !== undefined)
  if (inputTargets.length && resolved.length === 0) {
    throw new CliError(
      `No valid --targets matched: ${inputTargets.join(', ')}. Run with --list-targets to see valid values.`,
      ExitCode.USER_ERROR,
    )
  }
  return resolved
}

function serialize(
  api: OpenAPI.Document,
  ext: 'yaml' | 'json' | 'html',
  htmlOptions?: RenderHtmlOptions,
): string {
  if (ext === 'yaml') return yaml.dump(api)
  if (ext === 'html') return renderHtml(api, htmlOptions)
  return JSON.stringify(api, null, 2)
}

/** Drop a trailing known output extension so `--output` can name a folder. */
function stripKnownExt(p: string): string {
  return p.replace(/\.(ya?ml|json|html?)$/i, '')
}

/**
 * Enrich, split the document by tag, and write one file per tag into a folder
 * (derived from --output). For HTML, also writes an `index.html` linking the
 * per-tag pages. Components in each file are pruned to that tag's $ref closure.
 */
function writeSplitByTag(
  proc: NodeJS.Process,
  api: OpenAPI.Document,
  targets: readonly string[],
  ext: 'yaml' | 'json' | 'html',
  injectOptions: InjectOptions,
  htmlOptions: RenderHtmlOptions | undefined,
  output: string,
): void {
  const enriched = injectSnippets(api, targets, injectOptions)
  const docs = splitByTag(enriched)
  const dir = path.resolve(stripKnownExt(output))
  fs.mkdirSync(dir, { recursive: true })

  const entries: { tag: string; href: string }[] = []
  for (const { tag, document } of docs) {
    const href = `${slugifyTag(tag)}.${ext}`
    fs.writeFileSync(path.join(dir, href), serialize(document, ext, htmlOptions))
    entries.push({ tag, href })
    trace('wrote %s (%d paths)', href, Object.keys(document.paths ?? {}).length)
  }

  if (ext === 'html') {
    const title = (api as { info?: { title?: string } }).info?.title ?? 'API documentation'
    fs.writeFileSync(path.join(dir, 'index.html'), renderTagIndexHtml(title, entries))
  }

  proc.stderr.write(`Wrote ${entries.length} ${ext} file(s) to ${dir}\n`)
}

/**
 * Write one canonical, de-duplicated models file per requested schema target
 * (e.g. `models.zod.ts`, `models.py`) into `dir`, generated from the spec's
 * `components.schemas`. Warns when no schema targets were requested.
 */
function writeSchemaModels(
  proc: NodeJS.Process,
  api: OpenAPI.Document,
  targets: readonly string[],
  dir: string,
): void {
  const schemaTargets = targets.filter((t) => isSchemaTarget(t))
  if (schemaTargets.length === 0) {
    proc.stderr.write(
      '--schema-models-dir was set, but --targets has no schema targets ' +
        '(typescript_zod, typescript_valibot, python_pydantic); nothing written.\n',
    )
    return
  }
  const schemas = ((api as { components?: { schemas?: Record<string, unknown> } }).components
    ?.schemas ?? {}) as Record<string, unknown>
  const absDir = path.resolve(dir)
  fs.mkdirSync(absDir, { recursive: true })
  for (const t of schemaTargets) {
    const target = SCHEMA_TARGETS[t]
    fs.writeFileSync(path.join(absDir, target.fileName), generateModels(schemas, t))
    trace('wrote %s', target.fileName)
  }
  proc.stderr.write(`Wrote ${schemaTargets.length} model file(s) to ${absDir}\n`)
}

const command = buildCommand<CliFlags, [file?: string], LocalContext>({
  docs: {
    brief: 'Add code snippets to an OpenAPI spec in redoc style (x-codeSamples)',
    fullDescription:
      'Adds code snippets in the specified languages and frameworks to every ' +
      'operation of an OpenAPI document using openapi-snippet, in redoc style ' +
      '(x-codeSamples).',
  },
  parameters: {
    positional: {
      kind: 'tuple',
      parameters: [
        {
          brief:
            'input openapi document — local file path or http/https URL. ' +
            'Reads the spec from stdin when omitted and stdin is piped.',
          parse: String,
          placeholder: 'file',
          optional: true,
        },
      ],
    },
    flags: {
      targets: {
        kind: 'parsed',
        parse: String,
        variadic: true,
        optional: true,
        brief:
          'target snippet languages + frameworks. Repeatable, and comma-separated ' +
          'values are accepted. A language-only value resolves to its default ' +
          'framework. Defaults to all HTTP-request targets; the schema targets ' +
          '(typescript_zod, typescript_valibot, python_pydantic) are opt-in.',
      },
      ext: {
        kind: 'parsed',
        parse: String,
        default: 'yaml',
        brief: 'output format: yaml, json, or html (a standalone Redoc page)',
      },
      output: {
        kind: 'parsed',
        parse: String,
        default: 'output.yaml',
        brief: 'output file name. Ignored when --dry-run is set.',
      },
      listTargets: {
        kind: 'boolean',
        brief: 'print the list of valid --targets values and exit',
        default: false,
      },
      stdin: {
        kind: 'boolean',
        brief: 'read the spec from stdin (auto-detected when no file is given and stdin is piped)',
        default: false,
      },
      dryRun: {
        kind: 'boolean',
        brief: 'print the resolved spec to stdout instead of writing it to --output',
        default: false,
      },
      verbose: {
        kind: 'boolean',
        brief: 'enable trace-level logging (also: NODE_DEBUG=openapi-snippet)',
        default: false,
      },
      chunkSize: {
        kind: 'parsed',
        parse: numberParser,
        default: '0',
        brief:
          'process N paths per chunk when serializing. Lower values use less memory ' +
          'and finish faster on large specs. 0 = process all at once (legacy behavior).',
      },
      skipErrors: {
        kind: 'boolean',
        brief:
          'skip operations whose snippet generation fails (warn on stderr) instead of aborting',
        default: false,
      },
      inlineRedoc: {
        kind: 'boolean',
        brief: 'with -e html, inline the Redoc bundle for a fully offline page (no CDN)',
        default: false,
      },
      redocBundleUrl: {
        kind: 'parsed',
        parse: String,
        optional: true,
        brief:
          'with -e html, load Redoc from this URL instead of the default CDN; ' +
          'cannot be combined with --inline-redoc',
      },
      smartSamples: {
        kind: 'boolean',
        brief:
          'fill un-annotated string fields in sample bodies/params with realistic values ' +
          'inferred from their names (email->user@example.com, *_id->a uuid, ...) instead of "string"',
        default: false,
      },
      splitByTag: {
        kind: 'boolean',
        brief:
          'write a folder with one file per tag (--output is treated as a directory). ' +
          'Components are pruned to each tag, and -e html also emits an index.html.',
        default: false,
      },
      schemaModelsDir: {
        kind: 'parsed',
        parse: String,
        optional: true,
        brief:
          'also write canonical model files for any schema targets in --targets ' +
          '(typescript_zod -> models.zod.ts, typescript_valibot -> models.valibot.ts, ' +
          'python_pydantic -> models.py) into this directory. Cannot be used with --dry-run.',
      },
    },
    aliases: {
      t: 'targets',
      e: 'ext',
      o: 'output',
    },
  },
  func: runSnippets,
})

/** The Stricli application — exported for the launcher and for tests. */
export const app = buildApplication<LocalContext>(command, {
  name: 'openapi-snippet',
  versionInfo: { currentVersion: pkgVersion },
  scanner: { caseStyle: 'allow-kebab-for-camel' },
  determineExitCode: (exc) => (exc instanceof CliError ? exc.exitCode : ExitCode.INTERNAL_ERROR),
})

/** Run the CLI against the given argv (defaults to process argv). */
export async function runMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await run(app, argv, { process })
}
