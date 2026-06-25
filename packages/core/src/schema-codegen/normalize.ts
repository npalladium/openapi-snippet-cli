/**
 * Normalize a raw OpenAPI 3.0/3.1 (JSON-Schema-ish) schema object into the
 * language-neutral {@link Ir}. All the version quirks are absorbed here:
 *   - 3.0 `nullable: true`  vs  3.1 `type: ["x", "null"]` / `type: "null"`
 *   - 3.0 boolean `exclusiveMinimum/Maximum`  vs  3.1 numeric form
 *   - `enum` / `const`, `allOf` / `oneOf` / `anyOf`, `$ref` by name
 *
 * Refs are kept by name (not inlined), so cyclic schemas normalize fine.
 */
import type { Constraints, Ir, IrProperty } from './ir.ts'

type AnyRecord = Record<string, unknown>

/** Extract the model name from a local `#/components/schemas/X` pointer. */
export function refName(ref: string): string | undefined {
  const m = /^#\/components\/schemas\/(.+)$/.exec(ref)
  if (!m) return undefined
  // Decode JSON-pointer escapes (~1 -> /, ~0 -> ~).
  return decodeURIComponent(m[1]).replace(/~1/g, '/').replace(/~0/g, '~')
}

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

/** Convert a raw schema object (or boolean schema) into the IR. */
export function toIr(schema: unknown): Ir {
  // Boolean schemas: `true` = anything, `false` = nothing. Treat as unknown.
  if (typeof schema === 'boolean' || schema == null) return { kind: 'unknown' }
  if (typeof schema !== 'object') return { kind: 'unknown' }
  const s = schema as AnyRecord

  const description = typeof s.description === 'string' ? s.description : undefined

  // $ref — keep as a named reference; fall back to unknown for foreign refs.
  if (typeof s.$ref === 'string') {
    const name = refName(s.$ref)
    const meta = description !== undefined ? { description } : {}
    return name ? { kind: 'ref', name, ...meta } : { kind: 'unknown', ...meta }
  }

  const { nullable, types } = readNullableAndTypes(s)
  const withMeta = (ir: Ir): Ir => {
    if (nullable) ir.nullable = true
    if (description && ir.description === undefined) ir.description = description
    return ir
  }

  const composed = composeIr(s, types)
  return withMeta(composed ?? typeIr(s, types))
}

/**
 * Handle the keywords that take precedence over a plain `type`: `const`/`enum`
 * (pin the value set) and `allOf`/`oneOf`/`anyOf` (composition). Returns
 * undefined when none apply, so the caller falls back to type dispatch.
 */
function composeIr(s: AnyRecord, types: string[]): Ir | undefined {
  if ('const' in s) return enumIr([s.const], types)
  if (Array.isArray(s.enum)) return enumIr(s.enum, types)
  if (Array.isArray(s.allOf)) return { kind: 'allOf', parts: s.allOf.map(toIr) }
  if (Array.isArray(s.oneOf)) {
    return { kind: 'union', options: s.oneOf.map(toIr), discriminator: discriminatorOf(s) }
  }
  if (Array.isArray(s.anyOf)) {
    return { kind: 'union', options: s.anyOf.map(toIr), discriminator: discriminatorOf(s) }
  }
  return undefined
}

/** Dispatch on the (already null-stripped) `type` keyword and shape keywords. */
function typeIr(s: AnyRecord, types: string[]): Ir {
  // Multiple concrete types (3.1 `type: ["string", "integer"]`) -> a union.
  if (types.length > 1) {
    return { kind: 'union', options: types.map((t) => scalarOrObject(t, s)) }
  }
  const type = types[0]
  if (type === 'object' || 'properties' in s || 'additionalProperties' in s) return objectIr(s)
  if (type === 'array' || 'items' in s) return arrayIr(s)
  if (type && SCALAR_TYPES.has(type)) {
    return scalarIr(type as 'string' | 'number' | 'integer' | 'boolean', s)
  }
  return { kind: 'unknown' }
}

/**
 * Read the `type` keyword (string or array) and fold any null-ness — from a
 * 3.1 `"null"` type member or a 3.0 `nullable: true` — into a single flag.
 */
function readNullableAndTypes(s: AnyRecord): { nullable: boolean; types: string[] } {
  let nullable = s.nullable === true
  let types: string[] = []
  if (typeof s.type === 'string') types = [s.type]
  else if (Array.isArray(s.type)) types = s.type.filter((t): t is string => typeof t === 'string')
  if (types.includes('null')) {
    nullable = true
    types = types.filter((t) => t !== 'null')
  }
  return { nullable, types }
}

