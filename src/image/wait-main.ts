import { setTimeout as sleep } from "node:timers/promises"
import { z } from "zod"
import { minutes } from "../inputs/pipeline-inputs"
import { fail } from "../lib/fail"
import { waitForChecks } from "./wait-for-checks"

// Starting guess: the checks job runs for minutes, so 10 s keeps the API calls few.
const POLL_INTERVAL_MS = 10_000

const envSchema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPOSITORY: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  GITHUB_RUN_ID: z.string().regex(/^\d+$/),
  GITHUB_RUN_ATTEMPT: z.string().regex(/^\d+$/),
  WAIT_TIMEOUT_MINUTES: minutes,
})

try {
  const env = envSchema.parse(process.env)
  await waitForChecks(
    {
      repo: env.GITHUB_REPOSITORY,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      timeoutMs: env.WAIT_TIMEOUT_MINUTES * 60_000,
      pollIntervalMs: POLL_INTERVAL_MS,
    },
    { fetch, sleep: (ms) => sleep(ms), now: () => Date.now(), token: env.GITHUB_TOKEN },
  )
} catch (error) {
  fail(error)
}
