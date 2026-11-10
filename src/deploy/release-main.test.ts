import { describe, expect, test } from "bun:test"
import { failureOf } from "../lib/failure-of"
import type { Leg } from "../plan/plan"
import type { HttpFetch } from "./http-fetch"
import { type ReleaseConfig, releaseLeg } from "./release-main"

const SHA = "4f2a9c1e0b7d4f2a9c1e0b7d4f2a9c1e0b7d4f2a"
const IMAGE = "ghcr.io/vengex-org/platform-api"
const HEALTH_URL = "https://api.example.com/health"

const LEG: Leg = {
  app: "api",
  environment: "staging",
  project: "api",
  image: IMAGE,
  tag: `staging-${SHA}`,
  dockerfile: "apps/api/Dockerfile",
  context: ".",
  platform: "linux/arm64",
  runner: "ubuntu-24.04-arm",
  prebuild: undefined,
  secrets: [],
  buildArgs: {},
  coolify: "uuid1",
  health: { url: HEALTH_URL, commit: true },
  reason: "changed",
}

const CONFIG: ReleaseConfig = {
  coolifyUrl: "https://coolify.example.com",
  coolifyToken: "coolify-token",
  githubToken: "github-token",
  repo: "vengex-org/platform",
  sha: SHA,
  budgetMs: 10_000,
}

/** Coolify, the health endpoint and GitHub in one router; `calls` is the order they were hit in. */
function services(
  options: {
    coolifyImage?: string
    deploymentStatus?: string
    healthStatus?: number
    healthBody?: string
  } = {},
) {
  const calls: string[] = []
  const fetchImpl: HttpFetch = (url, init) => {
    const { host, pathname } = new URL(url)
    const method = init.method ?? "GET"
    calls.push(`${method} ${host}${pathname}`)

    if (host === "coolify.example.com") {
      if (pathname === "/api/v1/applications/uuid1") {
        return Promise.resolve(
          method === "GET"
            ? Response.json({
                build_pack: "dockerimage",
                docker_registry_image_name: options.coolifyImage ?? IMAGE,
              })
            : Response.json({ uuid: "uuid1" }),
        )
      }
      if (pathname === "/api/v1/deploy") {
        return Promise.resolve(
          Response.json({ deployments: [{ resource_uuid: "uuid1", deployment_uuid: "dep1" }] }),
        )
      }
      return Promise.resolve(Response.json({ status: options.deploymentStatus ?? "finished" }))
    }
    if (host === "api.example.com") {
      return Promise.resolve(
        new Response(options.healthBody ?? JSON.stringify({ commit: SHA }), {
          status: options.healthStatus ?? 200,
        }),
      )
    }
    return Promise.resolve(Response.json({}))
  }
  const deps = { fetch: fetchImpl, sleep: () => Promise.resolve(), now: () => 0 }
  return { calls, deps }
}

const TAG_MOVE = "PATCH api.github.com/repos/vengex-org/platform/git/refs/tags/deployed/staging/api"

describe("releaseLeg", () => {
  test("deploys, checks health, and only then moves the tag", async () => {
    const { calls, deps } = services()

    await releaseLeg(LEG, CONFIG, deps)

    expect(calls).toEqual([
      "GET coolify.example.com/api/v1/applications/uuid1",
      "PATCH coolify.example.com/api/v1/applications/uuid1",
      "POST coolify.example.com/api/v1/deploy",
      "GET coolify.example.com/api/v1/deployments/dep1",
      "GET api.example.com/health",
      TAG_MOVE,
    ])
  })

  test("moves the tag right after the deploy when the leg has no health check", async () => {
    const { calls, deps } = services()

    await releaseLeg({ ...LEG, health: undefined }, CONFIG, deps)

    expect(calls.at(-2)).toBe("GET coolify.example.com/api/v1/deployments/dep1")
    expect(calls.at(-1)).toBe(TAG_MOVE)
    expect(calls.some((call) => call.includes("api.example.com"))).toBe(false)
  })

  test("accepts any 200 when the health check does not ask for the commit", async () => {
    const { calls, deps } = services({ healthBody: "ok" })

    await releaseLeg({ ...LEG, health: { url: HEALTH_URL, commit: false } }, CONFIG, deps)

    expect(calls.at(-1)).toBe(TAG_MOVE)
  })

  test("does not touch the tag when the deployment fails", async () => {
    const { calls, deps } = services({ deploymentStatus: "failed" })

    expect(await failureOf(releaseLeg(LEG, CONFIG, deps))).toContain("ended as failed")
    expect(calls.some((call) => call.includes("api.example.com"))).toBe(false)
    expect(calls.some((call) => call.includes("api.github.com"))).toBe(false)
  })

  test("does not touch the tag when the service never serves this commit", async () => {
    const { calls, deps } = services({ healthBody: JSON.stringify({ commit: "0".repeat(40) }) })

    expect(await failureOf(releaseLeg(LEG, CONFIG, deps))).toContain("did not pass in 20 attempts")
    expect(calls.some((call) => call.includes("api.github.com"))).toBe(false)
  })

  test("does not touch the tag when the health check fails permanently", async () => {
    const { calls, deps } = services({ healthStatus: 404 })

    expect(await failureOf(releaseLeg(LEG, CONFIG, deps))).toContain("HTTP 404")
    expect(calls.some((call) => call.includes("api.github.com"))).toBe(false)
  })

  test("deploys and tags nothing when the coolify resource runs another image", async () => {
    const { calls, deps } = services({ coolifyImage: "ghcr.io/other/app" })

    expect(await failureOf(releaseLeg(LEG, CONFIG, deps))).toContain("expected ghcr.io/vengex-org")
    expect(calls).toEqual(["GET coolify.example.com/api/v1/applications/uuid1"])
  })
})
