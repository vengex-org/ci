import { z } from "zod"

export type WaitForChecksInput = {
  repo: string
  runId: string
  runAttempt: string
  timeoutMs: number
  pollIntervalMs: number
}

export type WaitForChecksDeps = {
  fetch: (
    url: string,
    init: { headers: Record<string, string> },
  ) => Promise<Pick<Response, "status" | "json">>
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Sent as `Bearer <token>`; never logged or put in an error. */
  token: string
}

/** The checks job of the reusable workflow; a caller's job name prefixes it as `<caller job> / <name>`. */
export const CHECKS_JOB_NAME = "pipeline-checks"

const JOBS_PER_PAGE = 100

const jobsSchema = z.object({
  total_count: z.number(),
  jobs: z.array(
    z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }),
  ),
})

type Job = z.infer<typeof jobsSchema>["jobs"][number]

/**
 * Resolves when the {@link CHECKS_JOB_NAME} job of this run attempt succeeded, so the image push
 * never races ahead of the checks.
 */
export async function waitForChecks(
  input: WaitForChecksInput,
  deps: WaitForChecksDeps,
): Promise<void> {
  const deadline = deps.now() + input.timeoutMs
  let lastState = "no response yet"
  for (;;) {
    const response = await deps.fetch(jobsUrl(input), {
      headers: {
        Authorization: `Bearer ${deps.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    if (response.status === 429 || response.status >= 500) {
      lastState = `GitHub API answered ${response.status}`
    } else if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub API answered ${response.status} for the jobs of run ${input.runId}`)
    } else {
      const { total_count, jobs } = jobsSchema.parse(await response.json())
      const checks = jobs.filter((job) => isChecksJob(job))
      if (checks.length > 1) {
        throw new Error(
          `more than one checks job in run ${input.runId}: ${checks.map((job) => job.name).join(", ")}`,
        )
      }
      const [job] = checks
      if (job === undefined) {
        if (total_count > jobs.length) {
          throw new Error(
            `run ${input.runId} has ${total_count} jobs, only the first ${JOBS_PER_PAGE} were read`,
          )
        }
        lastState = "no checks job yet"
      } else if (job.status === "completed") {
        if (job.conclusion === "success") return
        throw new Error(`checks job concluded ${job.conclusion ?? "without a conclusion"}`)
      } else {
        lastState = `checks job is ${job.status}`
      }
    }
    if (deps.now() >= deadline) {
      throw new Error(
        `timed out after ${input.timeoutMs} ms waiting for the checks job (${lastState})`,
      )
    }
    await deps.sleep(input.pollIntervalMs)
  }
}

function jobsUrl({ repo, runId, runAttempt }: WaitForChecksInput): string {
  return `https://api.github.com/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=${JOBS_PER_PAGE}`
}

function isChecksJob(job: Job): boolean {
  return job.name === CHECKS_JOB_NAME || job.name.endsWith(` / ${CHECKS_JOB_NAME}`)
}
