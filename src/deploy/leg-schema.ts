import { z } from "zod"
import { BUILD_SECRETS, PLATFORMS, RUNNER_BY_PLATFORM } from "../inputs/deploy-metadata"
import type { BuildLeg, Leg } from "../plan/plan"

const legObject = z
  .object({
    app: z.string(),
    environment: z.string(),
    project: z.string(),
    image: z.string().min(1),
    tag: z.string().min(1),
    dockerfile: z.string(),
    context: z.string(),
    platform: z.enum(PLATFORMS),
    runner: z.enum(Object.values(RUNNER_BY_PLATFORM)),
    prebuild: z.string().or(z.undefined()),
    secrets: z.array(z.enum(BUILD_SECRETS)),
    buildArgs: z.record(z.string(), z.string()),
    coolify: z.string().min(1),
    health: z.object({ url: z.string(), commit: z.boolean() }).strict().or(z.undefined()),
    reason: z.string(),
  })
  .strict()

/** JSON has no `undefined`: a missing `prebuild` or `health` key is the same as `undefined`. */
const withOptionalKeys = (input: unknown): unknown =>
  typeof input === "object" && input !== null
    ? { prebuild: undefined, health: undefined, ...input }
    : input

const legSchema = z.preprocess(withOptionalKeys, legObject) satisfies z.ZodType<Leg>

const buildLegSchema = z.preprocess(
  withOptionalKeys,
  legObject.extend({ preflight: z.array(z.string()) }),
) satisfies z.ZodType<BuildLeg>

/** Reads the `LEG_JSON` the plan job hands to a deploy step. */
export function parseLeg(json: string): Leg {
  return legSchema.parse(JSON.parse(json))
}

/** Reads the `LEG_JSON` the plan job hands to a pull request preflight. */
export function parseBuildLeg(json: string): BuildLeg {
  return buildLegSchema.parse(JSON.parse(json))
}
