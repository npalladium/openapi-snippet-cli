import assert from 'node:assert/strict'
import { CliError, loadRedocBundle } from '../src/cli/index.ts'

describe('loadRedocBundle (optional, multi-location)', () => {
  it('returns the bundle from the first resolver that succeeds', () => {
    const out = loadRedocBundle([() => '/from/cli/redoc.standalone.js'], (p) => `BUNDLE@${p}`)
    assert.equal(out, 'BUNDLE@/from/cli/redoc.standalone.js')
  })

  it('falls through to the next resolver when one cannot resolve redoc', () => {
    const out = loadRedocBundle(
      [
        () => {
          throw new Error('Cannot find module (CLI location)')
        },
        () => '/from/cwd/redoc.standalone.js',
      ],
      (p) => `BUNDLE@${p}`,
    )
    assert.equal(out, 'BUNDLE@/from/cwd/redoc.standalone.js')
  })

  it('throws a CliError with cross-manager install guidance when redoc is absent', () => {
    assert.throws(
      () =>
        loadRedocBundle([
          () => {
            throw new Error('not found')
          },
        ]),
      (err: unknown) => {
        assert.ok(err instanceof CliError)
        assert.equal(err.exitCode, 1)
        assert.match(err.message, /npm i redoc/)
        assert.match(err.message, /yarn add redoc/)
        assert.match(err.message, /pnpm add redoc/)
        assert.match(err.message, /global/i)
        return true
      },
    )
  })

  it('resolves the real redoc bundle from the CLI location (it is installed here)', () => {
    // The default resolvers include this package's own require; redoc is an
    // optional dependency installed in the workspace, so this must succeed.
    const bundle = loadRedocBundle()
    assert.ok(bundle.length > 100_000, 'expected the real standalone bundle')
  })
})
