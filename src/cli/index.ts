import * as fs from 'node:fs'
import * as path from 'node:path'
import { Args, Command, Flags } from '@oclif/core'
import { parse as parseOpenAPI } from '@readme/openapi-parser'
import yaml from 'js-yaml'
import cloneDeep from 'lodash/cloneDeep.js'
import type { OpenAPI } from 'openapi-types'
import * as OpenAPISnippet from '../openapi-snippet/index.ts'

const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

const allTargets = [
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
      description: 'output file name',
      char: 'o',
      default: 'output.yaml',
    }),
  }

  static args = {
    file: Args.string({
      description:
        'input openapi document — local file path or http/https URL. References (internal and external) are resolved automatically.',
    }),
  }

  async run() {
    const { args, flags } = await this.parse(OpenapiSnippetCli)

    const input = args.file
    if (!input) {
      await this.config.runCommand('help', [this.id ?? ''])
      return
    }

    const api = await this.loadSpec(input)
    const inputTargets = flags.targets?.flatMap((t) => t.split(',')) ?? []
    const resolvedTargets = (inputTargets.length ? inputTargets : allTargets)
      .map((arg) => allTargets.find((target) => target.startsWith(arg)))
      .filter((t): t is string => t !== undefined)
    const apiWithSnippets = this.withSnippets(api, resolvedTargets)

    const absoluteFileName = path.resolve(flags.output)
    const dir = path.dirname(absoluteFileName)
    fs.mkdirSync(dir, { recursive: true })
    if (flags.ext === 'yaml') {
      fs.writeFileSync(absoluteFileName, yaml.dump(apiWithSnippets))
    } else if (flags.ext === 'json') {
      fs.writeFileSync(absoluteFileName, JSON.stringify(apiWithSnippets, null, 2))
    }
  }

  async loadSpec(input: string): Promise<OpenAPI.Document> {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const res = await fetch(input)
      if (!res.ok)
        throw new Error(`Failed to fetch spec: HTTP ${res.status} ${res.statusText} — ${input}`)
      const text = await res.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = yaml.load(text)
      }
      // biome-ignore lint/suspicious/noExplicitAny: @readme/openapi-parser expects APIDocument which we can't statically know after JSON.parse / yaml.load
      return parseOpenAPI(parsed as any) as unknown as OpenAPI.Document
    }
    return parseOpenAPI(input) as unknown as OpenAPI.Document
  }

  withSnippets(api: OpenAPI.Document, targets: readonly string[]) {
    const clone = cloneDeep(api)
    const paths = clone.paths ?? {}
    for (const path of Object.keys(paths)) {
      const pathItem = paths[path]
      if (!pathItem) continue
      for (const method of Object.keys(pathItem)) {
        if (methods.includes(method)) {
          ;(pathItem as Record<string, Record<string, unknown>>)[method]['x-codeSamples'] =
            this.fetchSnippets(clone, path, method, targets)
        }
      }
    }
    return clone
  }

  fetchSnippets(api: OpenAPI.Document, path: string, method: string, targets: readonly string[]) {
    return OpenAPISnippet.getEndpointSnippets(api, path, method, [...targets]).snippets.map(
      (snippet: { title: string; content: string }) => ({
        lang: snippet.title,
        source: snippet.content,
      }),
    )
  }
}

export { OpenapiSnippetCli as default }
