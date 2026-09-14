# Browser Fetch and self-hosted Redoc assets

## Goal

Add a reusable `javascript_fetch` HTTP snippet target and let generated Redoc HTML reference a caller-specified bundle URL. Query-service will use both capabilities for its committed, FastAPI-served consumer documentation site.

## Changes

1. Add `javascript_fetch` to the CLI's curated HTTP target list. `httpsnippet` 3.0.10 already implements the JavaScript Fetch converter, so no custom request serializer is needed.
2. Extend `RenderHtmlOptions` with `bundleUrl`; HTML rendering uses the supplied URL when the bundle is not inlined.
3. Add `--redoc-bundle-url` to the CLI and reject combining it with `--inline-redoc`.
4. Document the Fetch target and self-hosted bundle option.
5. Cover Fetch output, target listing, custom bundle URLs, escaping, and the conflicting-option error.

## Verification

- `pnpm check`
- `pnpm build`
- `pnpm typecheck`
- Targeted core and CLI test suites
- CLI smoke generation with `javascript_fetch`, `--split-by-tag`, and `--redoc-bundle-url`
