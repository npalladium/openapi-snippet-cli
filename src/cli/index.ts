import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { debuglog, format } from 'node:util'
import { dereference, parse as parseOpenAPI } from '@readme/openapi-parser'
import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  type CommandContext,
  numberParser,
  run,
} from '@stricli/core'
import yaml from 'js-yaml'
import type { OpenAPI } from 'openapi-types'
import { runMcpStdio } from '../mcp/server.ts'
import {
  type InjectOptions,
  injectSnippets,
  type RenderHtmlOptions,
  renderHtml,
  serializeChunked,
} from '../pipeline.ts'

/**
 * Warn when the no-chunk path would dominate runtime on a large spec.
 * Empirically, `yaml.dump` on a 10000-path spec takes ~11s and grows
 * quadratically with size; below ~5000 paths the no-chunk path is
 * still well under a second.
 */
export const LARGE_SPEC_PATH_THRESHOLD = 5000

export const allTargets = [
  'c_libcurl',
  'csharp_restsharp',
  'go_native',
  'java_okhttp',
  'java_unirest',
  'javascript_jquery',
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

/** Exit codes per the project convention. */
export const ExitCode = {
  OK: 0,
  USER_ERROR: 1,
  INTERNAL_ERROR: 2,
  NETWORK_ERROR: 3,
} as const

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

/** Error carrying the exit code the CLI should terminate with. */
export class CliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
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
}

const pkgVersion = (() => {
  try {
    const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
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

  const injectOptions: InjectOptions = {
    skipErrors: flags.skipErrors,
    onSkip: (p, m, err) => {
      proc.stderr.write(`Skipped ${m.toUpperCase()} ${p}: ${err.message}\n`)
    },
  }
  // Chunked YAML injects per chunk inside serializeChunked; everything else
  // injects once here. Computing it lazily avoids a wasted full injection
  // (and duplicate onSkip warnings) on the chunked path.
  const useChunked = flags.chunkSize > 0 && ext === 'yaml'
  const htmlOptions: RenderHtmlOptions | undefined =
    ext === 'html' && flags.inlineRedoc ? { inlineBundle: readRedocBundle() } : undefined

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

/** Read the Redoc standalone bundle shipped by the `redoc` dependency. */
function readRedocBundle(): string {
  const require = createRequire(import.meta.url)
  return fs.readFileSync(require.resolve('redoc/bundles/redoc.standalone.js'), 'utf8')
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
          'framework. Defaults to ALL supported targets.',
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
    },
    aliases: {
      t: 'targets',
      e: 'ext',
      o: 'output',
    },
  },
  func: runSnippets,
})

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

async function loadSpec(input: { source: string; stdin: boolean }): Promise<OpenAPI.Document> {
  if (input.source.startsWith('http://') || input.source.startsWith('https://')) {
    return loadFromUrl(input.source)
  }
  if (input.stdin) {
    return parseContent(await readStdin())
  }
  // A value that doesn't reference an existing local file is treated as raw
  // spec content; otherwise let the parser resolve the file and its $refs.
  if (input.source !== '' && !fs.existsSync(input.source)) {
    return parseContent(input.source)
  }
  return parseOpenAPI(input.source) as unknown as OpenAPI.Document
}

function parseContent(text: string): OpenAPI.Document {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = yaml.load(text)
  }
  // biome-ignore lint/suspicious/noExplicitAny: parser expects APIDocument which we can't statically know after JSON.parse / yaml.load
  return parseOpenAPI(parsed as any) as unknown as OpenAPI.Document
}

async function loadFromUrl(url: string): Promise<OpenAPI.Document> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new CliError(`Network error fetching ${url}: ${msg}`, ExitCode.NETWORK_ERROR)
  }
  if (!res.ok) {
    throw new CliError(
      `Failed to fetch spec: HTTP ${res.status} ${res.statusText} — ${url}`,
      ExitCode.NETWORK_ERROR,
    )
  }
  return parseContent(await res.text())
}

function resolveTargets(input: readonly string[] | undefined): string[] {
  const inputTargets = input?.flatMap((t) => t.split(',')) ?? []
  const resolved = (inputTargets.length ? inputTargets : allTargets)
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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError(
      'No data on stdin. Pipe a spec into the command, e.g. `cat spec.yaml | openapi-snippet --stdin`.',
      ExitCode.USER_ERROR,
    )
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function runMcp(
  this: LocalContext,
  _flags: Record<string, never>,
  file?: string,
): Promise<Error | undefined> {
  try {
    if (!file) {
      throw new CliError(
        'The mcp command requires a spec file path or URL (stdin is reserved for the MCP transport).',
        ExitCode.USER_ERROR,
      )
    }
    const parsed = await loadSpec({ source: file, stdin: false })
    // Dereference so tools return resolved schemas; keep circular refs as-is.
    const api = (await dereference(parsed, {
      dereference: { circular: 'ignore' },
    })) as unknown as OpenAPI.Document
    await runMcpStdio(api, { name: 'openapi-snippet', version: pkgVersion })
    return undefined
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

const mcpCommand = buildCommand<Record<string, never>, [file?: string], LocalContext>({
  docs: {
    brief: 'Run a stdio MCP server exposing tools to explore the given OpenAPI spec',
  },
  parameters: {
    positional: {
      kind: 'tuple',
      parameters: [
        {
          brief: 'input openapi document — local file path or http/https URL',
          parse: String,
          placeholder: 'file',
          optional: true,
        },
      ],
    },
    flags: {},
  },
  func: runMcp,
})

const routes = buildRouteMap({
  routes: { mcp: mcpCommand, add: command },
  defaultCommand: 'add',
  docs: {
    brief: 'Add code snippets to an OpenAPI spec (x-codeSamples); also serve it over MCP',
  },
})

/** The Stricli application — exported for the launcher and for tests. */
export const app = buildApplication<LocalContext>(routes, {
  name: 'openapi-snippet',
  versionInfo: { currentVersion: pkgVersion },
  scanner: { caseStyle: 'allow-kebab-for-camel' },
  determineExitCode: (exc) => (exc instanceof CliError ? exc.exitCode : ExitCode.INTERNAL_ERROR),
})

/** Run the CLI against the given argv (defaults to process argv). */
export async function runMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await run(app, argv, { process })
}
