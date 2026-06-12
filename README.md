openapi-snippet-cli
===================

Adds openapi snippets using `openapi-snippet` module in redoc style (x-codeSamples). This is a CLI wrapper on [openapi-snippet](https://github.com/ErikWittern/openapi-snippet).

> **Note:** This is a maintained fork of [richardkabiling/openapi-snippet-cli](https://github.com/richardkabiling/openapi-snippet-cli), which is itself a CLI wrapper on [ErikWittern/openapi-snippet](https://github.com/ErikWittern/openapi-snippet). This fork rewrites the project in TypeScript ESM, fixes bugs, and keeps dependencies up to date. Please file issues at [npalladium/openapi-snippet-cli](https://github.com/npalladium/openapi-snippet-cli/issues), not on the original repositories.

[![stricli](https://img.shields.io/badge/cli-stricli-brightgreen.svg)](https://bloomberg.github.io/stricli/)
[![Version](https://img.shields.io/npm/v/openapi-snippet-cli.svg)](https://npmjs.org/package/openapi-snippet-cli)
[![Downloads/week](https://img.shields.io/npm/dw/openapi-snippet-cli.svg)](https://npmjs.org/package/openapi-snippet-cli)
[![License](https://img.shields.io/npm/l/openapi-snippet-cli.svg)](https://github.com/npalladium/openapi-snippet-cli/blob/main/LICENSE)

* [Getting Started](#getting-started)
* [Usage](#usage)
* [Arguments](#arguments)
* [Options](#options)

# Getting Started

## Requirements

- Node.js **22** (active LTS) or **24** (latest LTS). Older Node versions are not supported.
- pnpm 9+.

## Packages

This is a pnpm monorepo with three packages:

| package | bin | purpose |
|---------|-----|---------|
| [`@openapi-snippet/core`](packages/core) | – | shared library: snippet generation, injection, spec loading, HTML rendering |
| [`openapi-snippet-cli`](packages/cli) | `openapi-snippet` | the snippet CLI (yaml/json/html output) |
| [`openapi-snippet-mcp`](packages/mcp) | `openapi-snippet-mcp` | stdio MCP server for exploring a spec |

## From npm

```sh-session
$ npm install -g openapi-snippet-cli      # the `openapi-snippet` command
$ npm install -g openapi-snippet-mcp      # the `openapi-snippet-mcp` command
```

The two CLIs are independent: installing the snippet CLI does not pull the MCP
SDK, and installing the MCP CLI does not pull redoc.

## From Source

```sh-session
$ git clone https://github.com/npalladium/openapi-snippet-cli.git
$ cd openapi-snippet-cli
$ pnpm install
$ pnpm build      # builds core, then the two CLIs (topological order)
```

### Dev (run from source)

```sh-session
$ pnpm --filter openapi-snippet-cli dev -- schema.yaml -o dist/schema.yaml
```

`dev` runs the TypeScript source directly through `tsx` — no build step
required. Edit a file, rerun.

### Run the built binaries

```sh-session
$ node packages/cli/dist/main.js schema.yaml -o dist/schema.yaml
$ node packages/mcp/dist/main.js schema.yaml
```

Or link a package globally to use its command anywhere:

```sh-session
$ pnpm --filter openapi-snippet-cli build
$ cd packages/cli && pnpm link --global
$ openapi-snippet schema.yaml -o dist/schema.yaml
```

## Build Pipeline

Run from the repo root; scripts fan out to the packages with `pnpm -r`:

- `pnpm typecheck` — type-checks every package with `tsc --noEmit`.
- `pnpm build` — builds every package (topological): `@openapi-snippet/core`
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

## Choosing Targets
```sh-session
$ openapi-snippet schema.yaml -t java -t c -o dist/schema.json
```

The example above should add snippets for `java` and `c` using their default frameworks

```sh-session
$ openapi-snippet schema.yaml -t java_okhttp -o dist/schema.json
```

This should add snippets for 'java` using OkHttp.

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

## MCP server (`openapi-snippet-mcp`)

The `openapi-snippet-mcp` CLI (the [`openapi-snippet-mcp`](packages/mcp) package)
runs a [Model Context Protocol](https://modelcontextprotocol.io) server over
stdio that lets an LLM explore a given OpenAPI spec. Inspired by
[swagger-json-mcp](https://github.com/LLM-MCP-Servers/swagger-json-mcp), adapted
to a single spec (passed as a file path or URL — stdin is reserved for the MCP
transport) and dereferenced so schemas come back resolved.

```sh-session
$ openapi-snippet-mcp https://api.example.com/openapi.json
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "openapi-snippet": {
      "command": "openapi-snippet-mcp",
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
  $ openapi-snippet-mcp [FILE]    # run the stdio MCP server (see above)

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
      --skip-errors           skip operations whose snippet generation fails (warn on stderr) instead of aborting
      --stdin                 read the spec from stdin (auto-detected when no FILE is given and stdin is piped)
  -t, --targets=targets       target snippet languages + frameworks. Can be provided multiple times. If inputting language only, defaults to one of the frameworks. Supports languages supported in https://github.com/ErikWittern/openapi-snippet. Defaults to adding snippets for ALL supported languages.
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
