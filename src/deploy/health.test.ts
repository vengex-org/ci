import { describe, expect, test } from "bun:test"
import { failureOf } from "../lib/failure-of"
import { checkHealth } from "./health"
import type { HttpFetch } from "./http-fetch"

const SHA = "4f2a9c1e0b7d4f2a9c1e0b7d4f2a9c1e0b7d4f2a"
const HEALTH_URL = "https://api.example.com/health"
const COMMIT_BODY = JSON.stringify({ status: "ok", commit: SHA })

type Answer = { status: number; body: string } | Error

/** Answers each request with the next entry and repeats the last one. */
function answers(...sequence: [Answer, ...Answer[]]) {
  const inits: RequestInit[] = []
  const sleeps: number[] = []
  let calls = 0
  const fetchImpl: HttpFetch = (_url, init) => {
    inits.push(init)
    const answer = sequence[Math.min(calls, sequence.length - 1)]
    calls += 1
    if (answer === undefined || answer instanceof Error) {
      return Promise.reject(answer ?? new Error("no answer defined"))
    }
    return Promise.resolve(new Response(answer.body, { status: answer.status }))
  }
  const deps = {
    fetch: fetchImpl,
    sleep: (ms: number) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
  }
  return { deps, inits, sleeps, calls: () => calls }
}

describe("checkHealth", () => {
  test("passes on the first 200 without waiting, ignoring the body when no commit is asked for", async () => {
    const { deps, sleeps, calls } = answers({ status: 200, body: "not json" })

    await checkHealth({ url: HEALTH_URL, commit: false, sha: SHA }, deps)

    expect(calls()).toBe(1)
    expect(sleeps).toEqual([])
  })

  test("bounds every request with a timeout signal", async () => {
    const { deps, inits } = answers({ status: 200, body: "" })

    await checkHealth({ url: HEALTH_URL, commit: false, sha: SHA }, deps)

    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  test("retries a 5xx every 6 seconds until it passes", async () => {
    const { deps, sleeps, calls } = answers(
      { status: 502, body: "" },
      { status: 503, body: "" },
      { status: 200, body: "" },
    )

    await checkHealth({ url: HEALTH_URL, commit: false, sha: SHA }, deps)

    expect(calls()).toBe(3)
    expect(sleeps).toEqual([6000, 6000])
  })

  test("retries when the request fails without an answer", async () => {
    const { deps, calls } = answers(new Error("ECONNRESET"), { status: 200, body: "" })

    await checkHealth({ url: HEALTH_URL, commit: false, sha: SHA }, deps)

    expect(calls()).toBe(2)
  })

  for (const status of [408, 429]) {
    test(`retries ${status} as a transient answer`, async () => {
      const { deps, calls } = answers({ status, body: "" }, { status: 200, body: "" })

      await checkHealth({ url: HEALTH_URL, commit: false, sha: SHA }, deps)

      expect(calls()).toBe(2)
    })
  }

  for (const status of [400, 401, 404]) {
    test(`fails at once on ${status}`, async () => {
      const { deps, sleeps, calls } = answers({ status, body: "" })

      expect(
        await failureOf(checkHealth({ url: HEALTH_URL, commit: false, sha: SHA }, deps)),
      ).toContain(`failed: HTTP ${status}`)
      expect(calls()).toBe(1)
      expect(sleeps).toEqual([])
    })
  }

  test("retries a non-200 success status", async () => {
    const { deps, calls } = answers({ status: 204, body: "" }, { status: 200, body: "" })

    await checkHealth({ url: HEALTH_URL, commit: false, sha: SHA }, deps)

    expect(calls()).toBe(2)
  })

  test("passes when the body names the commit", async () => {
    const { deps, calls } = answers({ status: 200, body: COMMIT_BODY })

    await checkHealth({ url: HEALTH_URL, commit: true, sha: SHA }, deps)

    expect(calls()).toBe(1)
  })

  test("keeps trying while the body names another commit", async () => {
    const { deps, calls } = answers(
      { status: 200, body: JSON.stringify({ commit: "0".repeat(40) }) },
      { status: 200, body: COMMIT_BODY },
    )

    await checkHealth({ url: HEALTH_URL, commit: true, sha: SHA }, deps)

    expect(calls()).toBe(2)
  })

  test("keeps trying while the body is not JSON", async () => {
    const { deps, calls } = answers(
      { status: 200, body: "<html>" },
      { status: 200, body: COMMIT_BODY },
    )

    await checkHealth({ url: HEALTH_URL, commit: true, sha: SHA }, deps)

    expect(calls()).toBe(2)
  })

  test("keeps trying while the JSON body has no commit field", async () => {
    const { deps, calls } = answers(
      { status: 200, body: JSON.stringify({ status: "ok" }) },
      { status: 200, body: COMMIT_BODY },
    )

    await checkHealth({ url: HEALTH_URL, commit: true, sha: SHA }, deps)

    expect(calls()).toBe(2)
  })

  test("gives up after 20 attempts and names the last answer", async () => {
    const { deps, sleeps, calls } = answers({ status: 503, body: "" })

    expect(
      await failureOf(checkHealth({ url: HEALTH_URL, commit: false, sha: SHA }, deps)),
    ).toContain("did not pass in 20 attempts, last: HTTP 503")
    expect(calls()).toBe(20)
    expect(sleeps).toHaveLength(19)
  })

  test("names the commit the service kept serving", async () => {
    const stale = "0".repeat(40)
    const { deps } = answers({ status: 200, body: JSON.stringify({ commit: stale }) })

    expect(
      await failureOf(checkHealth({ url: HEALTH_URL, commit: true, sha: SHA }, deps)),
    ).toContain(`serving commit ${stale}`)
  })

  test("keeps the network error of the last attempt as the cause", async () => {
    const reset = new Error("ECONNRESET")
    const { deps } = answers(reset)

    const error = await checkHealth({ url: HEALTH_URL, commit: false, sha: SHA }, deps).catch(
      (caught: unknown) => caught,
    )

    expect(error instanceof Error ? error.message : "").toContain("no answer")
    expect(error instanceof Error ? error.cause : undefined).toBe(reset)
  })
})
