openapi-snippet-cli
===================

Adds openapi snippets using `openapi-snippet` module in redoc style (x-codeSamples). This is a CLI wrapper on [openapi-snippet](https://github.com/ErikWittern/openapi-snippet).

> **Note:** This is a maintained fork of [richardkabiling/openapi-snippet-cli](https://github.com/richardkabiling/openapi-snippet-cli), which is itself a CLI wrapper on [ErikWittern/openapi-snippet](https://github.com/ErikWittern/openapi-snippet). This fork rewrites the project in TypeScript ESM, fixes bugs, and keeps dependencies up to date. Please file issues at [npalladium/openapi-snippet-cli](https://github.com/npalladium/openapi-snippet-cli/issues), not on the original repositories.

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/openapi-snippet-cli.svg)](https://npmjs.org/package/openapi-snippet-cli)
[![Downloads/week](https://img.shields.io/npm/dw/openapi-snippet-cli.svg)](https://npmjs.org/package/openapi-snippet-cli)
[![License](https://img.shields.io/npm/l/openapi-snippet-cli.svg)](https://github.com/richardkabiling/openapi-snippet-cli/blob/master/package.json)

* [Getting Started](#getting-started)
* [Usage](#usage)
* [Arguments](#arguments)
* [Options](#options)

# Getting Started

## Requirements

- Node.js **22** (active LTS) or **24** (latest LTS). Older Node versions are not supported.
- pnpm 9+.

## From npm

```sh-session
$ npm install -g openapi-snippet-cli  # original
```

## From Source

```sh-session
$ git clone https://github.com/npalladium/openapi-snippet-cli.git
$ cd openapi-snippet-cli
$ pnpm install
```

### Dev (run from source)

```sh-session
$ pnpm dev -- schema.yaml -o dist/schema.yaml
```

`pnpm dev` runs the TypeScript source directly through `tsx` — no build step
required. Edit a file, rerun.

### Build (production)

```sh-session
$ pnpm build      # produces dist/ via esbuild + tsc
$ node bin/run schema.yaml -o dist/schema.yaml
```

Or link globally to use the `openapi-snippet` command anywhere:

```sh-session
$ pnpm build
$ pnpm link --global
$ openapi-snippet schema.yaml -o dist/schema.yaml
```

## Build Pipeline

- `pnpm typecheck` — runs the **native** TypeScript compiler (`tsgo`) for fast type-checking.
- `pnpm build:types` — emits `.d.ts` files via `tsc --emitDeclarationOnly`.
- `pnpm build:js` — bundles the CLI entrypoint with **esbuild** (single ESM output, external packages).
- `pnpm build` — runs both `build:types` and `build:js`.
- `pnpm dev` — runs the CLI from source via `tsx` (no build).
- `pnpm test:watch` — runs the mocha test suite in watch mode (uses `tsx`).

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

oclif auto-fills the FILE argument from stdin when stdin is piped, so
`--stdin` is optional. The flag is a no-op signal of intent.

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
  $ openapi-snippet [FILE]

ARGUMENTS
  FILE  input openapi document. It will attempt to resolve references (including both internal adn external ones)
```

# Options

```
OPTIONS
      --chunk-size=<value>   process N paths per chunk when serializing. 0 = process all at once (legacy behavior). Lower values are faster on large specs.
  -e, --ext=yaml|json         [default: yaml] output format
      --dry-run               print the resolved spec to stdout instead of writing to --output
  -h, --help                  show CLI help
      --list-targets          print the list of valid --targets values and exit
  -o, --output=output         [default: output.yaml] output file name. Ignored when --dry-run.
      --stdin                 read the spec from stdin (also: oclif auto-fills FILE from stdin)
  -t, --targets=targets       target snippet languages + frameworks. Can be provided multiple times. If inputting language only, defaults to one of the frameworks. Supports languages supported in https://github.com/ErikWittern/openapi-snippet. Defaults to adding snippets for ALL supported languages.
      --verbose               accepted for compat; set NODE_DEBUG=openapi-snippet for trace logging
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
