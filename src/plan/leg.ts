import { z } from "zod"
import {
  BUILD_SECRETS,
  PLATFORMS,
  RUNNER_BY_PLATFORM,
  buildArgName,
  coolifyId,
  healthCheck,
  imageName,
} from "../inputs/deploy-metadata"
import { refName } from "../inputs/ref-name"
import { strictRecord } from "../inputs/strict-record"

const legFields = z
  .object({
    app: refName,
    environment: refName,
    project: z.string().min(1),
    image: imageName,
    /** `<environment>-<sha40>`, the tag pushed to ghcr and set on the Coolify resource. */
    tag: z.string().regex(/^[a-z0-9-]+-[0-9a-f]{40}$/),
    dockerfile: z.string().min(1),
    context: z.string().min(1),
    platform: z.enum(PLATFORMS),
    runner: z.enum(Object.values(RUNNER_BY_PLATFORM)),
    prebuild: z.string().min(1).optional(),
    secrets: z.array(z.enum(BUILD_SECRETS)),
    buildArgs: strictRecord(buildArgName, z.string()),
    coolify: coolifyId,
    health: healthCheck.optional(),
    reason: z.string(),
  })
  .strict()

const runnerMatchesPlatform = (leg: z.infer<typeof legFields>): boolean =>
  leg.runner === RUNNER_BY_PLATFORM[leg.platform]
const runnerIssue = { path: ["runner"], message: "does not run the platform" }

/** One image build (and, for a release, one deploy) of one app into one environment. */
export const legSchema = legFields.refine(runnerMatchesPlatform, runnerIssue)

/** A pull request build: no push; the Coolify resources of every environment are checked read-only. */
export const buildLegSchema = legFields
  .extend({ preflight: z.array(coolifyId) })
  .refine(runnerMatchesPlatform, runnerIssue)

export type Leg = z.infer<typeof legSchema>
export type BuildLeg = z.infer<typeof buildLegSchema>

/** Reads the `LEG_JSON` the plan job hands to a deploy step. */
export function parseLeg(json: string): Leg {
  return legSchema.parse(JSON.parse(json))
}

/** Reads the `LEG_JSON` the plan job hands to a pull request preflight. */
export function parseBuildLeg(json: string): BuildLeg {
  return buildLegSchema.parse(JSON.parse(json))
}
