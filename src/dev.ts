/**
 * Dev-mode CLI entry. Mirrors bin/run but loads the TypeScript source
 * directly via tsx (`pnpm dev`), so no build step is required.
 */
process.env.NODE_ENV ??= 'development'

const { runMain } = await import('./cli/index.ts')
await runMain()
