import { describe, expect, test } from "bun:test"
import { readTrigger } from "./trigger"

describe("readTrigger", () => {
  test("reads whether a pull request comes from this repository", () => {
    const base = { GITHUB_EVENT_NAME: "pull_request" }

    expect(readTrigger({ ...base, SAME_REPO: "true" })).toEqual({
      event: "pull_request",
      sameRepo: true,
    })
    expect(readTrigger({ ...base, SAME_REPO: "false" })).toEqual({
      event: "pull_request",
      sameRepo: false,
    })
  })

  test("reads the ref of a push", () => {
    expect(readTrigger({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" })).toEqual({
      event: "push",
      ref: "refs/heads/master",
    })
  })

  test("reads the ref and environment of a dispatch", () => {
    expect(
      readTrigger({
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/master",
        DISPATCH_ENVIRONMENT: "production",
      }),
    ).toEqual({ event: "workflow_dispatch", ref: "refs/heads/master", environment: "production" })
  })

  test("rejects a dispatch without an environment", () => {
    const env = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master" }

    expect(() => readTrigger(env)).toThrow("environment variable DISPATCH_ENVIRONMENT is not set")
  })

  test("rejects an event the pipeline does not handle", () => {
    expect(() => readTrigger({ GITHUB_EVENT_NAME: "schedule" })).toThrow(
      "unsupported event schedule",
    )
  })

  test("rejects a missing event", () => {
    expect(() => readTrigger({})).toThrow("GITHUB_EVENT_NAME is not set")
  })
})
