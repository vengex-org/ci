import { z } from "zod"
import type { HttpFetch } from "./http-fetch"

// Same values as COOLIFY_DEPLOY_BUDGET_MS and COOLIFY_POLL_INTERVAL_MS in platform/tools/env.ts:
// a first image pull, the API's migrations and the healthchecks' start periods add up, and a
// deploy wrongly reported as timed out sends someone looking for a fault that is not there.
export const COOLIFY_DEPLOY_BUDGET_MS = 900_000
export const COOLIFY_POLL_INTERVAL_MS = 5000

/** The one status that means the build is up. */
const FINISHED = "finished"
/** Terminal states that are not successes. A status outside both sets counts as still running, so a
 *  value a later Coolify adds can only cost the wait, never report a failed deploy as a good one. */
const GIVEN_UP = new Set(["failed", "cancelled-by-user"])

/**
 * `build_pack` of an application created from a registry image. Coolify's source sets it in
 * `ApplicationsController::create_application` (`$application->build_pack = 'dockerimage'`);
 * the OpenAPI `Application` schema's `build_pack` enum (nixpacks, railpack, static, dockerfile,
 * dockercompose) does not list it.
 */
const DOCKER_IMAGE_BUILD_PACK = "dockerimage"

const applicationSchema = z.object({
  build_pack: z.string(),
  docker_registry_image_name: z.string().min(1).nullish(),
})

const deployResponseSchema = z.object({
  deployments: z.array(z.object({ resource_uuid: z.string(), deployment_uuid: z.string() })),
})

const deploymentSchema = z.object({ status: z.string() })

export type CoolifyAccess = { baseUrl: string; token: string }

export type DeployDeps = {
  fetch: HttpFetch
  sleep: (ms: number) => Promise<void>
  now?: () => number
  pollIntervalMs: number
  budgetMs: number
}

/** A Coolify answer other than 2xx. The body stays in `cause`: it is never printed. */
export class CoolifyHttpError extends Error {
  readonly status: number

  constructor(method: string, path: string, status: number, body: string) {
    super(`coolify answered ${status} to ${method} ${path}`, { cause: { status, body } })
    this.status = status
  }
}

/**
 * Points one Coolify application at `tag` of `image`, redeploys it and waits for the deployment.
 *
 * The tag is set on the application, not passed to the deploy call: Coolify accepts the deploy
 * parameter `docker_tag` only together with a pull request id. The application is read first and
 * nothing is written when it runs another image, so a wrong uuid cannot repoint a foreign service.
 */
export async function deployImage(
  input: CoolifyAccess & { uuid: string; image: string; tag: string },
  deps: DeployDeps,
): Promise<void> {
  const { uuid, image, tag } = input
  const application = await readApplication(input, deps.fetch)
  if (application.docker_registry_image_name !== image) {
    throw new Error(
      `coolify application ${uuid} runs ${application.docker_registry_image_name ?? "no registry image"}, expected ${image}`,
    )
  }

  await coolifyRequest(input, `/applications/${uuid}`, deps.fetch, {
    method: "PATCH",
    body: JSON.stringify({ docker_registry_image_tag: tag }),
  })

  const query = new URLSearchParams({ uuid, force: "true" })
  const started = deployResponseSchema.parse(
    await coolifyRequest(input, `/deploy?${query.toString()}`, deps.fetch, { method: "POST" }),
  )
  const deployment = started.deployments.find((entry) => entry.resource_uuid === uuid)
  if (deployment === undefined) {
    throw new Error(`coolify started no deployment for ${uuid}`)
  }

  await waitForDeployment(input, uuid, deployment.deployment_uuid, deps)
}

/**
 * Read-only check that `uuid` is an image-based application running `image`. A pull request runs
 * it for every environment, so a missing or mistyped resource fails before merge instead of at the
 * first release.
 */
export async function preflightCoolify(
  input: CoolifyAccess & { uuid: string; image: string },
  fetch: HttpFetch,
): Promise<void> {
  const { uuid, image } = input
  const application = await readApplication(input, fetch)

  if (application.build_pack !== DOCKER_IMAGE_BUILD_PACK) {
    throw new Error(
      `coolify application ${uuid} has build pack ${application.build_pack}, expected ${DOCKER_IMAGE_BUILD_PACK}`,
    )
  }
  if (application.docker_registry_image_name !== image) {
    throw new Error(
      `coolify application ${uuid} runs ${application.docker_registry_image_name ?? "no registry image"}, expected ${image}`,
    )
  }
}

async function readApplication(
  input: CoolifyAccess & { uuid: string },
  fetch: HttpFetch,
): Promise<z.infer<typeof applicationSchema>> {
  try {
    return applicationSchema.parse(
      await coolifyRequest(input, `/applications/${input.uuid}`, fetch),
    )
  } catch (error) {
    if (error instanceof CoolifyHttpError && error.status === 404) {
      throw new Error(`coolify application ${input.uuid} does not exist`, { cause: error })
    }
    throw error
  }
}

async function waitForDeployment(
  access: CoolifyAccess,
  uuid: string,
  deploymentUuid: string,
  deps: DeployDeps,
): Promise<void> {
  const now = deps.now ?? Date.now
  const deadline = now() + deps.budgetMs

  for (;;) {
    const { status } = deploymentSchema.parse(
      await coolifyRequest(access, `/deployments/${deploymentUuid}`, deps.fetch),
    )

    if (status === FINISHED) return
    if (GIVEN_UP.has(status)) {
      throw new Error(`coolify deployment ${deploymentUuid} of ${uuid} ended as ${status}`)
    }
    if (now() >= deadline) {
      throw new Error(
        `coolify deployment ${deploymentUuid} of ${uuid} was still ${status} after ${deps.budgetMs} ms`,
      )
    }

    await deps.sleep(deps.pollIntervalMs)
  }
}

/** The token travels in the header, never in the path, so neither an error nor a proxy log carries it. */
async function coolifyRequest(
  access: CoolifyAccess,
  path: string,
  fetch: HttpFetch,
  init: { method?: string; body?: string } = {},
): Promise<unknown> {
  const response = await fetch(`${access.baseUrl.replace(/\/+$/, "")}/api/v1${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${access.token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  })

  if (!response.ok) {
    throw new CoolifyHttpError(
      init.method ?? "GET",
      path,
      response.status,
      (await response.text()).slice(0, 500),
    )
  }
  return await response.json()
}
