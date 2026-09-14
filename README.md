openapi-snippet-cli
===================

Adds openapi snippets using `openapi-snippet` module in redoc style (x-codeSamples). This is a CLI wrapper on [openapi-snippet](https://github.com/ErikWittern/openapi-snippet).

> **Note:** This is a maintained fork of [richardkabiling/openapi-snippet-cli](https://github.com/richardkabiling/openapi-snippet-cli), which is itself a CLI wrapper on [ErikWittern/openapi-snippet](https://github.com/ErikWittern/openapi-snippet). This fork rewrites the project in TypeScript ESM, fixes bugs, and keeps dependencies up to date. Please file issues at [npalladium/openapi-snippet-cli](https://github.com/npalladium/openapi-snippet-cli/issues), not on the original repositories.

[![stricli](https://img.shields.io/badge/cli-stricli-brightgreen.svg)](https://bloomberg.github.io/stricli/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/npalladium/openapi-snippet-cli/blob/main/LICENSE)

* [Getting Started](#getting-started)
* [Usage](#usage)
* [Arguments](#arguments)
* [Options](#options)

# Getting Started

## Requirements

- Node.js **22** (active LTS) or **24** (latest LTS). Older Node versions are not supported.
- Any package manager to install (npm, pnpm, or yarn). pnpm 9+ is only needed if you build from source.

## Packages

This is a pnpm monorepo with three packages:

| package | bin | purpose |
|---------|-----|---------|
| [`@npalladium/openapi-snippet-core`](packages/core) | – | shared library: snippet generation, injection, spec loading, HTML rendering |
| [`@npalladium/openapi-snippet-cli`](packages/cli) | `openapi-snippet` | the snippet CLI (yaml/json/html output) |
| [`@npalladium/openapi-mcp`](packages/mcp) | `openapi-mcp` | stdio MCP server for exploring a spec |

## Install

The CLIs are published to npm under the `@npalladium` scope, so no clone is
needed. The snippet CLI and the MCP server are independent packages: installing
the snippet CLI does not pull the MCP SDK, and installing the MCP CLI does not
pull redoc.

### Global install

Install with your package manager of choice; each exposes its short command name
(`openapi-snippet` / `openapi-mcp`), which is what the rest of this README uses:

```sh-session
# the snippet CLI (the `openapi-snippet` command)
$ npm  install -g @npalladium/openapi-snippet-cli
$ pnpm add     -g @npalladium/openapi-snippet-cli
$ yarn global add  @npalladium/openapi-snippet-cli

# the MCP server (the `openapi-mcp` command)
$ npm  install -g @npalladium/openapi-mcp
$ pnpm add     -g @npalladium/openapi-mcp
$ yarn global add  @npalladium/openapi-mcp
```

### Run once, without installing

`npx` (npm) and `pnpm dlx` fetch, run, and discard — nothing is installed
globally. Note these invoke the CLI by its **package** name, not the short
command:

```sh-session
$ npx @npalladium/openapi-snippet-cli schema.yaml -o dist/schema.yaml
$ npx @npalladium/openapi-snippet-cli --list-targets

$ pnpm dlx @npalladium/openapi-snippet-cli schema.yaml -o dist/schema.yaml
$ pnpm dlx @npalladium/openapi-snippet-cli --list-targets

$ npx @npalladium/openapi-mcp https://api.example.com/openapi.json
```

### Build from source

For development (or to hack on the packages), work from a checkout:

```sh-session
$ git clone https://github.com/npalladium/openapi-snippet-cli.git
$ cd openapi-snippet-cli
$ pnpm install
$ pnpm build      # builds core, then the two CLIs (topological order)

# optionally expose the global commands (each `link --global` runs inside its package)
$ cd packages/cli && pnpm link --global && cd ../..   # the `openapi-snippet` command
$ cd packages/mcp && pnpm link --global && cd ../..   # the `openapi-mcp` command
```

Run the TypeScript source directly through `tsx` — no build step required; edit
a file and rerun:

```sh-session
$ pnpm --filter @npalladium/openapi-snippet-cli dev -- schema.yaml -o dist/schema.yaml
```

Or run the built binaries by path:

```sh-session
$ node packages/cli/dist/main.js schema.yaml -o dist/schema.yaml
$ node packages/mcp/dist/main.js schema.yaml
```

## Build Pipeline

Run from the repo root; scripts fan out to the packages with `pnpm -r`:

- `pnpm typecheck` — type-checks every package with `tsc --noEmit`.
- `pnpm build` — builds every package (topological): `@npalladium/openapi-snippet-core`
  emits its bundle + `.d.ts`; the CLIs bundle their executable (`dist/main.js`,
  with a `#!/usr/bin/env node` shebang) via **esbuild**.
- `pnpm test` — runs each package's mocha suite (via `tsx`).
- `pnpm verify` — `check` + `build` + `typecheck` + `test` (build precedes
  typecheck/test because the CLIs resolve the built core).

# Usage
## Adding Snippets to a Schema
```sh-session
$ openapi-snippet schema.yaml -o dist/schema.yaml
```

The example above should add snippets to `schema.yaml` and output the modified schema to a new file `dist/schema.yaml`.

## Outputting JSON
```sh-session
$ openapi-snippet schema.yaml -e json -o dist/schema.json
```

## Outputting HTML docs (Redoc)

`-e html` renders a standalone [Redoc](https://github.com/Redocly/redoc) page
from the enriched spec. Redoc displays the injected `x-codeSamples` natively,
so the page shows the request/response docs alongside the code snippets:

```sh-session
$ openapi-snippet https://api.example.com/openapi.json -e html -o dist/docs.html
$ open dist/docs.html
```

The spec is inlined into the page, so it's self-contained except for the Redoc
bundle, which is loaded from a CDN at view time (the page needs network access
the first time it renders).

Add `--inline-redoc` to embed the Redoc bundle directly, producing a single
fully offline HTML file (no network needed to view it, at the cost of a larger
file):

```sh-session
$ openapi-snippet schema.yaml -e html --inline-redoc -o dist/docs.html
```

`--inline-redoc` reads the bundle from the optional [`redoc`](https://npmjs.com/package/redoc)
package, which is **not** installed by default. Install it alongside the CLI —
`npm i redoc`, `yarn add redoc`, or `pnpm add redoc` (add `-g`/`global` if you
installed the CLI globally). The lookup checks both the CLI's own install and
the current project, so a globally-installed CLI can use a project-local `redoc`.
If it's missing, the command exits with guidance instead of failing obscurely.

To serve one shared Redoc bundle across several generated pages, pass its public
URL instead of inlining or loading the default CDN asset:

```sh-session
$ openapi-snippet schema.yaml -e html --split-by-tag \
    --redoc-bundle-url /docs/assets/redoc.standalone.js -o dist/docs
```

`--redoc-bundle-url` and `--inline-redoc` are mutually exclusive.

## Choosing Targets
```sh-session
$ openapi-snippet schema.yaml \
    -t shell_curl -t python_requests -t javascript_fetch \
    -o dist/schema.yaml
```

This example emits cURL, Python Requests, and browser Fetch samples. Targets use
`<language>_<client>` names; for example, `javascript_xhr` selects
`XMLHttpRequest` while `javascript_fetch` selects the browser Fetch API.


## Discovering available targets

```sh-session
$ openapi-snippet --list-targets
c_libcurl
csharp_restsharp
go_native
java_okhttp
...
```

## Piping a spec on stdin

```sh-session
$ cat schema.yaml | openapi-snippet -o dist/schema.yaml
$ curl https://example.com/openapi.json | openapi-snippet --stdin -e json -o dist/schema.json
```

When no FILE is given and stdin is piped, the spec is read from stdin
automatically, so `--stdin` is optional — it's just an explicit signal of intent.

## Dry-run

```sh-session
$ openapi-snippet schema.yaml --dry-run -t shell_curl > /dev/null
```

Prints the resolved spec to stdout instead of writing the output file.

## Large specs (--chunk-size)

For specs with thousands of paths, `yaml.dump` on the entire enriched
document becomes the bottleneck. `--chunk-size N` processes N paths per
chunk and streams the YAML output, which is ~6-7x faster on big docs:

```sh-session
$ openapi-snippet big-api.yaml --chunk-size 100 -o dist/big-api.yaml
```

Empirically (8MB / 10000 paths / 40000 ops): 11.5s → 1.7s.
Default is 0 (no chunking; the legacy all-at-once behavior).

`--chunk-size` only speeds up **YAML** output. Splitting a JSON document
across chunks would produce invalid JSON, so `-e json` is always serialized
all at once; combining the two prints a warning and ignores the chunk size.

## Tolerating unprocessable operations (--skip-errors)

By default, a single operation the snippet generator can't handle (e.g. a
malformed parameter) aborts the whole run. `--skip-errors` leaves such
operations intact (without `x-codeSamples`), prints a warning to stderr, and
continues with the rest of the document:

```sh-session
$ openapi-snippet schema.yaml --skip-errors -o dist/schema.yaml
Skipped GET /bad: Required parameters missing
```

## Sample request values

The request bodies and URLs in the generated snippets are sampled from the
spec. Typed values are honored — numbers, booleans, enums, and `format`-annotated
strings (uuid, date-time, …) render as real values — and **path parameters are
substituted into the URL** (`/users/{id}` → `/users/<sample>`), not left as the
encoded placeholder `%7Bid%7D`. Author-provided `example`/`examples` (on the
media type, parameter, or schema) are always preferred over a generated sample.

A plain `string` field with no `format`/`enum`/`example` has nothing to sample,
so it renders as the literal `"string"`. `--smart-samples` fills those with a
value inferred from the field/parameter name instead:

```sh-session
$ openapi-snippet schema.yaml --smart-samples -o dist/schema.yaml
# "email": "user@example.com", "avatar_uri": "https://example.com",
# "..._id": "3fa85f64-...", "first_name": "John", ...
```

It only touches fields that would otherwise be `"string"`; everything the spec
already specifies is left untouched. Off by default.

## Splitting output per tag (--split-by-tag)

For large specs, a single document (especially an HTML page) gets unwieldy.
`--split-by-tag` treats `--output` as a **directory** and writes one file per
tag, in whichever format `-e` selects (yaml, json, or html):

```sh-session
$ openapi-snippet big-api.yaml -e html --split-by-tag -o dist/docs
$ open dist/docs/index.html
```

- An operation with several tags appears under **each** of its tags; operations
  with no tag go into `untagged.<ext>`.
- Each file's `components` are **pruned to the schemas that tag actually
  references** (transitively), so per-tag Redoc pages stay small instead of
  carrying the whole spec's schemas.
- With `-e html`, an `index.html` linking every per-tag page is also written.
- It can't be combined with `--dry-run` (it writes a folder, not stdout).

> **Note on Redoc assets when splitting:** `--inline-redoc` embeds the full
> ~1 MB bundle into every page and should be reserved for independently offline
> files. Prefer `--redoc-bundle-url` when the pages share a host, or omit both
> options to use the default CDN.

## Typed schema models (Zod / Valibot / Pydantic)

Alongside the HTTP-request targets (which run through `openapi-snippet`), three
**schema-codegen** targets emit typed *data models* from `components.schemas`:

| target | output |
|--------|--------|
| `typescript_zod` | Zod schemas + inferred types |
| `typescript_valibot` | Valibot schemas + inferred types |
| `python_pydantic` | Pydantic v2 models |

These are **opt-in** — a bare run (no `-t`) still emits only HTTP-request
samples. Request them explicitly:

```sh-session
$ openapi-snippet schema.yaml -t typescript_zod -e html -o dist/schema.html
```

Each operation gets a self-contained `x-codeSamples` entry that **inlines the
response model(s), issues the request, and parses the response through the
model** (`Pet.parse(...)` / `v.parse(Pet, ...)` / `Pet.model_validate(...)`), so
it renders in Redoc and is copy-paste runnable.

To also write **canonical, de-duplicated model files** (one module covering the
whole `components.schemas`), add `--schema-models-dir`:

```sh-session
$ openapi-snippet schema.yaml -t typescript_zod,python_pydantic \
    --schema-models-dir dist/models -o dist/schema.yaml
# writes dist/models/models.zod.ts and dist/models/models.py
```

The generated code references `zod` / `valibot` / `pydantic` — install whichever
you use in the consuming project. `--schema-models-dir` writes files, so it
can't be combined with `--dry-run`.

**Scope / notes (v1):** models are generated from named `components.schemas`
(an inline, non-`$ref` response schema is synthesized as a one-off model inside
its snippet). OpenAPI 3.0 quirks (`nullable`, boolean `exclusiveMinimum/Maximum`)
are normalized to 3.1 semantics. Pydantic is v2 only, and nested *inline* objects
fall back to `dict[str, Any]` rather than being hoisted to classes.

## MCP server (`openapi-mcp`)

The `openapi-mcp` CLI (the [`@npalladium/openapi-mcp`](packages/mcp) package)
runs a [Model Context Protocol](https://modelcontextprotocol.io) server over
stdio that lets an LLM explore a given OpenAPI spec. Inspired by
[swagger-json-mcp](https://github.com/LLM-MCP-Servers/swagger-json-mcp), adapted
to a single spec (passed as a file path or URL — stdin is reserved for the MCP
transport) and dereferenced so schemas come back resolved.

```sh-session
$ openapi-mcp https://api.example.com/openapi.json
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "openapi-snippet": {
      "command": "openapi-mcp",
      "args": ["https://api.example.com/openapi.json"]
    }
  }
}
```

Tools exposed:

| tool | parameters | description |
|------|------------|-------------|
| `get_overview` | – | title, version, and counts of paths/operations/schemas |
| `list_endpoints` | – | every operation as `{ method, path, operationId, summary }` |
| `get_endpoint` | `path`, `method` | the full operation object |
| `get_schema` | `name` | a named `components.schemas` entry |
| `search_endpoints` | `query`, `method?` | substring search over path/operationId/summary |
| `get_code_snippets` | `path`, `method`, `targets?` | request snippets for an operation (defaults to `shell_curl`) |
| `generate_models` | `target` | typed models from `components.schemas` (`typescript_zod`, `typescript_valibot`, `python_pydantic`) |
| `get_typed_snippet` | `path`, `method`, `target` | a self-contained typed request snippet (inline models + request + typed parse) |

## Exit codes

| code | meaning                          |
|------|----------------------------------|
| 0    | success                          |
| 1    | user error (bad flag, missing input, unknown --ext, no matching --targets) |
| 2    | internal/unexpected error        |
| 3    | network error (HTTP fetch failed)|

# Arguments
```
USAGE
  $ openapi-snippet [FILE]        # add snippets
  $ openapi-mcp [FILE]            # run the stdio MCP server (see above)

ARGUMENTS
  FILE  input openapi document. It will attempt to resolve references (including both internal and external ones)
```

# Options

```
OPTIONS
      --chunk-size=<value>   process N paths per chunk when serializing. 0 = process all at once (legacy behavior). Lower values are faster on large specs.
  -e, --ext=yaml|json|html    [default: yaml] output format (html = a standalone Redoc page)
      --dry-run               print the resolved spec to stdout instead of writing to --output
  -h, --help                  show CLI help
      --inline-redoc          with -e html, inline the Redoc bundle for a fully offline page (no CDN)
      --list-targets          print the list of valid --targets values and exit
  -o, --output=output         [default: output.yaml] output file name. Ignored when --dry-run.
      --schema-models-dir=dir also write canonical model files for schema targets in --targets (typescript_zod->models.zod.ts, typescript_valibot->models.valibot.ts, python_pydantic->models.py) into dir. Cannot be combined with --dry-run.
      --skip-errors           skip operations whose snippet generation fails (warn on stderr) instead of aborting
      --smart-samples         fill un-annotated string fields with realistic values inferred from their names (email->user@example.com, *_id->a uuid, ...) instead of "string"
      --split-by-tag          write a folder with one file per tag (--output is treated as a directory); components are pruned per tag, and -e html also emits an index.html
      --stdin                 read the spec from stdin (auto-detected when no FILE is given and stdin is piped)
  -t, --targets=targets       target snippet languages + frameworks. Can be provided multiple times. If inputting language only, defaults to one of the frameworks. HTTP-request targets come from https://github.com/ErikWittern/openapi-snippet; the schema targets (typescript_zod, typescript_valibot, python_pydantic) emit typed models and are opt-in. Defaults to ALL HTTP-request targets.
      --verbose               emit trace-level logging to stderr (equivalent to NODE_DEBUG=openapi-snippet)
  -v, --version               show CLI version
```

# Credits

This project builds on the work of:

- [richardkabiling/openapi-snippet-cli](https://github.com/richardkabiling/openapi-snippet-cli) — original CLI by [Richard Kabiling](https://github.com/richardkabiling)
- [ErikWittern/openapi-snippet](https://github.com/ErikWittern/openapi-snippet) — underlying snippet generation library by [Erik Wittern](https://github.com/ErikWittern)

Please report issues with this fork to [npalladium/openapi-snippet-cli](https://github.com/npalladium/openapi-snippet-cli/issues), not to the original projects.

# Copyright
- Portions Copyright - [Richard Kabiling](https://github.com/richardkabiling) ([richardkabiling/openapi-snippet-cli](https://github.com/richardkabiling/openapi-snippet-cli))
- Portions Copyright - [Erik Wittern](https://github.com/ErikWittern) ([ErikWittern/openapi-snippet](https://github.com/ErikWittern/openapi-snippet))
