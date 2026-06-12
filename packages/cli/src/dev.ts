/**
 * Dev-mode CLI entry. Loads the TypeScript source directly via tsx
 * (`pnpm dev`), so no build step is required.
 */
process.env.NODE_ENV ??= 'development'

const { runMain } = await import('./index.ts')
await runMain()
