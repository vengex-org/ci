import { z } from "zod"
import type { HttpFetch } from "./http-fetch"

// Measured in platform's deploy workflow: Coolify reports `finished` before its proxy routes to the
// new container, and 20 attempts 6 s apart covered that gap on every deploy so far.
const MAX_ATTEMPTS = 20
const INTERVAL_MS = 6000
// The workflow's curl `--max-time`: one stuck request must not eat the attempts after it.
const REQUEST_TIMEOUT_MS = 10_000

const commitBodySchema = z.object({ commit: z.string() })

type Failure = { permanent: boolean; reason: string; cause?: unknown }
type Probe = { passed: true } | ({ passed: false } & Failure)

/**
 * Waits until `url` answers 200, and with `commit` set until its JSON body names `sha`: Coolify's
 * `finished` means the container is healthy, not that the proxy already routes to it.
 * No answer, 5xx, 408, 429 and a wrong or unreadable body are retried; any other 4xx will not
 * change by waiting and fails at once.
 */
export async function checkHealth(
  input: { url: string; commit: boolean; sha: string },
  deps: { fetch: HttpFetch; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  let last: Failure = { permanent: false, reason: "not attempted" }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await probe(input, deps.fetch)
    if (result.passed) return
    last = result
    if (last.permanent) {
      throw new Error(`${input.url} failed: ${last.reason}`, { cause: last.cause })
    }
    if (attempt < MAX_ATTEMPTS) await deps.sleep(INTERVAL_MS)
  }

  throw new Error(`${input.url} did not pass in ${MAX_ATTEMPTS} attempts, last: ${last.reason}`, {
    cause: last.cause,
  })
}

async function probe(
  input: { url: string; commit: boolean; sha: string },
  fetch: HttpFetch,
): Promise<Probe> {
  let status: number
  let body: string
  try {
    const response = await fetch(input.url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    status = response.status
    body = await response.text()
  } catch (error) {
    return { passed: false, permanent: false, reason: "no answer", cause: error }
  }

  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { passed: false, permanent: true, reason: `HTTP ${status}` }
  }
  if (status !== 200) return { passed: false, permanent: false, reason: `HTTP ${status}` }
  if (!input.commit) return { passed: true }

  const commit = readCommit(body)
  if (commit === undefined) {
    return { passed: false, permanent: false, reason: "body has no commit field" }
  }
  if (commit !== input.sha) {
    return { passed: false, permanent: false, reason: `serving commit ${commit.slice(0, 40)}` }
  }
  return { passed: true }
}

function readCommit(body: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const result = commitBodySchema.safeParse(parsed)
  return result.success ? result.data.commit : undefined
}
