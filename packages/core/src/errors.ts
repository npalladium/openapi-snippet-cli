/** Exit codes per the project convention. */
export const ExitCode = {
  OK: 0,
  USER_ERROR: 1,
  INTERNAL_ERROR: 2,
  NETWORK_ERROR: 3,
} as const

/** Error carrying the exit code the CLI should terminate with. */
export class CliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}
