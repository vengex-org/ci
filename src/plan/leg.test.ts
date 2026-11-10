import { describe, expect, test } from "bun:test"
import type { Deployable } from "../inputs/deploy-metadata"
import { type BuildLeg, type Leg, parseBuildLeg, parseLeg } from "./leg"
import { MASTER_REF, planRun } from "./plan"

const SHA = "4f2a9c1e0b7d4f2a9c1e0b7d4f2a9c1e0b7d4f2a"

const LEG: Leg = {
  app: "api",
  environment: "staging",
  project: "api",
  image: "ghcr.io/vengex-org/platform-api",
  tag: `staging-${SHA}`,
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

const DEPLOYABLE: Deployable = {
  project: "api",
  deploy: {
    name: "api",
    image: "ghcr.io/vengex-org/platform-api",
    dockerfile: "apps/api/Dockerfile",
    context: ".",
    platform: "linux/amd64",
    prebuild: undefined,
    secrets: [],
    environments: {
      staging: { coolify: "uuid1", buildArgs: {}, health: undefined },
      production: {
        coolify: "uuid2",
        buildArgs: { VITE_URL: "https://x.example.com" },
        health: { url: "https://api.example.com/health", commit: false },
      },
    },
  },
}

describe("parseLeg", () => {
  test("reads a leg and restores the keys JSON dropped for undefined", () => {
    const parsed = parseLeg(JSON.stringify({ ...LEG, health: undefined }))

    expect(parsed).toEqual({ ...LEG, health: undefined })
    expect(parsed.health).toBeUndefined()
    expect(parsed.prebuild).toBeUndefined()
  })

  test("keeps prebuild when present", () => {
    expect(parseLeg(JSON.stringify({ ...LEG, prebuild: "bun run gen" }))).toEqual({
      ...LEG,
      prebuild: "bun run gen",
    })
  })

  test("reads the legs the plan job serializes", async () => {
    const plan = await planRun(
      {
        trigger: { event: "workflow_dispatch", ref: MASTER_REF, environment: "production" },
        sha: SHA,
        environments: { staging: "auto", production: "manual" },
        deployables: [DEPLOYABLE],
        affected: [],
      },
      {
        deployedCommit: async () => undefined,
        isAncestor: async () => false,
        isAffectedSince: async () => false,
      },
    )

    expect(plan.release).toHaveLength(1)
    expect(plan.release.map((planned) => parseLeg(JSON.stringify(planned)))).toEqual(plan.release)
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

  test("rejects a runner that does not run the platform", () => {
    expect(() => parseLeg(JSON.stringify({ ...LEG, runner: "ubuntu-latest" }))).toThrow(/runner/)
  })

  test.each(["tag", "coolify", "image", "app", "environment"] as const)(
    "rejects an empty %s",
    (field) => {
      expect(() => parseLeg(JSON.stringify({ ...LEG, [field]: "" }))).toThrow(field)
    },
  )

  test.each([
    ["image", "docker.io/vengex-org/platform-api"],
    ["tag", `staging-${SHA.toUpperCase()}`],
    ["tag", "staging-abc"],
    ["tag", SHA],
    ["app", "../api"],
    ["environment", "UPPER"],
    ["coolify", "UUID-1"],
  ] as const)("rejects %s %p", (field, value) => {
    expect(() => parseLeg(JSON.stringify({ ...LEG, [field]: value }))).toThrow(field)
  })
})

describe("parseBuildLeg", () => {
  test("reads the resources to check read-only", () => {
    const leg: BuildLeg = { ...LEG, preflight: ["uuid1", "uuid2"] }

    expect(parseBuildLeg(JSON.stringify(leg))).toEqual(leg)
  })

  test("rejects a build leg without the preflight list", () => {
    expect(() => parseBuildLeg(JSON.stringify(LEG))).toThrow()
  })

  test("rejects a runner that does not run the platform", () => {
    const leg: BuildLeg = { ...LEG, runner: "ubuntu-latest", preflight: [] }

    expect(() => parseBuildLeg(JSON.stringify(leg))).toThrow(/runner/)
  })
})
