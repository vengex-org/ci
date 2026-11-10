import { z } from "zod"
import { refName } from "./ref-name"
import { strictRecord } from "./strict-record"

export const ENVIRONMENT_TRIGGERS = ["auto", "manual"] as const
export type EnvironmentTrigger = (typeof ENVIRONMENT_TRIGGERS)[number]

const minutes = z.coerce.number().int().positive()

const jsonInput = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .transform((text, ctx) => {
      try {
        const value: unknown = JSON.parse(text)
        return value
      } catch {
        ctx.addIssue({ code: "custom", message: "not JSON" })
        return z.NEVER
      }
    })
    .pipe(schema)

const postgresSchema = z
  .object({
    image: z.string().regex(/^postgres:[a-z0-9.-]+$/),
    user: refName,
    password: z.string().min(1),
    db: refName,
    port: z.number().int().min(1).max(65535),
  })
  .strict()

const postgresInputSchema = z.union([
  z.literal("").transform(() => undefined),
  jsonInput(postgresSchema),
])

const rawInputsSchema = z
  .object({
    environments: jsonInput(strictRecord(refName, z.enum(ENVIRONMENT_TRIGGERS))),
    postgres: postgresInputSchema,
    "checks-timeout": minutes,
    "wait-timeout": minutes,
    "build-timeout": minutes,
    "deploy-timeout": minutes,
    "release-timeout": minutes,
  })
  .superRefine((inputs, ctx) => {
    if (inputs["wait-timeout"] <= inputs["checks-timeout"]) {
      ctx.addIssue({
        code: "custom",
        path: ["wait-timeout"],
        message: "must exceed checks-timeout, or a slow green check fails the push",
      })
    }
    const legs = inputs["build-timeout"] + inputs["wait-timeout"] + inputs["deploy-timeout"]
    if (inputs["release-timeout"] < legs) {
      ctx.addIssue({
        code: "custom",
        path: ["release-timeout"],
        message: `must be at least build + wait + deploy (${legs})`,
      })
    }
  })

export type PostgresService = z.infer<typeof postgresSchema>
export type PipelineInputs = {
  environments: Record<string, EnvironmentTrigger>
  postgres: PostgresService | undefined
  timeouts: { checks: number; wait: number; build: number; deploy: number; release: number }
}

/** Parses the reusable workflow's string inputs once; everything past this takes the narrowed type. */
export function parsePipelineInputs(raw: Record<string, string>): PipelineInputs {
  const parsed = rawInputsSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`invalid workflow inputs\n${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    })
  }
  const inputs = parsed.data
  return {
    environments: inputs.environments,
    postgres: inputs.postgres,
    timeouts: {
      checks: inputs["checks-timeout"],
      wait: inputs["wait-timeout"],
      build: inputs["build-timeout"],
      deploy: inputs["deploy-timeout"],
      release: inputs["release-timeout"],
    },
  }
}

/** The `postgres` input alone, for the checks job that starts the database. */
export function parsePostgresInput(text: string): PostgresService | undefined {
  const parsed = postgresInputSchema.safeParse(text)
  if (!parsed.success) {
    throw new Error(
      `invalid postgres input
${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    )
  }
  return parsed.data
}
