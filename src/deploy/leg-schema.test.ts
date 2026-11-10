import { describe, expect, test } from "bun:test"
import type { BuildLeg, Leg } from "../plan/plan"
import { parseBuildLeg, parseLeg } from "./leg-schema"

const LEG: Leg = {
  app: "api",
  environment: "staging",
  project: "api",
  image: "ghcr.io/vengex-org/platform-api",
  tag: "staging-4f2a9c1e0b7d4f2a9c1e0b7d4f2a9c1e0b7d4f2a",
  dockerfile: "apps/api/Dockerfile",
  context: ".",
  platform: "linux/arm64",
  runner: "ubuntu-24.04-arm",
  prebuild: undefined,
  secrets: ["packages"],
  buildArgs: { VITE_URL: "https://x.example.com" },
  coolify: "uuid1",
  health: { url: "https://api.example.com/health", commit: true },
  reason: "changed",
}

describe("parseLeg", () => {
  test("reads a leg and restores the keys JSON dropped for undefined", () => {
    const parsed = parseLeg(JSON.stringify({ ...LEG, health: undefined }))

    expect(parsed).toEqual({ ...LEG, health: undefined })
    expect(parsed.health).toBeUndefined()
  })

  test("keeps health and prebuild when present", () => {
    expect(parseLeg(JSON.stringify({ ...LEG, prebuild: "bun run gen" }))).toEqual({
      ...LEG,
      prebuild: "bun run gen",
    })
  })

  test("rejects JSON that is not valid", () => {
    expect(() => parseLeg("{")).toThrow()
  })

  test("rejects a field the plan does not produce", () => {
    expect(() => parseLeg(JSON.stringify({ ...LEG, extra: 1 }))).toThrow()
  })

  test("rejects an unknown platform", () => {
    expect(() => parseLeg(JSON.stringify({ ...LEG, platform: "linux/s390x" }))).toThrow()
  })

  for (const field of ["tag", "coolify", "image"] as const) {
    test(`rejects an empty ${field}`, () => {
      expect(() => parseLeg(JSON.stringify({ ...LEG, [field]: "" }))).toThrow()
    })
  }
})

describe("parseBuildLeg", () => {
  test("reads the resources to check read-only", () => {
    const leg: BuildLeg = { ...LEG, preflight: ["uuid1", "uuid2"] }

    expect(parseBuildLeg(JSON.stringify(leg))).toEqual(leg)
  })

  test("rejects a build leg without the preflight list", () => {
    expect(() => parseBuildLeg(JSON.stringify(LEG))).toThrow()
  })
})
