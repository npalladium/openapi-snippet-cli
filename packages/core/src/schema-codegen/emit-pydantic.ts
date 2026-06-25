/** Emit Pydantic v2 models from the IR. */

import { isPyIdent, type NamedModel, pyStr, topoSort } from './emit-util.ts'
import type { Constraints, Ir, IrProperty } from './ir.ts'

/** Tracks which imports a generated module needs. */
interface Imports {
  pydantic: Set<string>
  typing: Set<string>
  datetime: Set<string>
  uuid: boolean
}

function newImports(): Imports {
  return { pydantic: new Set(), typing: new Set(), datetime: new Set(), uuid: false }
}

/** A Python type annotation for the IR (registers any imports it needs). */
function pyType(ir: Ir, imp: Imports): string {
  const base = pyBase(ir, imp)
  return ir.nullable && !base.endsWith('| None') ? `${base} | None` : base
}

function pyBase(ir: Ir, imp: Imports): string {
  switch (ir.kind) {
    case 'ref':
      return ir.name
    case 'unknown':
      imp.typing.add('Any')
      return 'Any'
    case 'scalar':
      return pyScalar(ir, imp)
    case 'enum':
      imp.typing.add('Literal')
      return `Literal[${ir.values.map(pyLiteral).join(', ')}]`
    case 'array':
      return `list[${pyType(ir.items, imp)}]`
    case 'object':
      // Inline (anonymous) objects are not hoisted to classes in v1.
      imp.typing.add('Any')
      return 'dict[str, Any]'
    case 'union':
      return ir.options.length === 1
        ? pyType(ir.options[0], imp)
        : ir.options.map((o) => pyType(o, imp)).join(' | ')
    case 'allOf':
      return ir.parts.length >= 1 ? pyType(ir.parts[0], imp) : anyType(imp)
  }
}

function anyType(imp: Imports): string {
  imp.typing.add('Any')
  return 'Any'
}

function pyScalar(ir: Extract<Ir, { kind: 'scalar' }>, imp: Imports): string {
  switch (ir.type) {
    case 'integer':
      return 'int'
    case 'number':
      return 'float'
    case 'boolean':
      return 'bool'
    default:
      return pyStringType(ir.format, imp)
  }
}

function pyStringType(format: string | undefined, imp: Imports): string {
  switch (format) {
    case 'date-time':
      imp.datetime.add('datetime')
      return 'datetime'
    case 'date':
      imp.datetime.add('date')
      return 'date'
    case 'time':
      imp.datetime.add('time')
      return 'time'
    case 'uuid':
      imp.uuid = true
      return 'UUID'
    case 'byte':
    case 'binary':
      return 'bytes'
    default:
      return 'str'
  }
}

function pyLiteral(v: string | number | boolean): string {
  if (typeof v === 'string') return pyStr(v)
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

/** Map scalar constraints to Pydantic `Field(...)` keyword arguments. */
function fieldArgs(schema: Ir): string[] {
  if (schema.kind !== 'scalar' || !schema.constraints) return []
  const c: Constraints = schema.constraints
  const args: string[] = []
  if (c.minimum !== undefined) args.push(`ge=${c.minimum}`)
  if (c.maximum !== undefined) args.push(`le=${c.maximum}`)
  if (c.exclusiveMinimum !== undefined) args.push(`gt=${c.exclusiveMinimum}`)
  if (c.exclusiveMaximum !== undefined) args.push(`lt=${c.exclusiveMaximum}`)
  if (c.minLength !== undefined) args.push(`min_length=${c.minLength}`)
  if (c.maxLength !== undefined) args.push(`max_length=${c.maxLength}`)
  if (c.pattern !== undefined) args.push(`pattern=${pyStr(c.pattern)}`)
  if (c.multipleOf !== undefined) args.push(`multiple_of=${c.multipleOf}`)
  return args
}

/** Resolve the base classes and merged properties for a class-like IR node. */
function classShape(ir: Ir): { bases: string[]; properties: IrProperty[] } | undefined {
  if (ir.kind === 'object') return { bases: ['BaseModel'], properties: ir.properties }
  if (ir.kind === 'allOf') {
    const bases: string[] = []
    const properties: IrProperty[] = []
    for (const part of ir.parts) {
      if (part.kind === 'ref') bases.push(part.name)
      else if (part.kind === 'object') properties.push(...part.properties)
    }
    return { bases: bases.length ? bases : ['BaseModel'], properties }
  }
  return undefined
}

function fieldLine(p: IrProperty, imp: Imports): string {
  const safeName = isPyIdent(p.name) ? p.name : p.name.replace(/[^A-Za-z0-9_]/g, '_')
  const args = fieldArgs(p.schema)
  if (safeName !== p.name) args.unshift(`alias=${pyStr(p.name)}`)

  let ann = pyType(p.schema, imp)
  if (!p.required && !ann.endsWith('| None')) ann = `${ann} | None`

  let rhs = ''
  if (!p.required && args.length) {
    imp.pydantic.add('Field')
    rhs = ` = Field(default=None, ${args.join(', ')})`
  } else if (!p.required) {
    rhs = ' = None'
  } else if (args.length) {
    imp.pydantic.add('Field')
    rhs = ` = Field(${args.join(', ')})`
  }
  return `    ${safeName}: ${ann}${rhs}`
}

function emitClass(
  name: string,
  shape: { bases: string[]; properties: IrProperty[] },
  imp: Imports,
): string {
  imp.pydantic.add('BaseModel')
  const header = `class ${name}(${shape.bases.join(', ')}):`
  if (shape.properties.length === 0) return `${header}\n    pass\n`
  const fields = shape.properties.map((p) => fieldLine(p, imp)).join('\n')
  return `${header}\n${fields}\n`
}

function importBlock(imp: Imports): string {
  const lines = ['from __future__ import annotations']
  if (imp.datetime.size) {
    lines.push(`from datetime import ${[...imp.datetime].sort().join(', ')}`)
  }
  if (imp.uuid) lines.push('from uuid import UUID')
  if (imp.typing.size) {
    lines.push(`from typing import ${[...imp.typing].sort().join(', ')}`)
  }
  if (imp.pydantic.size) {
    lines.push(`from pydantic import ${[...imp.pydantic].sort().join(', ')}`)
  }
  return lines.join('\n')
}

/** Emit a complete Pydantic module for the given named models. */
export function pydanticModels(models: NamedModel[]): string {
  const imp = newImports()
  const decls = topoSort(models).map(([name, ir]) => {
    const shape = classShape(ir)
    // Non-object top-level schemas become type aliases (e.g. `Pets = list[Pet]`).
    return shape ? emitClass(name, shape, imp) : `${name} = ${pyType(ir, imp)}\n`
  })
  return `${importBlock(imp)}\n\n\n${decls.join('\n')}`
}
