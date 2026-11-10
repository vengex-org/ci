import { describe, expect, test } from "bun:test"
import { failureOf } from "../lib/failure-of"
import { type DeployDeps, deployImage, preflightCoolify } from "./coolify"
import type { HttpFetch } from "./http-fetch"

const TOKEN = "test-token"
const TAG = "staging-4f2a9c1e0b7d4f2a9c1e0b7d4f2a9c1e0b7d4f2a"
const IMAGE = "ghcr.io/vengex-org/platform-api"
const ACCESS = { baseUrl: "https://coolify.example.com", token: TOKEN }
const INPUT = { ...ACCESS, uuid: "api", image: IMAGE, tag: TAG }

type Call = { method: string; path: string; url: string; init: RequestInit }

/**
 * A Coolify stand-in for one application. Each poll of the deployment returns the next status it
 * was given and repeats the last one, so a test can hand over a status that never settles.
 */
function coolifyFake(
  options: {
    statuses?: readonly string[]
    application?: Record<string, unknown>
    /** Replaces the answer to one call; a Response is read once, so only for calls made once. */
    reply?: { tag?: Response; deploy?: Response; poll?: Response }
  } = {},
) {
  const statuses = options.statuses ?? ["finished"]
  const application = options.application ?? {
    build_pack: "dockerimage",
    docker_registry_image_name: IMAGE,
  }
  const calls: Call[] = []
  let polls = 0

  const fetchImpl: HttpFetch = (url, init) => {
    const { pathname } = new URL(url)
    const method = init.method ?? "GET"
    calls.push({ method, path: pathname, url, init })

    if (pathname === "/api/v1/applications/api") {
      return Promise.resolve(
        method === "GET"
          ? Response.json(application)
          : (options.reply?.tag ?? Response.json({ uuid: "api" })),
      )
    }
    if (pathname === "/api/v1/deploy") {
      return Promise.resolve(
        options.reply?.deploy
          ?? Response.json({ deployments: [{ resource_uuid: "api", deployment_uuid: "dep-api" }] }),
      )
    }
    const status = statuses[Math.min(polls, statuses.length - 1)]
    polls += 1
    return Promise.resolve(options.reply?.poll ?? Response.json({ status }))
  }

  return { calls, fetchImpl, pollCount: () => polls }
}

/** An injected clock that sleeping advances, so the wait budget runs out without waiting. */
function depsFor(fetchImpl: HttpFetch, over: Partial<DeployDeps> = {}) {
  let time = 0
  const sleeps: number[] = []
  const deps: DeployDeps = {
    fetch: fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms)
      time += ms
      return Promise.resolve()
    },
    now: () => time,
    pollIntervalMs: 1000,
    budgetMs: 10_000,
    ...over,
  }
  return { deps, sleeps }
}

function fixedReply(status: number, body: unknown): HttpFetch {
  return () => Promise.resolve(Response.json(body, { status }))
}

