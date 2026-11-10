import { describe, expect, test } from "bun:test"
import { legacyTagWarning } from "./legacy-tags"

const sha = "a".repeat(40)

describe("legacyTagWarning", () => {
  test("counts the tags without an environment segment", () => {
    const lines = [
      `${sha}\trefs/tags/deployed/web`,
      `${sha}\trefs/tags/deployed/server`,
      `${sha}\trefs/tags/deployed/staging/web`,
    ].join("\n")

    expect(legacyTagWarning(lines)).toBe(
      "2 deployed/<app> tag(s) of the old layout are not read; their images are not protected",
    )
  })

  test("is silent when every tag has an environment", () => {
    expect(legacyTagWarning(`${sha}\trefs/tags/deployed/staging/web\n`)).toBeUndefined()
  })

  test("is silent for empty output", () => {
    expect(legacyTagWarning("")).toBeUndefined()
  })
})
