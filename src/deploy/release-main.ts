import { setTimeout as sleep } from "node:timers/promises"
import * as core from "@actions/core"
import { z } from "zod"
import type { Leg } from "../plan/plan"
import { COOLIFY_DEPLOY_BUDGET_MS, COOLIFY_POLL_INTERVAL_MS, deployImage } from "./coolify"
import { moveDeployedTag } from "./deployed-tag"
import { checkHealth } from "./health"
import type { HttpFetch } from "./http-fetch"
import { parseLeg } from "./leg-schema"

const envSchema = z.object({
  LEG_JSON: z.string().min(1),
  COOLIFY_URL: z.url(),
  COOLIFY_TOKEN: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPOSITORY: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  GITHUB_SHA: z.string().regex(/^[0-9a-f]{40}$/),
  // An unset workflow variable arrives as an empty string.
  COOLIFY_DEPLOY_TIMEOUT_MINUTES: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().positive().finite().optional(),
  ),
})

export type ReleaseConfig = {
  coolifyUrl: string
  coolifyToken: string
  githubToken: string
  repo: string
  sha: string
  budgetMs: number
}

export type ReleaseDeps = {
  fetch: HttpFetch
  sleep: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Deploys one leg, checks that it serves, and only then moves its `deployed/<environment>/<app>`
 * tag: a tag that moved past a failed deploy would hide its changes from every later plan.
 */
export async function releaseLeg(
  leg: Leg,
  config: ReleaseConfig,
  deps: ReleaseDeps,
): Promise<void> {
  await deployImage(
    {
      baseUrl: config.coolifyUrl,
      token: config.coolifyToken,
      uuid: leg.coolify,
      image: leg.image,
      tag: leg.tag,
    },
    { ...deps, pollIntervalMs: COOLIFY_POLL_INTERVAL_MS, budgetMs: config.budgetMs },
  )
  core.info(`${leg.app} (${leg.environment}) deployed as ${leg.tag}`)

  if (leg.health === undefined) {
    core.info(`${leg.app} (${leg.environment}) has no health check configured`)
  } else {
    await checkHealth({ ...leg.health, sha: config.sha }, deps)
    core.info(`${leg.app} (${leg.environment}) answered at ${leg.health.url}`)
  }

  await moveDeployedTag(
    {
      repo: config.repo,
      environment: leg.environment,
      app: leg.app,
      sha: config.sha,
      token: config.githubToken,
    },
    deps.fetch,
  )
  core.info(`deployed/${leg.environment}/${leg.app} now points at ${config.sha}`)
}

async function main(): Promise<void> {
  const env = envSchema.parse(process.env)
  const minutes = env.COOLIFY_DEPLOY_TIMEOUT_MINUTES
  await releaseLeg(
    parseLeg(env.LEG_JSON),
    {
      coolifyUrl: env.COOLIFY_URL,
      coolifyToken: env.COOLIFY_TOKEN,
      githubToken: env.GITHUB_TOKEN,
      repo: env.GITHUB_REPOSITORY,
      sha: env.GITHUB_SHA,
      budgetMs: minutes === undefined ? COOLIFY_DEPLOY_BUDGET_MS : minutes * 60_000,
    },
    { fetch, sleep: (ms) => sleep(ms) },
  )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
