import { describe, expect, test } from "bun:test"
import type { BuildLeg } from "../plan/plan"
import type { HttpFetch } from "./http-fetch"
import { preflightLeg } from "./preflight-main"

const IMAGE = "ghcr.io/vengex-org/platform-api"
const ACCESS = { baseUrl: "https://coolify.example.com", token: "read-token" }

const LEG: BuildLeg = {
  app: "api",
  environment: "staging",
  project: "api",
  image: IMAGE,
  tag: "staging-4f2a9c1e0b7d4f2a9c1e0b7d4f2a9c1e0b7d4f2a",
  dockerfile: "apps/api/Dockerfile",
  context: ".",
  platform: "linux/arm64",
  runner: "ubuntu-24.04-arm",
  prebuild: undefined,
  secrets: [],
  buildArgs: {},
  coolify: "good",
  health: undefined,
  reason: "changed",
  preflight: ["good", "missing", "wrong-image", "wrong-pack"],
}

const fetchImpl: HttpFetch = (url) => {
  const uuid = url.slice(url.lastIndexOf("/") + 1)
  const applications: Record<string, object> = {
    good: { build_pack: "dockerimage", docker_registry_image_name: IMAGE },
    "wrong-image": { build_pack: "dockerimage", docker_registry_image_name: "ghcr.io/other/app" },
    "wrong-pack": { build_pack: "nixpacks", docker_registry_image_name: IMAGE },
  }
  const application = applications[uuid]
  return Promise.resolve(
    application === undefined
      ? Response.json({ message: "Application not found." }, { status: 404 })
      : Response.json(application),
  )
}

const rejectingFetch: HttpFetch = () => Promise.reject("plain string")

describe("preflightLeg", () => {
  test("reports every failed resource, not only the first", async () => {
    const failures = await preflightLeg(LEG, ACCESS, fetchImpl)

    expect(failures).toHaveLength(3)
    expect(failures[0]).toContain("missing does not exist")
    expect(failures[1]).toContain("wrong-image runs ghcr.io/other/app")
    expect(failures[2]).toContain("wrong-pack has build pack nixpacks")
  })

  test("reports nothing when every resource passes", async () => {
    expect(await preflightLeg({ ...LEG, preflight: ["good"] }, ACCESS, fetchImpl)).toEqual([])
  })

  test("reports a failure that is not an Error by its text", async () => {
    expect(await preflightLeg({ ...LEG, preflight: ["good"] }, ACCESS, rejectingFetch)).toEqual([
      "plain string",
    ])
  })
})
