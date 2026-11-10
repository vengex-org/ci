import { describe, expect, test } from "bun:test"
import { buildExcludeTags, parseDeployedTags } from "./exclude-tags"

const shaA = "a".repeat(40)
const shaB = "b".repeat(40)
const shaC = "c".repeat(40)

/** How the action reads a wildcard `exclude-tags` list: `*` matches any run of characters. */
function matches(list: string, tag: string) {
  return list.split(",").some((pattern) => {
    const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
    return new RegExp(`^${source}$`).test(tag)
  })
}

describe("buildExcludeTags", () => {
  const regex = buildExcludeTags([
    { environment: "staging", app: "web", sha: shaA },
    { environment: "production", app: "web", sha: shaB },
  ])

  test("keeps the tags of every deployed commit", () => {
    expect(matches(regex, `staging-${shaA}`)).toBe(true)
    expect(matches(regex, `production-${shaB}`)).toBe(true)
  })

  test("keeps buildcache tags and the legacy tags", () => {
    for (const tag of ["buildcache-staging", "buildcache-", "staging", "production", "latest"]) {
      expect(matches(regex, tag)).toBe(true)
    }
  })

  test("does not keep other tags", () => {
    for (const tag of [
      `staging-${shaB}`,
      `production-${shaA}`,
      `staging-${shaC}`,
      `xstaging-${shaA}`,
      `staging-${shaA}x`,
      "stagingx",
      "my-buildcache-x",
      "stage",
      "",
    ]) {
      expect(matches(regex, tag)).toBe(false)
    }
  })

  test("matches environment and sha literally", () => {
    const literal = buildExcludeTags([{ environment: "a.c", app: "web", sha: shaA }])
    expect(matches(literal, `a.c-${shaA}`)).toBe(true)
    expect(matches(literal, `abc-${shaA}`)).toBe(false)
  })

  test("lists a tag shared by two apps once", () => {
    const shared = buildExcludeTags([
      { environment: "staging", app: "web", sha: shaA },
      { environment: "staging", app: "server", sha: shaA },
    ])
    expect(shared.split(",").filter((tag) => tag === `staging-${shaA}`)).toHaveLength(1)
  })

  test("throws when nothing is deployed", () => {
    expect(() => buildExcludeTags([])).toThrow("no deployed tags found")
  })
})

describe("parseDeployedTags", () => {
  test("parses environment, app and sha", () => {
    const output = `${shaA}\trefs/tags/deployed/staging/web\n${shaB}\trefs/tags/deployed/production/server\n`
    expect(parseDeployedTags(output)).toEqual([
      { environment: "staging", app: "web", sha: shaA },
      { environment: "production", app: "server", sha: shaB },
    ])
  })

  test("returns nothing for empty output", () => {
    expect(parseDeployedTags("")).toEqual([])
    expect(parseDeployedTags("\n\n")).toEqual([])
  })

  test("skips tags of the legacy deployed/<app> layout", () => {
    expect(parseDeployedTags(`${shaA}\trefs/tags/deployed/web\n`)).toEqual([])
  })

  test("throws on a line that is not '<sha>\\t<ref>'", () => {
    for (const line of [
      "garbage",
      `${shaA} refs/tags/deployed/staging/web`,
      `nothex\trefs/tags/deployed/staging/web`,
      `${shaA}\trefs/tags/deployed/staging/web\textra`,
    ]) {
      expect(() => parseDeployedTags(line)).toThrow("unexpected deployed tag line")
    }
  })

  test("keeps a __proto__ app as plain data", () => {
    expect(parseDeployedTags(`${shaA}\trefs/tags/deployed/staging/__proto__\n`)).toEqual([
      { environment: "staging", app: "__proto__", sha: shaA },
    ])
  })
})
