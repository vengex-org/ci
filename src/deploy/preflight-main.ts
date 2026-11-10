import * as core from "@actions/core"
import { z } from "zod"
import { fail } from "../lib/fail"
import { type BuildLeg, parseBuildLeg } from "../plan/leg"
import { preflightCoolify } from "./coolify"
import type { HttpFetch } from "./http-fetch"

const envSchema = z.object({
  LEG_JSON: z.string().min(1),
  COOLIFY_URL: z.url(),
  COOLIFY_READ_TOKEN: z.string().min(1),
})

/** Checks every Coolify resource of the leg and returns one message per failed resource. */
export async function preflightLeg(
  leg: BuildLeg,
  access: { baseUrl: string; token: string },
  fetch: HttpFetch,
): Promise<string[]> {
  const results = await Promise.allSettled(
    leg.preflight.map((uuid) => preflightCoolify({ ...access, uuid, image: leg.image }, fetch)),
  )
  return results.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  )
}

async function main(): Promise<number> {
  const env = envSchema.parse(process.env)
  const leg = parseBuildLeg(env.LEG_JSON)
  const failures = await preflightLeg(
    leg,
    { baseUrl: env.COOLIFY_URL, token: env.COOLIFY_READ_TOKEN },
    fetch,
  )

  core.info(`${leg.app}: checked ${leg.preflight.length} coolify resources for ${leg.image}`)
  for (const failure of failures) core.error(failure)
  return failures.length === 0 ? 0 : 1
}

if (import.meta.main) {
  try {
    const code = await main()
    if (code !== 0) {
      core.setFailed("coolify preflight failed")
      process.exit(code)
    }
  } catch (error) {
    fail(error)
  }
}
