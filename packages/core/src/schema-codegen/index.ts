/**
 * Schema code generation: turn `components.schemas` into typed models for
 * Pydantic / Zod / Valibot. These are NOT httpsnippet (HTTP-request) targets —
 * they emit data-type definitions — so the pipeline routes them here.
 */
import type { NamedModel } from './emit-util.ts'
import { toIr } from './normalize.ts'
import { SCHEMA_TARGETS } from './registry.ts'

export type { NamedModel } from './emit-util.ts'
export type { Ir } from './ir.ts'
export { toIr } from './normalize.ts'
export {
  isSchemaTarget,
  SCHEMA_TARGET_IDS,
  SCHEMA_TARGETS,
  type SchemaTarget,
} from './registry.ts'
export { generateTypedSnippet } from './snippet.ts'

/** Normalize a `components.schemas` map into named IR models. */
export function normalizeSchemas(schemas: Record<string, unknown>): NamedModel[] {
  return Object.keys(schemas).map((name) => [name, toIr(schemas[name])] as NamedModel)
}

/** Generate a complete models module for `components.schemas` in one target. */
export function generateModels(schemas: Record<string, unknown>, targetId: string): string {
  const target = SCHEMA_TARGETS[targetId]
  if (!target) throw new Error(`Unknown schema target: ${targetId}`)
  return target.emit(normalizeSchemas(schemas))
}
