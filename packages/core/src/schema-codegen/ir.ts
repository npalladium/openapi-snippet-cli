/**
 * A small, language-neutral intermediate representation (IR) for OpenAPI /
 * JSON-Schema types. Normalizing a schema into this IR once (see
 * `normalize.ts`) lets each backend (zod / valibot / pydantic) emit code from a
 * single, consistent shape — so the OpenAPI 3.0-vs-3.1 quirks (`nullable`,
 * boolean `exclusiveMinimum/Maximum`, `type: [...]`) are handled in exactly one
 * place rather than three.
 */

/** Numeric/string constraints carried on scalars and arrays. */
export interface Constraints {
  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  maximum?: number
  /** Always stored as the boundary value (3.0's boolean form is normalized). */
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
}

/** Fields shared by every IR node. */
export interface IrBase {
  /** The value may also be `null` (3.0 `nullable`, or 3.1 `"null"` in `type`). */
  nullable?: boolean
  description?: string
}

export interface IrScalar extends IrBase {
  kind: 'scalar'
  type: 'string' | 'number' | 'integer' | 'boolean'
  format?: string
  constraints?: Constraints
}

export interface IrEnum extends IrBase {
  kind: 'enum'
  /** Enum/const values, with any `null` lifted into `nullable`. */
  values: Array<string | number | boolean>
  /** The JSON type of the values, when uniform and known. */
  base?: 'string' | 'number' | 'integer' | 'boolean'
}

export interface IrArray extends IrBase {
  kind: 'array'
  items: Ir
  constraints?: Pick<Constraints, 'minItems' | 'maxItems' | 'uniqueItems'>
}

export interface IrProperty {
  name: string
  schema: Ir
  required: boolean
  description?: string
}

export interface IrObject extends IrBase {
  kind: 'object'
  properties: IrProperty[]
  /** A schema for additionalProperties (a dict/record), or false when closed. */
  additional?: Ir | false
}

/** `oneOf` / `anyOf` — a value matching one of several shapes. */
export interface IrUnion extends IrBase {
  kind: 'union'
  options: Ir[]
  discriminator?: string
}

/** `allOf` — a value matching all parts at once (intersection / inheritance). */
export interface IrAllOf extends IrBase {
  kind: 'allOf'
  parts: Ir[]
}

/** A reference to a named model in `components.schemas`. */
export interface IrRef extends IrBase {
  kind: 'ref'
  name: string
}

/** No usable type information (empty schema, `true`, or an unresolvable ref). */
export interface IrUnknown extends IrBase {
  kind: 'unknown'
}

export type Ir = IrScalar | IrEnum | IrArray | IrObject | IrUnion | IrAllOf | IrRef | IrUnknown
