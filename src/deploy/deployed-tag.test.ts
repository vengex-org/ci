import { describe, expect, test } from "bun:test"
import { failureOf } from "../lib/failure-of"
import { moveDeployedTag } from "./deployed-tag"
import type { HttpFetch } from "./http-fetch"

const SHA = "4f2a9c1e0b7d4f2a9c1e0b7d4f2a9c1e0b7d4f2a"
const TOKEN = "gh-secret-token"
const INPUT = {
  repo: "vengex-org/platform",
  environment: "staging",
  app: "api",
  sha: SHA,
  token: TOKEN,
}

type Call = { method: string; url: string; init: RequestInit }

/** Answers each request with the next response in the sequence. */
function github(...sequence: [Response, ...Response[]]) {
  const calls: Call[] = []
  const fetchImpl: HttpFetch = (url, init) => {
    const response = sequence[calls.length]
    calls.push({ method: init.method ?? "GET", url, init })
    return Promise.resolve(response ?? new Response("unexpected call", { status: 599 }))
  }
  return { calls, fetchImpl }
}

const ok = () => Response.json({})
const missing = () => Response.json({ message: "Not Found" }, { status: 404 })

describe("moveDeployedTag", () => {
  test("force-updates the existing tag and creates nothing", async () => {
    const { calls, fetchImpl } = github(ok())

    await moveDeployedTag(INPUT, fetchImpl)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("PATCH")
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/vengex-org/platform/git/refs/tags/deployed/staging/api",
    )
    expect(calls[0]?.init.body).toBe(JSON.stringify({ sha: SHA, force: true }))
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`)
  })

  test("creates the tag when the update finds none (404)", async () => {
    const { calls, fetchImpl } = github(missing(), ok())

    await moveDeployedTag(INPUT, fetchImpl)

    expect(calls.map((call) => call.method)).toEqual(["PATCH", "POST"])
    expect(calls[1]?.url).toBe("https://api.github.com/repos/vengex-org/platform/git/refs")
    expect(calls[1]?.init.body).toBe(
      JSON.stringify({ ref: "refs/tags/deployed/staging/api", sha: SHA }),
    )
  })

  test("creates the tag when the update answers 422 Reference does not exist", async () => {
    const { calls, fetchImpl } = github(
      Response.json({ message: "Reference does not exist" }, { status: 422 }),
      ok(),
    )

    await moveDeployedTag(INPUT, fetchImpl)

    expect(calls.map((call) => call.method)).toEqual(["PATCH", "POST"])
  })

  test("fails on a 422 that is not a missing tag, creating nothing", async () => {
    const { calls, fetchImpl } = github(
      Response.json({ message: "Object does not exist" }, { status: 422 }),
    )

    expect(await failureOf(moveDeployedTag(INPUT, fetchImpl))).toContain("answered 422 to PATCH")
    expect(calls).toHaveLength(1)
  })

  test("fails on a 422 whose body is not JSON", async () => {
    const { fetchImpl } = github(new Response("<html>", { status: 422 }))

    expect(await failureOf(moveDeployedTag(INPUT, fetchImpl))).toContain("answered 422 to PATCH")
  })

  test("fails on a server error without creating the tag", async () => {
    const { calls, fetchImpl } = github(new Response("boom", { status: 500 }))

    expect(await failureOf(moveDeployedTag(INPUT, fetchImpl))).toContain("answered 500 to PATCH")
    expect(calls).toHaveLength(1)
  })

  test("fails when the tag cannot be created, keeping status and path, not the body, in the cause", async () => {
    const { fetchImpl } = github(
      missing(),
      Response.json({ message: "Reference already exists" }, { status: 422 }),
    )

    const error = await moveDeployedTag(INPUT, fetchImpl).catch((caught: unknown) => caught)

    expect(error instanceof Error ? error.message : "").toBe(
      "github answered 422 to POST of the deployed tag",
    )
    expect(error instanceof Error ? error.cause : undefined).toEqual({
      status: 422,
      path: "/repos/vengex-org/platform/git/refs",
    })
  })
})