function discriminatorOf(s: AnyRecord): string | undefined {
  const d = s.discriminator as AnyRecord | undefined
  return d && typeof d.propertyName === 'string' ? d.propertyName : undefined
}

function enumIr(rawValues: unknown[], types: string[]): Ir {
  let nullable = false
  const values: Array<string | number | boolean> = []
  for (const v of rawValues) {
    if (v === null) {
      nullable = true
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      values.push(v)
    }
  }
  const base = inferEnumBase(values, types)
  const ir: Ir = { kind: 'enum', values, ...(base && { base }) }
  if (nullable) ir.nullable = true
  return ir
}

function inferEnumBase(
  values: Array<string | number | boolean>,
  types: string[],
): 'string' | 'number' | 'integer' | 'boolean' | undefined {
  const declared = types[0]
  if (declared && SCALAR_TYPES.has(declared)) {
    return declared as 'string' | 'number' | 'integer' | 'boolean'
  }
  if (values.length === 0) return undefined
  if (values.every((v) => typeof v === 'string')) return 'string'
  if (values.every((v) => typeof v === 'number')) return 'number'
  if (values.every((v) => typeof v === 'boolean')) return 'boolean'
  return undefined
}

/** Build a scalar IR for a concrete type, or an object/array if that's the type. */
function scalarOrObject(type: string, s: AnyRecord): Ir {
  if (type === 'object') return objectIr(s)
  if (type === 'array') return arrayIr(s)
  if (SCALAR_TYPES.has(type)) {
    return scalarIr(type as 'string' | 'number' | 'integer' | 'boolean', s)
  }
  return { kind: 'unknown' }
}

function objectIr(s: AnyRecord): Ir {
  const props = (s.properties as AnyRecord | undefined) ?? {}
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : [])
  const properties: IrProperty[] = Object.keys(props).map((name) => {
    const schema = toIr(props[name])
    return {
      name,
      schema,
      required: required.has(name),
      ...(schema.description !== undefined && { description: schema.description }),
    }
  })

  let additional: Ir | false | undefined
  const ap = s.additionalProperties
  if (ap === false) additional = false
  else if (ap && typeof ap === 'object') additional = toIr(ap)

  return { kind: 'object', properties, ...(additional !== undefined && { additional }) }
}

function arrayIr(s: AnyRecord): Ir {
  const constraints: Constraints = {}
  if (typeof s.minItems === 'number') constraints.minItems = s.minItems
  if (typeof s.maxItems === 'number') constraints.maxItems = s.maxItems
  if (s.uniqueItems === true) constraints.uniqueItems = true
  const items = s.items === undefined ? ({ kind: 'unknown' } as Ir) : toIr(s.items)
  return {
    kind: 'array',
    items,
    ...(Object.keys(constraints).length > 0 && { constraints }),
  }
}

function scalarIr(type: 'string' | 'number' | 'integer' | 'boolean', s: AnyRecord): Ir {
  const constraints = readConstraints(s)
  return {
    kind: 'scalar',
    type,
    ...(typeof s.format === 'string' && { format: s.format }),
    ...(constraints && { constraints }),
  }
}

/** Read scalar constraints, normalizing the 3.0 boolean exclusive form. */
function readConstraints(s: AnyRecord): Constraints | undefined {
  const c: Constraints = {}
  if (typeof s.minLength === 'number') c.minLength = s.minLength
  if (typeof s.maxLength === 'number') c.maxLength = s.maxLength
  if (typeof s.pattern === 'string') c.pattern = s.pattern
  if (typeof s.multipleOf === 'number') c.multipleOf = s.multipleOf

  // exclusiveMinimum: 3.1 is a number; 3.0 is a boolean modifier on `minimum`.
  if (typeof s.exclusiveMinimum === 'number') c.exclusiveMinimum = s.exclusiveMinimum
  else if (s.exclusiveMinimum === true && typeof s.minimum === 'number')
    c.exclusiveMinimum = s.minimum
  else if (typeof s.minimum === 'number') c.minimum = s.minimum

  if (typeof s.exclusiveMaximum === 'number') c.exclusiveMaximum = s.exclusiveMaximum
  else if (s.exclusiveMaximum === true && typeof s.maximum === 'number')
    c.exclusiveMaximum = s.maximum
  else if (typeof s.maximum === 'number') c.maximum = s.maximum

  return Object.keys(c).length > 0 ? c : undefined
}
