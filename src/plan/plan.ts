import {
  type Deployable,
  type EnvironmentDeploy,
  RUNNER_BY_PLATFORM,
} from "../inputs/deploy-metadata"
import type { EnvironmentTrigger } from "../inputs/pipeline-inputs"
import type { BuildLeg, Leg } from "./leg"

/** The event that started the run, narrowed from the GitHub context. */
export type Trigger =
  | { event: "pull_request"; sameRepo: boolean }
  | { event: "push"; ref: string }
  | { event: "workflow_dispatch"; ref: string; environment: string }

export type Skip = { app: string; environment: string; cause: string }

export type Plan = { build: BuildLeg[]; release: Leg[]; skipped: Skip[]; warnings: string[] }

export type PlanInput = {
  trigger: Trigger
  sha: string
  environments: Record<string, EnvironmentTrigger>
  deployables: Deployable[]
  /** Nx projects affected by this run's change (nx-set-shas base), used for pull requests. */
  affected: string[]
}

export type PlanDeps = {
  /** The commit `deployed/<environment>/<app>` points to, or undefined when the tag does not exist. */
  deployedCommit: (environment: string, app: string) => Promise<string | undefined>
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>
  /** Whether the Nx project changed between `base` and the run's commit. */
  isAffectedSince: (base: string, project: string) => Promise<boolean>
}

export const MASTER_REF = "refs/heads/master"

/** Decides which apps are built, and which are released into which environment, for one run. */
export async function planRun(input: PlanInput, deps: PlanDeps): Promise<Plan> {
  const declarations = declarationsOf(input)
  const plan: Plan = { build: [], release: [], skipped: [], warnings: [] }
  switch (input.trigger.event) {
    case "pull_request":
      planPullRequest(input, declarations, input.trigger.sameRepo, plan)
      break
    case "push":
      await planPush(input, declarations, input.trigger.ref, deps, plan)
      break
    case "workflow_dispatch":
      planDispatch(input, declarations, input.trigger, plan)
      break
  }
  return plan
}

/** One environment an app declares, in `input.environments` key order. */
type Declaration = {
  deployable: Deployable
  environment: string
  trigger: EnvironmentTrigger
  entry: EnvironmentDeploy
}

function declarationsOf(input: PlanInput): Declaration[] {
  for (const { project, deploy } of input.deployables) {
    for (const environment of Object.keys(deploy.environments)) {
      if (!Object.hasOwn(input.environments, environment)) {
        throw new Error(
          `${project} declares environment ${environment}, which is not in the environments input`,
        )
      }
    }
  }
  return Object.entries(input.environments).flatMap(([environment, trigger]) =>
    input.deployables.flatMap((deployable) => {
      const entry = new Map(Object.entries(deployable.deploy.environments)).get(environment)
      return entry === undefined ? [] : [{ deployable, environment, trigger, entry }]
    }),
  )
}

function planPullRequest(
  input: PlanInput,
  declarations: Declaration[],
  sameRepo: boolean,
  plan: Plan,
): void {
  if (!sameRepo) {
    plan.skipped.push(
      ...declarations.map((declaration) => skip(declaration, "fork pull request: no secrets")),
    )
    return
  }
  for (const deployable of input.deployables) {
    if (!input.affected.includes(deployable.project)) continue
    const own = declarations.filter((declaration) => declaration.deployable === deployable)
    const target = own.find((declaration) => declaration.trigger === "auto") ?? own.at(0)
    if (target === undefined) continue
    plan.build.push({
      ...leg(target, input.sha, "pull request build"),
      preflight: own.map((declaration) => declaration.entry.coolify),
    })
  }
}

async function planPush(
  input: PlanInput,
  declarations: Declaration[],
  ref: string,
  deps: PlanDeps,
  plan: Plan,
): Promise<void> {
  if (ref !== MASTER_REF) {
    plan.skipped.push(...declarations.map((declaration) => skip(declaration, "not master")))
    return
  }
  for (const declaration of declarations) {
    switch (declaration.trigger) {
      case "manual":
        plan.skipped.push(skip(declaration, "manual environment: deployed by workflow_dispatch"))
        break
      case "auto":
        await planAutoPush(declaration, input.sha, deps, plan)
        break
    }
  }
}

async function planAutoPush(
  declaration: Declaration,
  sha: string,
  deps: PlanDeps,
  plan: Plan,
): Promise<void> {
  const { environment, deployable } = declaration
  const { name } = deployable.deploy
  const tagName = `deployed/${environment}/${name}`
  const commit = await deps.deployedCommit(environment, name)
  if (commit === undefined) {
    return releaseWithWarning(declaration, sha, `no ${tagName} tag, deploying`, plan)
  }
  if (await deps.isAncestor(sha, commit)) {
    plan.skipped.push(skip(declaration, `${tagName} is already at or past this commit`))
    return
  }
  if (!(await deps.isAncestor(commit, sha))) {
    return releaseWithWarning(declaration, sha, `${tagName} is not an ancestor, deploying`, plan)
  }
  const since = commit.slice(0, 7)
  if (await deps.isAffectedSince(commit, deployable.project)) {
    plan.release.push(leg(declaration, sha, `changed since ${since}`))
  } else {
    plan.skipped.push(skip(declaration, `unchanged since ${since}`))
  }
}

function planDispatch(
  input: PlanInput,
  declarations: Declaration[],
  trigger: { ref: string; environment: string },
  plan: Plan,
): void {
  if (trigger.ref !== MASTER_REF) throw new Error("workflow_dispatch deploys only master")
  if (!Object.hasOwn(input.environments, trigger.environment)) {
    throw new Error(
      `workflow_dispatch environment ${trigger.environment} is not in the environments input`,
    )
  }
  for (const declaration of declarations) {
    if (declaration.environment === trigger.environment) {
      plan.release.push(leg(declaration, input.sha, "manual dispatch"))
    }
  }
}

function releaseWithWarning(
  declaration: Declaration,
  sha: string,
  warning: string,
  plan: Plan,
): void {
  plan.warnings.push(warning)
  plan.release.push(leg(declaration, sha, warning))
}

function skip({ deployable, environment }: Declaration, cause: string): Skip {
  return { app: deployable.deploy.name, environment, cause }
}

function leg({ deployable, environment, entry }: Declaration, sha: string, reason: string): Leg {
  const { deploy, project } = deployable
  return {
    app: deploy.name,
    environment,
    project,
    image: deploy.image,
    tag: `${environment}-${sha}`,
    dockerfile: deploy.dockerfile,
    context: deploy.context,
    platform: deploy.platform,
    runner: RUNNER_BY_PLATFORM[deploy.platform],
    prebuild: deploy.prebuild,
    secrets: deploy.secrets,
    buildArgs: entry.buildArgs,
    coolify: entry.coolify,
    health: entry.health,
    reason,
  }
}
