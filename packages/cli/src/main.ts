/**
 * Executable entry point. esbuild bundles this into dist/main.js with a
 * `#!/usr/bin/env node` shebang banner; package.json's `bin` points here.
 * Kept separate from index.ts so importing the library never runs the CLI.
 */
import { runMain } from './index.ts'

process.env.NODE_ENV ??= 'production'

await runMain()
