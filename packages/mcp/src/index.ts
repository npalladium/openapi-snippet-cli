import * as fs from 'node:fs'
import { CliError, dereferenceSpec, ExitCode, loadSpec } from '@openapi-snippet/core'
import { buildApplication, buildCommand, type CommandContext, run } from '@stricli/core'
import { runMcpStdio } from './server.ts'

/** Context handed to the command — carries the host process for I/O. */
interface LocalContext extends CommandContext {
  readonly process: NodeJS.Process
}

const pkgVersion = (() => {
  try {
    const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

async function runMcp(
  this: LocalContext,
  _flags: Record<string, never>,
  file?: string,
): Promise<Error | undefined> {
  try {
    if (!file) {
      throw new CliError(
        'openapi-mcp requires a spec file path or URL (stdin is reserved for the MCP transport).',
        ExitCode.USER_ERROR,
      )
    }
    // Dereference so tools return resolved schemas; circular refs are kept.
    // Keep a separate non-dereferenced copy so the schema-codegen tools can
    // emit named models (a resolved doc would inline every $ref).
    const source = { source: file, stdin: false }
    const rawApi = await loadSpec(source)
    const api = await dereferenceSpec(await loadSpec(source))
    await runMcpStdio(api, { name: 'openapi-mcp', version: pkgVersion }, rawApi)
    return undefined
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

const command = buildCommand<Record<string, never>, [file?: string], LocalContext>({
  docs: {
    brief: 'Serve a stdio MCP server exposing tools to explore an OpenAPI spec',
    fullDescription:
      'Loads (and dereferences) the given OpenAPI document and runs a Model ' +
      'Context Protocol server over stdio, exposing tools to list, search, and ' +
      'inspect operations and schemas, plus generate code snippets.',
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

/** The Stricli application — exported for the launcher and for tests. */
export const app = buildApplication<LocalContext>(command, {
  name: 'openapi-mcp',
  versionInfo: { currentVersion: pkgVersion },
  determineExitCode: (exc) => (exc instanceof CliError ? exc.exitCode : ExitCode.INTERNAL_ERROR),
})

/** Run the CLI against the given argv (defaults to process argv). */
export async function runMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await run(app, argv, { process })
}
