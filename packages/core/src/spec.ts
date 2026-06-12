/**
 * Spec loading shared by the CLIs: read an OpenAPI document from a file path,
 * http(s) URL, stdin, or raw content, and optionally dereference it.
 */
import * as fs from 'node:fs'
import { dereference, parse as parseOpenAPI } from '@readme/openapi-parser'
import yaml from 'js-yaml'
import type { OpenAPI } from 'openapi-types'
import { CliError, ExitCode } from './errors.ts'

export type SpecInput = { source: string; stdin: boolean }

/**
 * Load a spec from the resolved input. `source` may be an http(s) URL, a local
 * file path, or raw spec content; when `stdin` is set the spec is read from
 * stdin instead.
 */
export async function loadSpec(input: SpecInput): Promise<OpenAPI.Document> {
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

export function parseContent(text: string): OpenAPI.Document {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = yaml.load(text)
  }
  // biome-ignore lint/suspicious/noExplicitAny: parser expects APIDocument which we can't statically know after JSON.parse / yaml.load
  return parseOpenAPI(parsed as any) as unknown as OpenAPI.Document
}

export async function loadFromUrl(url: string): Promise<OpenAPI.Document> {
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

export async function readStdin(): Promise<string> {
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

/** Dereference `$ref`s, leaving circular references in place. */
export async function dereferenceSpec(api: OpenAPI.Document): Promise<OpenAPI.Document> {
  // biome-ignore lint/suspicious/noExplicitAny: parser's APIDocument type is structurally compatible
  return (await dereference(api as any, {
    dereference: { circular: 'ignore' },
  })) as unknown as OpenAPI.Document
}
