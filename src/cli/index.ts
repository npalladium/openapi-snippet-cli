import * as fs from 'node:fs'
import * as path from 'node:path'
import { debuglog } from 'node:util'
import { Args, Command, Flags } from '@oclif/core'
import { parse as parseOpenAPI } from '@readme/openapi-parser'
import yaml from 'js-yaml'
import type { OpenAPI } from 'openapi-types'
import { injectSnippets, serializeChunked } from '../pipeline.ts'

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

class CliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

class OpenapiSnippetCli extends Command {
  static description =
    'Adds code snippets in specified languages and frameworks using openapi-snippet in redoc style'

  static flags = {
    version: Flags.version({ char: 'v' }),
    targets: Flags.string({
      description:
        'target snippet languages + frameworks. Can be provided multiple times. If inputting language only, defaults to one of the frameworks. Supports languages supported in https://github.com/ErikWittern/openapi-snippet. Defaults to adding snippets for ALL supported languages.',
      char: 't',
      multiple: true,
    }),
    ext: Flags.string({
      description: 'output format',
      char: 'e',
      options: ['yaml', 'json'],
      default: 'yaml',
    }),
    output: Flags.string({
      description: 'output file name. Ignored when --dry-run or --stdout is set.',
      char: 'o',
      default: 'output.yaml',
    }),
    'list-targets': Flags.boolean({
      description: 'print the list of valid --targets values and exit',
      default: false,
    }),
    stdin: Flags.boolean({
      description: 'read the spec from stdin instead of a file path or URL',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'print the resolved spec to stdout instead of writing it to --output',
      default: false,
    }),
    verbose: Flags.boolean({
      description: 'enable trace-level logging (also: NODE_DEBUG=openapi-snippet)',
      default: false,
    }),
    'chunk-size': Flags.integer({
      description:
        'process N paths per chunk when serializing. Lower values use less memory and finish faster on large specs. 0 = process all at once (legacy behavior).',
      default: 0,
    }),
  }

  static args = {
    file: Args.string({
      description:
        'input openapi document — local file path or http/https URL. Required unless --stdin is set.',
      required: false,
    }),
  }

  async run() {
    const { args, flags } = await this.parse(OpenapiSnippetCli)

    try {
      if (flags['list-targets']) {
        this.printTargets()
        return
      }

      const input = this.resolveInput(args.file, flags.stdin)
      debug('input source: %s', input.source)
      const api = await this.loadSpec(input)
      debug('spec loaded: %d paths', Object.keys(api.paths ?? {}).length)

      if (flags['chunk-size'] < 0) {
        throw new CliError(
          `--chunk-size must be >= 0 (got ${flags['chunk-size']})`,
          ExitCode.USER_ERROR,
        )
      }
      const targets = this.resolveTargets(flags.targets)
      debug('targets: %o', targets)

      const apiWithSnippets = this.withSnippets(api, targets)

      if (flags['dry-run']) {
        if (flags['chunk-size'] > 0 && flags.ext === 'yaml') {
          this.serializeChunkedToStream(api, targets, 'yaml', flags['chunk-size'], process.stdout)
        } else {
          const output = this.serialize(apiWithSnippets, flags.ext)
          process.stdout.write(output)
          debug('dry-run: wrote %d bytes to stdout', output.length)
        }
        return
      }

      const absoluteFileName = path.resolve(flags.output)
      const dir = path.dirname(absoluteFileName)
      fs.mkdirSync(dir, { recursive: true })

      if (flags['chunk-size'] > 0 && flags.ext === 'yaml') {
        const stream = fs.createWriteStream(absoluteFileName)
        this.serializeChunkedToStream(api, targets, 'yaml', flags['chunk-size'], stream)
        stream.end()
        debug('wrote chunked output to %s', absoluteFileName)
      } else {
        const output = this.serialize(apiWithSnippets, flags.ext)
        fs.writeFileSync(absoluteFileName, output)
        debug('wrote %d bytes to %s', output.length, absoluteFileName)
      }
    } catch (err) {
      const code = err instanceof CliError ? err.exitCode : ExitCode.INTERNAL_ERROR
      this.error(err instanceof Error ? err.message : String(err), { exit: code })
    }
  }

  private resolveInput(
    file: string | undefined,
    stdin: boolean,
  ): { source: string; stdin: boolean } {
    // oclif v4 auto-fills missing positionals from stdin when stdin is piped.
    // If `file` is set, prefer the explicit value; treat any value that
    // does not reference an existing local file as raw spec content.
    if (file) return { source: file, stdin: false }
    // No positional value: must be stdin-piped and an error otherwise.
    if (!stdin) {
      throw new CliError(
        'No input provided. Pass a file path/URL or pipe a spec on stdin.',
        ExitCode.USER_ERROR,
      )
    }
    return { source: '', stdin: true }
  }

  private printTargets(): void {
    for (const t of allTargets) {
      process.stdout.write(`${t}\n`)
    }
  }

  async loadSpec(input: { source: string; stdin: boolean }): Promise<OpenAPI.Document> {
    if (input.source.startsWith('http://') || input.source.startsWith('https://')) {
      return this.loadFromUrl(input.source)
    }
    if (input.source === '' && !input.stdin) {
      throw new CliError('No input provided.', ExitCode.USER_ERROR)
    }
    // oclif v4 auto-fills missing positionals from stdin when stdin is piped,
    // so `input.source` is the raw spec text in that case. Treat any value
    // that doesn't reference an existing local file as raw content.
    if (input.source !== '' && !fs.existsSync(input.source)) {
      return this.loadFromContent(input.source)
    }
    if (input.source === '' && input.stdin) {
      return this.loadFromStdin()
    }
    return parseOpenAPI(input.source) as unknown as OpenAPI.Document
  }

  private loadFromContent(text: string): OpenAPI.Document {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = yaml.load(text)
    }
    // biome-ignore lint/suspicious/noExplicitAny: parser expects APIDocument which we can't statically know after JSON.parse / yaml.load
    return parseOpenAPI(parsed as any) as unknown as OpenAPI.Document
  }

  private async loadFromStdin(): Promise<OpenAPI.Document> {
    const text = await readStdin()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = yaml.load(text)
    }
    // biome-ignore lint/suspicious/noExplicitAny: parser expects APIDocument which we can't statically know after JSON.parse / yaml.load
    return parseOpenAPI(parsed as any) as unknown as OpenAPI.Document
  }

  private async loadFromUrl(url: string): Promise<OpenAPI.Document> {
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
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = yaml.load(text)
    }
    // biome-ignore lint/suspicious/noExplicitAny: parser expects APIDocument which we can't statically know after JSON.parse / yaml.load
    return parseOpenAPI(parsed as any) as unknown as OpenAPI.Document
  }

  private resolveTargets(input: string[] | undefined): string[] {
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

  private serialize(api: OpenAPI.Document, ext: string): string {
    if (ext === 'yaml') return yaml.dump(api)
    if (ext === 'json') return JSON.stringify(api, null, 2)
    throw new CliError(`Unknown --ext value: ${ext}`, ExitCode.USER_ERROR)
  }

  withSnippets(api: OpenAPI.Document, targets: readonly string[]): OpenAPI.Document {
    return injectSnippets(api, targets)
  }

  serializeChunkedToStream(
    api: OpenAPI.Document,
    targets: readonly string[],
    format: 'yaml' | 'json',
    chunkSize: number,
    stream: NodeJS.WritableStream,
  ): void {
    serializeChunked(api, targets, format, chunkSize, stream as never)
  }
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

export { OpenapiSnippetCli as default }
