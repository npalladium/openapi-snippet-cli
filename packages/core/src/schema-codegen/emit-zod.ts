/** Emit Zod schemas from the IR. */

import { importStmt, isJsIdent, jsStr, type NamedModel, reindent, topoSort } from './emit-util.ts'
import type { Constraints, Ir } from './ir.ts'

/** A Zod expression for a type (without property-level `.optional()`). */
export function zodType(ir: Ir): string {
  let expr = zodBase(ir)
  if (ir.nullable) expr += '.nullable()'
  return expr
}

function zodBase(ir: Ir): string {
  switch (ir.kind) {
    case 'ref':
      return ir.name
    case 'unknown':
      return 'z.unknown()'
    case 'scalar':
      return zodScalar(ir)
    case 'enum':
      return zodEnum(ir)
    case 'array':
      return zodArray(ir)
    case 'object':
      return zodObject(ir)
    case 'union':
      return ir.options.length === 1
        ? zodType(ir.options[0])
        : `z.union([${ir.options.map(zodType).join(', ')}])`
    case 'allOf':
      return ir.parts.length === 1
        ? zodType(ir.parts[0])
        : ir.parts.map(zodType).reduce((acc, part) => `${acc}.and(${part})`)
  }
}

function zodScalar(ir: Extract<Ir, { kind: 'scalar' }>): string {
  const c = ir.constraints ?? {}
  if (ir.type === 'boolean') return 'z.boolean()'
  if (ir.type === 'string') {
    let e = 'z.string()'
    e += zodStringFormat(ir.format)
    if (c.minLength !== undefined) e += `.min(${c.minLength})`
    if (c.maxLength !== undefined) e += `.max(${c.maxLength})`
    if (c.pattern !== undefined) e += `.regex(new RegExp(${jsStr(c.pattern)}))`
    return e
  }
  // number / integer
  let e = 'z.number()'
  if (ir.type === 'integer') e += '.int()'
  e += zodNumberBounds(c)
  if (c.multipleOf !== undefined) e += `.multipleOf(${c.multipleOf})`
  return e
}

function zodStringFormat(format: string | undefined): string {
  switch (format) {
    case 'email':
      return '.email()'
    case 'uri':
    case 'url':
      return '.url()'
    case 'uuid':
      return '.uuid()'
    case 'date-time':
      return '.datetime()'
    default:
      return ''
  }
}

function zodNumberBounds(c: Constraints): string {
  let e = ''
  if (c.minimum !== undefined) e += `.min(${c.minimum})`
  if (c.maximum !== undefined) e += `.max(${c.maximum})`
  if (c.exclusiveMinimum !== undefined) e += `.gt(${c.exclusiveMinimum})`
  if (c.exclusiveMaximum !== undefined) e += `.lt(${c.exclusiveMaximum})`
  return e
}

function zodEnum(ir: Extract<Ir, { kind: 'enum' }>): string {
  if (ir.values.length === 1) return `z.literal(${literal(ir.values[0])})`
  if (ir.base === 'string' && ir.values.every((v) => typeof v === 'string')) {
    return `z.enum([${ir.values.map((v) => jsStr(v as string)).join(', ')}])`
  }
  return `z.union([${ir.values.map((v) => `z.literal(${literal(v)})`).join(', ')}])`
}

function literal(v: string | number | boolean): string {
  return typeof v === 'string' ? jsStr(v) : String(v)
}

function zodArray(ir: Extract<Ir, { kind: 'array' }>): string {
  let e = `z.array(${zodType(ir.items)})`
  const c = ir.constraints
  if (c?.minItems !== undefined) e += `.min(${c.minItems})`
  if (c?.maxItems !== undefined) e += `.max(${c.maxItems})`
  return e
}

function zodObject(ir: Extract<Ir, { kind: 'object' }>): string {
  if (ir.properties.length === 0) {
    if (ir.additional !== undefined && ir.additional !== false) {
      return `z.record(z.string(), ${zodType(ir.additional)})`
    }
    return ir.additional === false ? 'z.object({}).strict()' : 'z.object({})'
  }
  const lines = ir.properties.map((p) => {
    const key = isJsIdent(p.name) ? p.name : jsStr(p.name)
    const value = reindent(zodType(p.schema), '  ')
    return `  ${key}: ${value}${p.required ? '' : '.optional()'},`
  })
  let out = `z.object({\n${lines.join('\n')}\n})`
  if (ir.additional === false) out += '.strict()'
  else if (ir.additional) out += `.catchall(${zodType(ir.additional)})`
  return out
}

/** Emit a single `export const X = ...` declaration plus its inferred type. */
export function zodModel(name: string, ir: Ir): string {
  return `export const ${name} = ${zodType(ir)}\nexport type ${name} = z.infer<typeof ${name}>\n`
}

/** Emit a complete Zod module for the given named models. */
export function zodModels(models: NamedModel[]): string {
  const ordered = topoSort(models)
  const body = ordered.map(([name, ir]) => zodModel(name, ir)).join('\n')
  return `${importStmt('{ z }', 'zod')}\n\n${body}`
}
