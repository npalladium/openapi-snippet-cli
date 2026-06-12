/**
 * Rewrite relative `.ts` re-export/import specifiers to `.js` in emitted
 * declaration files. `rewriteRelativeImportExtensions` rewrites value imports
 * but leaves `export * from './x.ts'` re-exports in `.d.ts` untouched, which
 * breaks consumers resolving the package. This restores correct extensions.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const distDir = fileURLToPath(new URL('../dist/', import.meta.url))

for (const entry of readdirSync(distDir, { recursive: true })) {
  const file = join(distDir, String(entry))
  if (!file.endsWith('.d.ts')) continue
  const original = readFileSync(file, 'utf8')
  const fixed = original.replace(/(from\s+['"]\.[^'"]*?)\.ts(['"])/g, '$1.js$2')
  if (fixed !== original) writeFileSync(file, fixed)
}
