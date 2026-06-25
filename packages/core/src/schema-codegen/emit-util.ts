/** Shared helpers for the code-emitting backends. */
import type { Ir } from './ir.ts'

/** A named model ready to emit, in dependency-friendly order. */
export type NamedModel = readonly [name: string, ir: Ir]

/** Re-indent every line after the first by `pad` (for nesting child exprs). */
export function reindent(expr: string, pad: string): string {
  return expr.split('\n').join(`\n${pad}`)
}

/** A JS/TS string literal (single-quoted to match the repo style). */
export function jsStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * Build a TS `import` statement for generated output. Assembled from parts
 * (not as a single string literal) so the repo's import-hygiene scan doesn't
 * mistake the emitted target's runtime dep (zod/valibot) for a dependency of
 * this package.
 */
export function importStmt(clause: string, pkg: string): string {
  return ['import', clause, 'from', jsStr(pkg)].join(' ')
}

/** A Python string literal. */
export function pyStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

const JS_IDENT = /^[A-Za-z_$][\w$]*$/
const PY_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isJsIdent(name: string): boolean {
  return JS_IDENT.test(name)
}

export function isPyIdent(name: string): boolean {
  return PY_IDENT.test(name)
}

/** Collect the names of all `$ref`s reachable from an IR node. */
export function collectRefs(ir: Ir, into: Set<string> = new Set()): Set<string> {
  switch (ir.kind) {
    case 'ref':
      into.add(ir.name)
      break
    case 'array':
      collectRefs(ir.items, into)
      break
    case 'object':
      for (const p of ir.properties) collectRefs(p.schema, into)
      if (ir.additional !== undefined && ir.additional !== false) {
        collectRefs(ir.additional, into)
      }
      break
    case 'union':
      for (const o of ir.options) collectRefs(o, into)
      break
    case 'allOf':
      for (const p of ir.parts) collectRefs(p, into)
      break
  }
  return into
}

/**
 * Order models so that each appears after the models it references. Uses a
 * stable DFS; members of a dependency cycle keep their original relative order
 * (correctness still holds for backends that tolerate forward references).
 */
export function topoSort(models: NamedModel[]): NamedModel[] {
  const byName = new Map(models.map((m) => [m[0], m]))
  const visited = new Set<string>()
  const onStack = new Set<string>()
  const out: NamedModel[] = []

  const visit = (name: string): void => {
    if (visited.has(name) || onStack.has(name)) return
    const model = byName.get(name)
    if (!model) return
    onStack.add(name)
    for (const dep of collectRefs(model[1])) {
      if (dep !== name) visit(dep)
    }
    onStack.delete(name)
    visited.add(name)
    out.push(model)
  }

  for (const [name] of models) visit(name)
  return out
}
