import * as core from "@actions/core"
import { readDeployables } from "../inputs/deploy-metadata"
import { parsePipelineInputs } from "../inputs/pipeline-inputs"
import { fail } from "../lib/fail"
import { requireEnv } from "../lib/require-env"
import { runCheck, runCommand } from "../lib/run-command"
import { gitDeps, projectNames } from "./git-deps"
import { type Plan, planRun } from "./plan"
import { readTrigger } from "./trigger"

const INPUT_ENV_BY_KEY = {
  environments: "PIPELINE_INPUT_ENVIRONMENTS",
  postgres: "PIPELINE_INPUT_POSTGRES",
  "coolify-url": "PIPELINE_INPUT_COOLIFY_URL",
  "checks-timeout": "PIPELINE_INPUT_CHECKS_TIMEOUT",
  "wait-timeout": "PIPELINE_INPUT_WAIT_TIMEOUT",
  "build-timeout": "PIPELINE_INPUT_BUILD_TIMEOUT",
  "deploy-timeout": "PIPELINE_INPUT_DEPLOY_TIMEOUT",
  "release-timeout": "PIPELINE_INPUT_RELEASE_TIMEOUT",
} as const

try {
  await main()
} catch (error) {
  fail(error)
}

async function main(): Promise<void> {
  const sha = requireEnv("GITHUB_SHA", process.env)
  const inputs = parsePipelineInputs(
    Object.fromEntries(
      Object.entries(INPUT_ENV_BY_KEY).map(([key, name]) => [key, requireEnv(name, process.env)]),
    ),
  )
  const graph: unknown = await Bun.file(requireEnv("NX_GRAPH_FILE", process.env)).json()
  const affected: unknown = JSON.parse(requireEnv("NX_AFFECTED_JSON", process.env))
  const plan = await planRun(
    {
      trigger: readTrigger(process.env),
      sha,
      environments: inputs.environments,
      deployables: readDeployables(graph),
      affected: projectNames.parse(affected),
    },
    gitDeps(sha, { runCommand, runCheck }),
  )
  await report(plan)
}

async function report(plan: Plan): Promise<void> {
  core.setOutput("build", JSON.stringify(plan.build))
  core.setOutput("release", JSON.stringify(plan.release))
  core.setOutput("has-build", String(plan.build.length > 0))
  core.setOutput("has-release", String(plan.release.length > 0))
  for (const warning of plan.warnings) core.warning(warning)

  const header = ["Action", "App", "Environment", "Reason"].map((data) => ({ data, header: true }))
  await core.summary
    .addHeading("Deploy plan")
    .addTable([
      header,
      ...plan.build.map((leg) => ["build", leg.app, leg.environment, leg.reason]),
      ...plan.release.map((leg) => ["release", leg.app, leg.environment, leg.reason]),
      ...plan.skipped.map((skipped) => ["skip", skipped.app, skipped.environment, skipped.cause]),
    ])
    .write()
}
