/**
 * Per-operation "typed request" snippets: a self-contained code sample that
 * inlines the model(s) needed for the response, issues the request, and parses
 * the JSON response through that model. These are the schema-codegen analog of
 * httpsnippet's HTTP-request samples.
 */
import { collectRefs, type NamedModel } from './emit-util.ts'
import type { Ir } from './ir.ts'
import { toIr } from './normalize.ts'
import { SCHEMA_TARGETS } from './registry.ts'

type AnyRecord = Record<string, unknown>

/** Resolve the JSON response schema for an operation (2xx preferred). */
function pickResponseSchema(operation: AnyRecord): AnyRecord | undefined {
  const responses = operation.responses as AnyRecord | undefined
  if (!responses) return undefined
  const codes = Object.keys(responses)
  const ordered = [
    ...codes.filter((c) => /^2\d\d$/.test(c)).sort(),
    ...codes.filter((c) => c === 'default'),
  ]
  for (const code of ordered) {
    const response = responses[code] as AnyRecord | undefined
    const content = response?.content as AnyRecord | undefined
    const json = content?.['application/json'] as AnyRecord | undefined
    if (json?.schema) return json.schema as AnyRecord
  }
  return undefined
}

/** Capitalize the first letter (for synthetic model names). */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Build the transitive `$ref` closure over `components.schemas`. */
function closure(roots: NamedModel[], schemas: AnyRecord): NamedModel[] {
  const out = new Map<string, Ir>()
  const pending: string[] = []
  for (const [name, ir] of roots) {
    out.set(name, ir)
    for (const ref of collectRefs(ir)) pending.push(ref)
  }
  while (pending.length) {
    const name = pending.shift() as string
    if (out.has(name) || schemas[name] === undefined) continue
    const ir = toIr(schemas[name])
    out.set(name, ir)
    for (const ref of collectRefs(ir)) pending.push(ref)
  }
  return [...out.entries()]
}

/** The response model for an operation: its name, IR, and inline definitions. */
interface ResponseModel {
  rootName: string
  rootIr: Ir
  models: NamedModel[]
}

function responseModel(
  operation: AnyRecord,
  schemas: AnyRecord,
  path: string,
  method: string,
): ResponseModel | undefined {
  const schema = pickResponseSchema(operation)
  if (!schema) return undefined

  if (typeof schema.$ref === 'string') {
    const m = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref)
    if (m) {
      const rootName = m[1]
      const rootIr = toIr(schemas[rootName])
      return { rootName, rootIr, models: closure([[rootName, rootIr]], schemas) }
    }
  }

  // Inline response schema: synthesize a model named after the operation.
  const opId =
    typeof operation.operationId === 'string'
      ? operation.operationId
      : `${method}${path.replace(/[^A-Za-z0-9]+/g, '_')}`
  const rootName = `${cap(opId)}Response`
  const rootIr = toIr(schema)
  return { rootName, rootIr, models: closure([[rootName, rootIr]], schemas) }
}

/** First server URL (so the snippet has a concrete base), or empty. */
function baseUrl(api: AnyRecord): string {
  const servers = api.servers as Array<{ url?: string }> | undefined
  return servers?.[0]?.url ?? ''
}

/** Whether a Pydantic root is a class (model_validate) vs a type alias. */
function isPydanticClass(ir: Ir): boolean {
  return ir.kind === 'object' || ir.kind === 'allOf'
}

function tsRequest(url: string, method: string, parse: string): string {
  return [
    `const response = await fetch('${url}', {`,
    `  method: '${method.toUpperCase()}',`,
    '})',
    `const data = ${parse}`,
    '',
  ].join('\n')
}

function pyRequest(url: string, method: string, imports: string, parse: string): string {
  return (
    [
      'import requests',
      imports,
      '',
      `response = requests.request('${method.toUpperCase()}', '${url}')`,
      `data = ${parse}`,
      '',
    ]
      .filter((line) => line !== '')
      .join('\n')
      // Re-add the single blank line between imports and the request.
      .replace(/\n(response = )/, '\n\n$1')
  )
}

/**
 * Generate a typed request snippet for one operation in one schema target.
 * Returns self-contained source: inline models + request + typed parse.
 */
export function generateTypedSnippet(
  api: AnyRecord,
  path: string,
  method: string,
  targetId: string,
): string {
  const target = SCHEMA_TARGETS[targetId]
  if (!target) throw new Error(`Unknown schema target: ${targetId}`)

  const pathItem = (api.paths as AnyRecord | undefined)?.[path] as AnyRecord | undefined
  const operation = pathItem?.[method] as AnyRecord | undefined
  if (!operation) throw new Error(`No operation for ${method.toUpperCase()} ${path}`)

  const schemas = ((api.components as AnyRecord | undefined)?.schemas as AnyRecord) ?? {}
  const url = `${baseUrl(api)}${path}`
  const rm = responseModel(operation, schemas, path, method)

  // No typed response body: emit just the request with a note.
  if (!rm) {
    if (target.language === 'python') {
      return `import requests\n\nresponse = requests.request('${method.toUpperCase()}', '${url}')\n# No typed JSON response body for this operation.\n`
    }
    return `const response = await fetch('${url}', {\n  method: '${method.toUpperCase()}',\n})\n// No typed JSON response body for this operation.\n`
  }

  const modelsSrc = target.emit(rm.models)

  if (targetId === 'typescript_zod') {
    return `${modelsSrc}\n${tsRequest(url, method, `${rm.rootName}.parse(await response.json())`)}`
  }
  if (targetId === 'typescript_valibot') {
    return `${modelsSrc}\n${tsRequest(url, method, `v.parse(${rm.rootName}, await response.json())`)}`
  }
  // python_pydantic
  if (isPydanticClass(rm.rootIr)) {
    return `${modelsSrc}\n${pyRequest(url, method, '', `${rm.rootName}.model_validate(response.json())`)}`
  }
  return `${modelsSrc}\n${pyRequest(
    url,
    method,
    'from pydantic import TypeAdapter',
    `TypeAdapter(${rm.rootName}).validate_python(response.json())`,
  )}`
}
