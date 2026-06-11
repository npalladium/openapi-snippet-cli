/**
 * Dev-mode CLI entry. Mirrors bin/run but loads the TypeScript source
 * directly. Invoked via `pnpm dev` which uses tsx.
 */
const { run, handle } = await import('@oclif/core')

process.env.NODE_ENV ??= 'development'

// In dev, the oclif config in package.json still points at dist/cli/index.js
// which doesn't exist. Override the root path so oclif resolves commands
// from the src tree.
await run(process.argv.slice(2), {
  root: new URL('../src', import.meta.url).pathname,
}).catch(handle)
