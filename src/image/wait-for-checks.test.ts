import { describe, expect, test } from "bun:test"
import { failureOf } from "../lib/failure-of"
import { type WaitForChecksDeps, type WaitForChecksInput, waitForChecks } from "./wait-for-checks"

const input: WaitForChecksInput = {
  repo: "vengex-org/axman",
  runId: "42",
  runAttempt: "2",
  timeoutMs: 1000,
  pollIntervalMs: 100,
}

type Reply = { status: number; body?: unknown }
type Job = { name: string; status: string; conclusion: string | null }

function jobsReply(jobs: Job[], totalCount = jobs.length): Reply {
  return { status: 200, body: { total_count: totalCount, jobs } }
}

const done = (name: string, conclusion: string | null): Job => ({
  name,
  status: "completed",
  conclusion,
})

function harness(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  let clock = 0
  let polled = 0
  const deps: WaitForChecksDeps = {
    token: "secret-token",
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers })
      const reply = replies[Math.min(polled, replies.length - 1)]
      polled += 1
      if (reply === undefined) throw new Error("no reply configured")
      return { status: reply.status, json: async () => reply.body }
    },
  }
  return { deps, calls }
}

describe("waitForChecks", () => {
  test("resolves when the checks job succeeded and asks for this run attempt with the token", async () => {
    const { deps, calls } = harness([jobsReply([done("checks", "success")])])
    await waitForChecks(input, deps)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/vengex-org/axman/actions/runs/42/attempts/2/jobs?per_page=100",
    )
    expect(calls[0]?.headers.Authorization).toBe("Bearer secret-token")
  })

  test("matches a reusable workflow job named '<caller job> / checks'", async () => {
    const { deps } = harness([
      jobsReply([done("pipeline / plan", "success"), done("pipeline / checks", "success")]),
    ])
    await waitForChecks(input, deps)
  })

  test("ignores jobs that only contain the word checks", async () => {
    const { deps } = harness([
      jobsReply([done("prechecks", "failure"), done("a / precheck", "failure")], 2),
      jobsReply([done("prechecks", "failure"), done("checks", "success")]),
    ])
    await waitForChecks(input, deps)
  })

  test("keeps polling while the checks job is in progress", async () => {
    const { deps, calls } = harness([
      jobsReply([{ name: "checks", status: "in_progress", conclusion: null }]),
      jobsReply([{ name: "checks", status: "queued", conclusion: null }]),
      jobsReply([done("checks", "success")]),
    ])
    await waitForChecks(input, deps)
    expect(calls).toHaveLength(3)
  })

  test("keeps polling while the checks job does not exist yet", async () => {
    const { deps, calls } = harness([jobsReply([]), jobsReply([done("checks", "success")])])
    await waitForChecks(input, deps)
    expect(calls).toHaveLength(2)
  })

  for (const conclusion of [
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "neutral",
    "stale",
  ]) {
    test(`throws naming the conclusion ${conclusion}`, async () => {
      const { deps } = harness([jobsReply([done("checks", conclusion)])])
      expect(await failureOf(waitForChecks(input, deps))).toContain(`concluded ${conclusion}`)
    })
  }

  test("throws when a completed checks job has no conclusion", async () => {
    const { deps } = harness([jobsReply([done("checks", null)])])
    expect(await failureOf(waitForChecks(input, deps))).toContain("without a conclusion")
  })

  test("throws when more than one job matches", async () => {
    const { deps } = harness([
      jobsReply([done("a / checks", "success"), done("b / checks", "success")]),
    ])
    expect(await failureOf(waitForChecks(input, deps))).toContain("more than one checks job")
  })

  test("throws when the checks job is not among the first 100 jobs", async () => {
    const { deps } = harness([jobsReply([done("build", "success")], 150)])
    expect(await failureOf(waitForChecks(input, deps))).toContain("150 jobs")
  })

  test("throws on timeout and names what it was waiting for", async () => {
    const { deps, calls } = harness([
      jobsReply([{ name: "checks", status: "in_progress", conclusion: null }]),
    ])
    expect(await failureOf(waitForChecks(input, deps))).toContain(
      "timed out after 1000 ms waiting for the checks job (checks job is in_progress)",
    )
    expect(calls).toHaveLength(11)
  })

  test("retries 5xx and 429 responses", async () => {
    const { deps, calls } = harness([
      { status: 502 },
      { status: 429 },
      jobsReply([done("checks", "success")]),
    ])
    await waitForChecks(input, deps)
    expect(calls).toHaveLength(3)
  })

  test("times out when the API keeps failing with 5xx", async () => {
    const { deps } = harness([{ status: 503 }])
    expect(await failureOf(waitForChecks(input, deps))).toContain("GitHub API answered 503")
  })

  for (const status of [401, 403, 404, 422]) {
    test(`fails fast on ${status}`, async () => {
      const { deps, calls } = harness([{ status }, jobsReply([done("checks", "success")])])
      expect(await failureOf(waitForChecks(input, deps))).toContain(`answered ${status}`)
      expect(calls).toHaveLength(1)
    })
  }

  test("never puts the token in an error", async () => {
    const { deps } = harness([{ status: 401 }])
    expect(await failureOf(waitForChecks(input, deps))).not.toContain("secret-token")
  })

  test("rejects a response that is not a jobs list", async () => {
    const { deps } = harness([{ status: 200, body: { jobs: "nope" } }])
    expect(await failureOf(waitForChecks(input, deps))).toContain("expected")
  })
})
