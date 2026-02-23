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

## From npm

```sh-session
$ npm install -g openapi-snippet-cli  # original
```

## From Source

```sh-session
$ git clone https://github.com/npalladium/openapi-snippet-cli.git
$ cd openapi-snippet-cli
$ npm install
```

Then run directly without a build step:

```sh-session
$ node bin/run schema.yaml -o dist/schema.yaml
```

Or link globally to use the `openapi-snippet` command anywhere:

```sh-session
$ npm link
$ openapi-snippet schema.yaml -o dist/schema.yaml
```

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
  -e, --ext=yaml|json    [default: yaml] output format
  -h, --help             show CLI help
  -o, --output=output    [default: output.yaml] output file name

  -t, --targets=targets  target snippet languages + frameworks. Can be provided multiple times. If inputting language only, defaults to one of the frameworks. Supports
                         languages supported in https://github.com/ErikWittern/openapi-snippet. Defaults to adding snippets for ALL supported languages.

  -v, --version          show CLI version
```

# Credits

This project builds on the work of:

- [richardkabiling/openapi-snippet-cli](https://github.com/richardkabiling/openapi-snippet-cli) — original CLI by [Richard Kabiling](https://github.com/richardkabiling)
- [ErikWittern/openapi-snippet](https://github.com/ErikWittern/openapi-snippet) — underlying snippet generation library by [Erik Wittern](https://github.com/ErikWittern)

Please report issues with this fork to [npalladium/openapi-snippet-cli](https://github.com/npalladium/openapi-snippet-cli/issues), not to the original projects.

# Copyright
- Portions Copyright - [Richard Kabiling](https://github.com/richardkabiling) ([richardkabiling/openapi-snippet-cli](https://github.com/richardkabiling/openapi-snippet-cli))
- Portions Copyright - [Erik Wittern](https://github.com/ErikWittern) ([ErikWittern/openapi-snippet](https://github.com/ErikWittern/openapi-snippet))
