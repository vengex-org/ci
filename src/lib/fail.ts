import * as core from "@actions/core"

/**
 * Fails the step: logs the message of `error` and every cause behind it, then marks the run failed.
 * Causes are printed whole, so an error must never carry a token or a response body in `cause`.
 */
export function fail(error: unknown): void {
  let cause = causeOf(error)
  while (cause !== undefined) {
    core.error(`caused by: ${describe(cause)}`)
    cause = causeOf(cause)
  }
  core.setFailed(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return typeof cause === "string" ? cause : JSON.stringify(cause)
}