describe("deployImage", () => {
  test("asks coolify to deploy the one application with force", async () => {
    const { calls, fetchImpl } = coolifyFake()

    await deployImage(INPUT, depsFor(fetchImpl).deps)

    const deployCalls = calls.filter((call) => call.path === "/api/v1/deploy")
    expect(deployCalls).toHaveLength(1)
    const url = new URL(deployCalls[0]?.url ?? "")
    expect(url.searchParams.get("uuid")).toBe("api")
    expect(url.searchParams.get("force")).toBe("true")
    expect(deployCalls[0]?.method).toBe("POST")
  })

  test("carries the token in the authorization header and never in the url", async () => {
    const { calls, fetchImpl } = coolifyFake()

    await deployImage(INPUT, depsFor(fetchImpl).deps)

    expect(calls.length).toBeGreaterThan(3)
    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN)
      expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`)
    }
  })

  test("reads the application, sets the tag, then deploys and polls, in that order", async () => {
    const { calls, fetchImpl } = coolifyFake()

    await deployImage(INPUT, depsFor(fetchImpl).deps)

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/v1/applications/api",
      "PATCH /api/v1/applications/api",
      "POST /api/v1/deploy",
      "GET /api/v1/deployments/dep-api",
    ])
    const patch = calls[1]
    expect(patch?.init.body).toBe(JSON.stringify({ docker_registry_image_tag: TAG }))
    expect(new Headers(patch?.init.headers).get("content-type")).toBe("application/json")
  })

  test("accepts a base url with trailing slashes", async () => {
    const { calls, fetchImpl } = coolifyFake()

    await deployImage(
      { ...INPUT, baseUrl: "https://coolify.example.com//" },
      depsFor(fetchImpl).deps,
    )

    expect(calls[0]?.url).toBe("https://coolify.example.com/api/v1/applications/api")
  })

  test("keeps polling while the deployment is queued and still building", async () => {
    const { fetchImpl, pollCount } = coolifyFake({
      statuses: ["queued", "in_progress", "finished"],
    })
    const { deps, sleeps } = depsFor(fetchImpl)

    await deployImage(INPUT, deps)

    expect(pollCount()).toBe(3)
    expect(sleeps).toEqual([1000, 1000])
  })

  test("fails on a deployment that ends as failed", async () => {
    const { fetchImpl } = coolifyFake({ statuses: ["in_progress", "failed"] })

    expect(await failureOf(deployImage(INPUT, depsFor(fetchImpl).deps))).toContain(
      "dep-api of api ended as failed",
    )
  })

  test("fails on a deployment cancelled in the interface", async () => {
    const { fetchImpl } = coolifyFake({ statuses: ["cancelled-by-user"] })

    expect(await failureOf(deployImage(INPUT, depsFor(fetchImpl).deps))).toContain(
      "ended as cancelled-by-user",
    )
  })

  test("never reads a status it does not know as a success", async () => {
    const { fetchImpl, pollCount } = coolifyFake({ statuses: ["a-status-from-a-later-coolify"] })
    const { deps } = depsFor(fetchImpl, { budgetMs: 3000 })

    expect(await failureOf(deployImage(INPUT, deps))).toContain(
      "still a-status-from-a-later-coolify after 3000 ms",
    )
    expect(pollCount()).toBe(4)
  })

  test("stops waiting when the budget runs out and names the last status", async () => {
    const { fetchImpl, pollCount } = coolifyFake({ statuses: ["in_progress"] })
    const { deps, sleeps } = depsFor(fetchImpl, { budgetMs: 3000 })

    expect(await failureOf(deployImage(INPUT, deps))).toContain("still in_progress after 3000 ms")
    expect(pollCount()).toBe(4)
    expect(sleeps).toEqual([1000, 1000, 1000])
  })

  test("polls once and gives up when the budget is already spent, on the real clock", async () => {
    const { fetchImpl, pollCount } = coolifyFake({ statuses: ["in_progress"] })
    const { deps } = depsFor(fetchImpl, { budgetMs: 0 })
    const { now: _fakeClock, ...withRealClock } = deps

    expect(await failureOf(deployImage(INPUT, withRealClock))).toContain("still in_progress")
    expect(pollCount()).toBe(1)
  })

  test("refuses an application that runs another image before changing anything", async () => {
    const { calls, fetchImpl } = coolifyFake({
      application: { build_pack: "dockerimage", docker_registry_image_name: "ghcr.io/other/app" },
    })

    expect(await failureOf(deployImage(INPUT, depsFor(fetchImpl).deps))).toContain(
      `application api runs ghcr.io/other/app, expected ${IMAGE}`,
    )
    expect(calls.map((call) => call.method)).toEqual(["GET"])
  })

  test("refuses an application that names no image before changing anything", async () => {
    const { calls, fetchImpl } = coolifyFake({
      application: { build_pack: "dockerimage", docker_registry_image_name: null },
    })

    expect(await failureOf(deployImage(INPUT, depsFor(fetchImpl).deps))).toContain(
      "runs no registry image",
    )
    expect(calls.map((call) => call.method)).toEqual(["GET"])
  })

  test("rejects when coolify refuses the application lookup", async () => {
    const { deps } = depsFor(fixedReply(404, { message: "Application not found." }))

    expect(await failureOf(deployImage(INPUT, deps))).toContain("application api does not exist")
  })

  test("deploys nothing when coolify refuses to change the tag", async () => {
    const { calls, fetchImpl } = coolifyFake({
      reply: { tag: Response.json({ message: "Validation failed." }, { status: 422 }) },
    })

    expect(await failureOf(deployImage(INPUT, depsFor(fetchImpl).deps))).toContain("422")
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/v1/applications/api",
      "PATCH /api/v1/applications/api",
    ])
  })

  test("keeps the refusal body out of the error and the status and path in the cause", async () => {
    const { fetchImpl } = coolifyFake({
      reply: { deploy: Response.json({ message: "Unauthenticated." }, { status: 401 }) },
    })

    const error = await deployImage(INPUT, depsFor(fetchImpl).deps).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : "").not.toContain("Unauthenticated.")
    expect(error instanceof Error ? error.message : "").toContain("401")
    expect(error instanceof Error ? error.cause : undefined).toEqual({
      status: 401,
      path: "/deploy?uuid=api&force=true",
    })
  })

  test("rejects when coolify refuses a poll", async () => {
    const { fetchImpl } = coolifyFake({
      reply: { poll: Response.json({ message: "Server Error" }, { status: 500 }) },
    })

    expect(await failureOf(deployImage(INPUT, depsFor(fetchImpl).deps))).toContain("500")
  })

  test("rejects a reply that started no deployment for the application", async () => {
    const { fetchImpl } = coolifyFake({
      reply: {
        deploy: Response.json({
          deployments: [{ resource_uuid: "web", deployment_uuid: "dep-web" }],
        }),
      },
    })

    expect(await failureOf(deployImage(INPUT, depsFor(fetchImpl).deps))).toContain(
      "started no deployment for api",
    )
  })

  test("rejects a deploy reply whose shape is not the documented one", async () => {
    const { fetchImpl } = coolifyFake({
      reply: { deploy: Response.json({ deployments: [{ ok: true }] }) },
    })

    expect(await failureOf(deployImage(INPUT, depsFor(fetchImpl).deps))).toContain("resource_uuid")
  })
})

describe("preflightCoolify", () => {
  const PREFLIGHT = { ...ACCESS, uuid: "api", image: IMAGE }

  test("passes for an image application running the expected image, with GET only", async () => {
    const { calls, fetchImpl } = coolifyFake()

    await preflightCoolify(PREFLIGHT, fetchImpl)

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/v1/applications/api",
    ])
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`)
  })

  test("fails when the application does not exist", async () => {
    expect(
      await failureOf(
        preflightCoolify(PREFLIGHT, fixedReply(404, { message: "Application not found." })),
      ),
    ).toContain("application api does not exist")
  })

  test("keeps the http error as the cause of a missing application", async () => {
    const error = await preflightCoolify(PREFLIGHT, fixedReply(404, {})).catch(
      (caught: unknown) => caught,
    )

    expect(error instanceof Error ? error.cause : undefined).toBeInstanceOf(Error)
  })

  test("rethrows an error other than not found", async () => {
    expect(await failureOf(preflightCoolify(PREFLIGHT, fixedReply(401, {})))).toContain(
      "answered 401 to GET /applications/api",
    )
  })

  test("fails when the application is not built from a registry image", async () => {
    const { fetchImpl } = coolifyFake({
      application: { build_pack: "nixpacks", docker_registry_image_name: IMAGE },
    })

    expect(await failureOf(preflightCoolify(PREFLIGHT, fetchImpl))).toContain(
      "build pack nixpacks, expected dockerimage",
    )
  })

  test("fails when the application runs another image", async () => {
    const { fetchImpl } = coolifyFake({
      application: { build_pack: "dockerimage", docker_registry_image_name: "ghcr.io/other/app" },
    })

    expect(await failureOf(preflightCoolify(PREFLIGHT, fetchImpl))).toContain(
      `runs ghcr.io/other/app, expected ${IMAGE}`,
    )
  })

  test("fails when the application names no image", async () => {
    const { fetchImpl } = coolifyFake({ application: { build_pack: "dockerimage" } })

    expect(await failureOf(preflightCoolify(PREFLIGHT, fetchImpl))).toContain(
      "runs no registry image",
    )
  })
})
