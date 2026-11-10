import { describe, expect, test } from "bun:test"
import { runCommand } from "./run-command"

describe("runCommand", () => {
  test("a failure keeps the exit code and stderr but no argument after the subcommand", async () => {
    const failure = await runCommand([
      process.execPath,
      "-e",
      "console.error('boom'); process.exit(3)",
      "POSTGRES_PASSWORD=secret",
    ]).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    const cause = failure instanceof Error ? failure.cause : undefined
    expect(cause).toEqual({ command: `${process.execPath} -e`, exitCode: 3, stderr: "boom" })
    expect(JSON.stringify(cause)).not.toContain("secret")
  })
})
