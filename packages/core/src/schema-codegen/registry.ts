/** The schema-codegen target registry (kept separate to avoid import cycles). */
import { pydanticModels } from './emit-pydantic.ts'
import type { NamedModel } from './emit-util.ts'
import { valibotModels } from './emit-valibot.ts'
import { zodModels } from './emit-zod.ts'

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
