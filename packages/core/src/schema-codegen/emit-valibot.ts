/** Emit Valibot schemas from the IR. */

import { importStmt, isJsIdent, jsStr, type NamedModel, reindent, topoSort } from './emit-util.ts'
import type { Constraints, Ir } from './ir.ts'

/** A Valibot expression for a type (without property-level `v.optional`). */
export function valibotType(ir: Ir): string {
  const expr = valibotBase(ir)
  return ir.nullable ? `v.nullable(${expr})` : expr
}

function valibotBase(ir: Ir): string {
  switch (ir.kind) {
    case 'ref':
      return ir.name
    case 'unknown':
      return 'v.unknown()'
    case 'scalar':
      return valibotScalar(ir)
    case 'enum':
      return valibotEnum(ir)
    case 'array':
      return valibotArray(ir)
    case 'object':
      return valibotObject(ir)
    case 'union':
      return ir.options.length === 1
        ? valibotType(ir.options[0])
        : `v.union([${ir.options.map(valibotType).join(', ')}])`
    case 'allOf':
      return ir.parts.length === 1
        ? valibotType(ir.parts[0])
        : `v.intersect([${ir.parts.map(valibotType).join(', ')}])`
  }
}

/** Wrap `base` in a `v.pipe(...)` when there are validation actions. */
function pipe(base: string, actions: string[]): string {
  return actions.length ? `v.pipe(${[base, ...actions].join(', ')})` : base
}

function valibotScalar(ir: Extract<Ir, { kind: 'scalar' }>): string {
  const c = ir.constraints ?? {}
  if (ir.type === 'boolean') return 'v.boolean()'
  if (ir.type === 'string') {
    const actions: string[] = []
    const fmt = valibotStringFormat(ir.format)
    if (fmt) actions.push(fmt)
    if (c.minLength !== undefined) actions.push(`v.minLength(${c.minLength})`)
    if (c.maxLength !== undefined) actions.push(`v.maxLength(${c.maxLength})`)
    if (c.pattern !== undefined) actions.push(`v.regex(new RegExp(${jsStr(c.pattern)}))`)
    return pipe('v.string()', actions)
  }
  const actions: string[] = []
  if (ir.type === 'integer') actions.push('v.integer()')
  actions.push(...valibotNumberBounds(c))
  if (c.multipleOf !== undefined) actions.push(`v.multipleOf(${c.multipleOf})`)
  return pipe('v.number()', actions)
}

function valibotStringFormat(format: string | undefined): string | undefined {
  switch (format) {
    case 'email':
      return 'v.email()'
    case 'uri':
    case 'url':
      return 'v.url()'
    case 'uuid':
      return 'v.uuid()'
    case 'date-time':
      return 'v.isoTimestamp()'
    case 'date':
      return 'v.isoDate()'
    default:
      return undefined
  }
}

function valibotNumberBounds(c: Constraints): string[] {
  const a: string[] = []
  if (c.minimum !== undefined) a.push(`v.minValue(${c.minimum})`)
  if (c.maximum !== undefined) a.push(`v.maxValue(${c.maximum})`)
  if (c.exclusiveMinimum !== undefined) a.push(`v.gtValue(${c.exclusiveMinimum})`)
  if (c.exclusiveMaximum !== undefined) a.push(`v.ltValue(${c.exclusiveMaximum})`)
  return a
}

function valibotEnum(ir: Extract<Ir, { kind: 'enum' }>): string {
  if (ir.values.length === 1) return `v.literal(${literal(ir.values[0])})`
  if (ir.base === 'string' && ir.values.every((v) => typeof v === 'string')) {
    return `v.picklist([${ir.values.map((v) => jsStr(v as string)).join(', ')}])`
  }
  return `v.union([${ir.values.map((v) => `v.literal(${literal(v)})`).join(', ')}])`
}

function literal(v: string | number | boolean): string {
  return typeof v === 'string' ? jsStr(v) : String(v)
}

function valibotArray(ir: Extract<Ir, { kind: 'array' }>): string {
  const base = `v.array(${valibotType(ir.items)})`
  const c = ir.constraints
  const actions: string[] = []
  if (c?.minItems !== undefined) actions.push(`v.minLength(${c.minItems})`)
  if (c?.maxItems !== undefined) actions.push(`v.maxLength(${c.maxItems})`)
  return pipe(base, actions)
}

function valibotObject(ir: Extract<Ir, { kind: 'object' }>): string {
  const hasRest = ir.additional !== undefined && ir.additional !== false
  if (ir.properties.length === 0) {
    if (hasRest) return `v.record(v.string(), ${valibotType(ir.additional as Ir)})`
    return ir.additional === false ? 'v.strictObject({})' : 'v.object({})'
  }
  const lines = ir.properties.map((p) => {
    const key = isJsIdent(p.name) ? p.name : jsStr(p.name)
    const t = reindent(valibotType(p.schema), '  ')
    return `  ${key}: ${p.required ? t : `v.optional(${t})`},`
  })
  const entries = `{\n${lines.join('\n')}\n}`
  if (hasRest) return `v.objectWithRest(${entries}, ${valibotType(ir.additional as Ir)})`
  if (ir.additional === false) return `v.strictObject(${entries})`
  return `v.object(${entries})`
}

/** Emit a single `export const X = ...` declaration plus its inferred type. */
export function valibotModel(name: string, ir: Ir): string {
  return `export const ${name} = ${valibotType(ir)}\nexport type ${name} = v.InferOutput<typeof ${name}>\n`
}

/** Emit a complete Valibot module for the given named models. */
export function valibotModels(models: NamedModel[]): string {
  const ordered = topoSort(models)
  const body = ordered.map(([name, ir]) => valibotModel(name, ir)).join('\n')
  return `${importStmt('* as v', 'valibot')}\n\n${body}`
}
