import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as core from "@actions/core"
import { z } from "zod"
import { fail } from "./fail"

afterEach(() => {
  process.exitCode = 0
})

/** Runs `fail` with the logger and the failure marker captured instead of written. */
function failing(error: unknown) {
  const errors: string[] = []
  const failures: string[] = []
  const logged = spyOn(core, "error").mockImplementation((message) => {
    errors.push(String(message))
  })
  const failed = spyOn(core, "setFailed").mockImplementation((message) => {
    failures.push(String(message))
  })
  fail(error)
  logged.mockRestore()
  failed.mockRestore()
  return { errors, failures }
}

describe("fail", () => {
  test("logs every cause of the chain, fails the step and sets the exit code", () => {
    const command = { command: ["git", "tag"], exitCode: 128, stderr: "fatal: no repo" }

    const { errors, failures } = failing(
      new Error("outer", { cause: new Error("middle", { cause: command }) }),
    )

    expect(failures).toEqual(["outer"])
    expect(errors).toEqual(["caused by: middle", `caused by: ${JSON.stringify(command)}`])
    expect(process.exitCode).toBe(1)
  })

  test("fails with the text of a value that is not an Error", () => {
    const { errors, failures } = failing("plain string")

    expect(failures).toEqual(["plain string"])
    expect(errors).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  test("names the failing field of an environment parse instead of printing issues as JSON", () => {
    const parsed = z.object({ COOLIFY_TOKEN: z.string().min(1) }).safeParse({ COOLIFY_TOKEN: "" })
    if (parsed.success) throw new Error("expected the empty token to be rejected")

    const { failures } = failing(parsed.error)

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("COOLIFY_TOKEN")
    expect(failures[0]?.startsWith("[")).toBe(false)
  })
})
