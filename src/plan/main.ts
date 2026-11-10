import * as core from "@actions/core"
import { z } from "zod"
import { readDeployables } from "../inputs/deploy-metadata"
import { parsePipelineInputs } from "../inputs/pipeline-inputs"
import { runCheck, runCommand } from "../lib/run-command"
import { type Plan, type PlanDeps, type Trigger, planRun } from "./plan"

const INPUT_ENV_BY_KEY = {
  environments: "PIPELINE_INPUT_ENVIRONMENTS",
  postgres: "PIPELINE_INPUT_POSTGRES",
  "checks-timeout": "PIPELINE_INPUT_CHECKS_TIMEOUT",
  "wait-timeout": "PIPELINE_INPUT_WAIT_TIMEOUT",
  "build-timeout": "PIPELINE_INPUT_BUILD_TIMEOUT",
  "deploy-timeout": "PIPELINE_INPUT_DEPLOY_TIMEOUT",
  "release-timeout": "PIPELINE_INPUT_RELEASE_TIMEOUT",
} as const

const projectNames = z.array(z.string())

try {
  await main()
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function main(): Promise<void> {
  const sha = requireEnv("GITHUB_SHA")
  const inputs = parsePipelineInputs(
    Object.fromEntries(
      Object.entries(INPUT_ENV_BY_KEY).map(([key, name]) => [key, requireEnv(name)]),
    ),
  )
  const graph: unknown = await Bun.file(requireEnv("NX_GRAPH_FILE")).json()
  const affected: unknown = JSON.parse(requireEnv("NX_AFFECTED_JSON"))
  const plan = await planRun(
    {
      trigger: readTrigger(),
      sha,
      environments: inputs.environments,
      deployables: readDeployables(graph),
      affected: projectNames.parse(affected),
    },
    gitDeps(sha),
  )
  await report(plan)
}

function readTrigger(): Trigger {
  const event = requireEnv("GITHUB_EVENT_NAME")
  switch (event) {
    case "pull_request":
      return { event, sameRepo: requireEnv("SAME_REPO") === "true" }
    case "push":
      return { event, ref: requireEnv("GITHUB_REF") }
    case "workflow_dispatch":
      return {
        event,
        ref: requireEnv("GITHUB_REF"),
        environment: requireEnv("DISPATCH_ENVIRONMENT"),
      }
    default:
      throw new Error(`unsupported event ${event}`)
  }
}

function gitDeps(sha: string): PlanDeps {
  const affectedByBase = new Map<string, Promise<Set<string>>>()
  return {
    async deployedCommit(environment, app) {
      const command: [string, ...string[]] = [
        "git",
        "rev-parse",
        "-q",
        "--verify",
        `refs/tags/deployed/${environment}/${app}^{commit}`,
      ]
      return (await runCheck(command)) ? (await runCommand(command)).trim() : undefined
    },
    isAncestor: (ancestor, descendant) =>
      runCheck(["git", "merge-base", "--is-ancestor", ancestor, descendant]),
    async isAffectedSince(base, project) {
      const affected = affectedByBase.get(base) ?? affectedProjects(base, sha)
      affectedByBase.set(base, affected)
      return (await affected).has(project)
    },
  }
}

async function affectedProjects(base: string, head: string): Promise<Set<string>> {
  const output = await runCommand([
    "bunx",
    "nx",
    "show",
    "projects",
    "--affected",
    "--base",
    base,
    "--head",
    head,
    "--json",
  ])
  const projects: unknown = JSON.parse(output)
  return new Set(projectNames.parse(projects))
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

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined) throw new Error(`environment variable ${name} is not set`)
  return value
}
