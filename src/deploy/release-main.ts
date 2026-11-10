import { setTimeout as sleep } from "node:timers/promises"
import * as core from "@actions/core"
import { z } from "zod"
import { minutes } from "../inputs/pipeline-inputs"
import { fail } from "../lib/fail"
import { type Leg, parseLeg } from "../plan/leg"
import { COOLIFY_POLL_INTERVAL_MS, deployImage } from "./coolify"
import { moveDeployedTag } from "./deployed-tag"
import { checkHealth } from "./health"
import type { HttpFetch } from "./http-fetch"

const envSchema = z.object({
  LEG_JSON: z.string().min(1),
  COOLIFY_URL: z.url(),
  COOLIFY_TOKEN: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPOSITORY: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  GITHUB_SHA: z.string().regex(/^[0-9a-f]{40}$/),
  COOLIFY_DEPLOY_TIMEOUT_MINUTES: minutes,
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
  await releaseLeg(
    parseLeg(env.LEG_JSON),
    {
      coolifyUrl: env.COOLIFY_URL,
      coolifyToken: env.COOLIFY_TOKEN,
      githubToken: env.GITHUB_TOKEN,
      repo: env.GITHUB_REPOSITORY,
      sha: env.GITHUB_SHA,
      budgetMs: env.COOLIFY_DEPLOY_TIMEOUT_MINUTES * 60_000,
    },
    { fetch, sleep: (ms) => sleep(ms) },
  )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    fail(error)
  }
}
