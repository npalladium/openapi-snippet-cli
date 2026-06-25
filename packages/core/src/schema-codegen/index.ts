/**
 * Schema code generation: turn `components.schemas` into typed models for
 * Pydantic / Zod / Valibot. These are NOT httpsnippet (HTTP-request) targets —
 * they emit data-type definitions — so the pipeline routes them here.
 */
import { pydanticModels } from './emit-pydantic.ts'
import type { NamedModel } from './emit-util.ts'
import { valibotModels } from './emit-valibot.ts'
import { zodModels } from './emit-zod.ts'
import { toIr } from './normalize.ts'

export type { NamedModel } from './emit-util.ts'
export type { Ir } from './ir.ts'
export { toIr } from './normalize.ts'

export interface SchemaTarget {
  /** The `language_library` id used on `-t/--targets`. */
  id: string
  language: string
  library: string
  /** Title shown in `x-codeSamples` (mirrors httpsnippet's "Lang + Lib"). */
  title: string
  /** Filename for the canonical models file written by `--schema-models-dir`. */
  fileName: string
  /** Emit a full models module for the given named models. */
  emit: (models: NamedModel[]) => string
}

export const SCHEMA_TARGETS: Record<string, SchemaTarget> = {
  typescript_zod: {
    id: 'typescript_zod',
    language: 'typescript',
    library: 'zod',
    title: 'Typescript + Zod',
    fileName: 'models.zod.ts',
    emit: zodModels,
  },
  typescript_valibot: {
    id: 'typescript_valibot',
    language: 'typescript',
    library: 'valibot',
    title: 'Typescript + Valibot',
    fileName: 'models.valibot.ts',
    emit: valibotModels,
  },
  python_pydantic: {
    id: 'python_pydantic',
    language: 'python',
    library: 'pydantic',
    title: 'Python + Pydantic',
    fileName: 'models.py',
    emit: pydanticModels,
  },
}

/** The recognized schema-codegen target ids. */
export const SCHEMA_TARGET_IDS: readonly string[] = Object.keys(SCHEMA_TARGETS)

/** Whether `id` names a schema-codegen target (vs. an httpsnippet target). */
export function isSchemaTarget(id: string): boolean {
  return Object.hasOwn(SCHEMA_TARGETS, id)
}

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
