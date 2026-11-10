import { z } from "zod"
import type { Leg } from "../plan/leg"

export type BuildArgsInput = {
  leg: Pick<Leg, "environment" | "buildArgs">
  /** The caller's repository variables, `toJSON(vars)` parsed. */
  vars: Record<string, string>
  sha: string
  bunVersion: string
}

const BUILT_IN_ARGS = ["BUN_VERSION", "ENVIRONMENT", "GIT_COMMIT"]
const VARS_PLACEHOLDER = /\$\{vars\.([A-Z_][A-Z0-9_]*)\}/g

const packageManagerSchema = z.object({ packageManager: z.string().regex(/^bun@\d+\.\d+\.\d+$/) })

/** Renders the `build-args` input of docker/build-push-action: one `KEY=value` per line. */
export function resolveBuildArgs({ leg, vars, sha, bunVersion }: BuildArgsInput): string {
  const entries: [string, string][] = [
    ["BUN_VERSION", bunVersion],
    ["ENVIRONMENT", leg.environment],
    ["GIT_COMMIT", sha],
  ]
  for (const [name, template] of Object.entries(leg.buildArgs)) {
    if (BUILT_IN_ARGS.includes(name)) throw new Error(`build arg ${name} is set by the pipeline`)
    entries.push([name, substituteVars(name, template, vars)])
  }
  return entries
    .map(([name, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`build arg ${name} resolves to a multi-line value`)
      return `${name}=${value}`
    })
    .join("\n")
}

/** Reads the bun version from the `packageManager: "bun@x.y.z"` field of the root package.json. */
export function readBunVersion(packageJson: unknown): string {
  const parsed = packageManagerSchema.safeParse(packageJson)
  if (!parsed.success)
    throw new Error("package.json packageManager must be bun@<x.y.z>", { cause: parsed.error })
  return parsed.data.packageManager.slice("bun@".length)
}

function substituteVars(argName: string, template: string, vars: Record<string, string>): string {
  if (template.replace(VARS_PLACEHOLDER, "").includes("${")) {
    throw new Error(`build arg ${argName} has a \${...} sequence other than \${vars.NAME}`)
  }
  return template.replace(VARS_PLACEHOLDER, (_match, varName: string) => {
    const value = vars[varName]
    if (value === undefined)
      throw new Error(`build arg ${argName} uses missing repository variable ${varName}`)
    return value
  })
}
