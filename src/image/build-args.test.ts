import { describe, expect, test } from "bun:test"
import { readBunVersion, resolveBuildArgs } from "./build-args"

const sha = "a".repeat(40)

function resolve(buildArgs: Record<string, string>, vars: Record<string, string> = {}) {
  return resolveBuildArgs({
    leg: { environment: "staging", buildArgs },
    vars,
    sha,
    bunVersion: "1.4.4",
  })
}

describe("resolveBuildArgs", () => {
  test("sets the built-in args when the leg has none", () => {
    expect(resolve({})).toBe(`BUN_VERSION=1.4.4\nENVIRONMENT=staging\nGIT_COMMIT=${sha}`)
  })

  test("substitutes named vars inside a value", () => {
    const rendered = resolve(
      { VITE_URL: "https://${vars.HOST}/api/${vars.VERSION}" },
      { HOST: "staging.example.com", VERSION: "v1" },
    )
    expect(rendered.split("\n")).toContain("VITE_URL=https://staging.example.com/api/v1")
  })

  test("keeps a literal value without placeholders", () => {
    expect(resolve({ FLAG: "on" }).split("\n")).toContain("FLAG=on")
  })

  test("accepts an empty var value", () => {
    expect(resolve({ KEY: "${vars.EMPTY}" }, { EMPTY: "" }).split("\n")).toContain("KEY=")
  })

  test("does not re-expand a placeholder inside a var value", () => {
    const rendered = resolve({ KEY: "${vars.A}" }, { A: "${vars.B}", B: "x" })
    expect(rendered.split("\n")).toContain("KEY=${vars.B}")
  })

  test("throws naming the missing var and the build arg", () => {
    expect(() => resolve({ VITE_URL: "${vars.NOPE}" })).toThrow(
      "build arg VITE_URL uses missing repository variable NOPE",
    )
  })

  test("throws for var names an object would answer from its prototype", () => {
    expect(() => resolve({ KEY: "${vars.__PROTO__}" })).toThrow(
      "missing repository variable __PROTO__",
    )
    expect(() => resolve({ KEY: "${vars.CONSTRUCTOR}" })).toThrow("CONSTRUCTOR")
  })

  test("throws on a placeholder that is not ${vars.NAME}", () => {
    for (const value of ["${secrets.TOKEN}", "${vars.lower}", "${vars.}", "${HOME}", "a${"]) {
      expect(() => resolve({ KEY: value }, { lower: "x" })).toThrow("other than")
    }
  })

  test("throws when a leg build arg is named like a built-in", () => {
    for (const name of ["BUN_VERSION", "ENVIRONMENT", "GIT_COMMIT"]) {
      expect(() => resolve({ [name]: "x" })).toThrow(`build arg ${name} is set by the pipeline`)
    }
  })

  test("throws when a resolved value contains a newline", () => {
    expect(() => resolve({ KEY: "${vars.A}" }, { A: "one\ntwo" })).toThrow("multi-line")
    expect(() => resolve({ KEY: "${vars.A}" }, { A: "one\rtwo" })).toThrow("multi-line")
  })

  test("throws when a built-in value contains a newline", () => {
    expect(() =>
      resolveBuildArgs({
        leg: { environment: "a\nB=c", buildArgs: {} },
        vars: {},
        sha,
        bunVersion: "1.4.4",
      }),
    ).toThrow("ENVIRONMENT")
  })
})

describe("readBunVersion", () => {
  test("reads the version from packageManager", () => {
    expect(readBunVersion({ packageManager: "bun@1.4.4" })).toBe("1.4.4")
  })

  test("throws when packageManager is absent", () => {
    expect(() => readBunVersion({})).toThrow("packageManager must be bun@")
  })

  test("throws for another package manager, a range or an empty version", () => {
    for (const packageManager of ["npm@10.0.0", "bun@", "bun@^1.4", "bun@1.4.4\n", ""]) {
      expect(() => readBunVersion({ packageManager })).toThrow("packageManager must be bun@")
    }
  })

  test("throws for input that is not an object", () => {
    expect(() => readBunVersion(null)).toThrow("packageManager must be bun@")
  })
})
