import { describe, expect, test } from "bun:test"
import type { Deployable, Platform } from "../inputs/deploy-metadata"
import { MASTER_REF, type Plan, type PlanDeps, type PlanInput, type Trigger, planRun } from "./plan"

const SHA = "1111111111111111111111111111111111111111"
const DEPLOYED = "abcdef1234567890abcdef1234567890abcdef12"

/** `coolify` maps each declared environment to its Coolify resource uuid. */
function deployable(
  project: string,
  coolify: Record<string, string>,
  platform: Platform = "linux/amd64",
): Deployable {
  return {
    project,
    deploy: {
      name: `${project}-app`,
      image: `ghcr.io/org/${project}`,
      dockerfile: `${project}/Dockerfile`,
      context: project,
      platform,
      prebuild: "bun run codegen",
      secrets: ["packages"],
      environments: Object.fromEntries(
        Object.entries(coolify).map(([environment, uuid]) => [
          environment,
          {
            coolify: uuid,
            buildArgs: { API_URL: environment },
            health: { url: `https://${environment}.example.com/health`, commit: true },
          },
        ]),
      ),
    },
  }
}

function input(overrides: Partial<PlanInput> & { trigger: Trigger }): PlanInput {
  return {
    sha: SHA,
    environments: { staging: "auto", production: "manual" },
    deployables: [deployable("api", { staging: "stg1", production: "prd1" })],
    affected: [],
    ...overrides,
  }
}

function deps(overrides: Partial<PlanDeps> = {}): PlanDeps {
  return {
    deployedCommit: async () => undefined,
    isAncestor: async () => false,
    isAffectedSince: async () => false,
    ...overrides,
  }
}

function ancestry(pairs: [ancestor: string, descendant: string][]): PlanDeps["isAncestor"] {
  return async (ancestor, descendant) => pairs.some(([a, d]) => a === ancestor && d === descendant)
}

const push: Trigger = { event: "push", ref: MASTER_REF }

function causes(plan: Plan): string[] {
  return plan.skipped.map((skipped) => `${skipped.environment}/${skipped.app}: ${skipped.cause}`)
}

describe("pull request from a fork", () => {
  test("builds nothing and skips every deployable environment without secrets", async () => {
    const plan = await planRun(
      input({
        trigger: { event: "pull_request", sameRepo: false },
        affected: ["api"],
      }),
      deps(),
    )

    expect(plan.build).toEqual([])
    expect(plan.release).toEqual([])
    expect(causes(plan)).toEqual([
      "staging/api-app: fork pull request: no secrets",
      "production/api-app: fork pull request: no secrets",
    ])
  })
})

describe("pull request in the same repository", () => {
  const trigger: Trigger = { event: "pull_request", sameRepo: true }

  test("builds only affected deployables and lists the unaffected nowhere", async () => {
    const plan = await planRun(
      input({
        trigger,
        deployables: [
          deployable("api", { staging: "stg1" }),
          deployable("web", { staging: "stg2" }),
        ],
        affected: ["web"],
      }),
      deps(),
    )

    expect(plan.build.map((leg) => leg.project)).toEqual(["web"])
    expect(plan.skipped).toEqual([])
    expect(plan.release).toEqual([])
  })

  test("targets the first auto environment even when a manual one comes first", async () => {
    const plan = await planRun(
      input({
        trigger,
        environments: { production: "manual", staging: "auto" },
        affected: ["api"],
      }),
      deps(),
    )

    expect(plan.build.map((leg) => leg.environment)).toEqual(["staging"])
  })

  test("targets the first declared environment when the app declares no auto one", async () => {
    const plan = await planRun(
      input({
        trigger,
        environments: { staging: "auto", qa: "manual", production: "manual" },
        deployables: [deployable("api", { production: "prd1", qa: "qa1" })],
        affected: ["api"],
      }),
      deps(),
    )

    expect(plan.build.map((leg) => leg.environment)).toEqual(["qa"])
  })

  test("preflights the coolify uuid of every declared environment with the pull request reason", async () => {
    const plan = await planRun(
      input({
        trigger,
        environments: { staging: "auto", qa: "manual", production: "manual" },
        deployables: [deployable("api", { production: "prd1", staging: "stg1" })],
        affected: ["api"],
      }),
      deps(),
    )

    expect(plan.build.map((leg) => ({ preflight: leg.preflight, reason: leg.reason }))).toEqual([
      { preflight: ["stg1", "prd1"], reason: "pull request build" },
    ])
  })
})

describe("push", () => {
  test("skips every deployable environment when the ref is not master", async () => {
    const plan = await planRun(
      input({ trigger: { event: "push", ref: "refs/heads/feature" } }),
      deps({ deployedCommit: async () => DEPLOYED }),
    )

    expect(plan.release).toEqual([])
    expect(causes(plan)).toEqual(["staging/api-app: not master", "production/api-app: not master"])
  })

  test("skips manual environments with the dispatch cause and never asks for their tag", async () => {
    const asked: string[] = []
    const plan = await planRun(
      input({ trigger: push }),
      deps({
        deployedCommit: async (environment) => {
          asked.push(environment)
          return DEPLOYED
        },
      }),
    )

    expect(causes(plan)).toContain(
      "production/api-app: manual environment: deployed by workflow_dispatch",
    )
    expect(asked).toEqual(["staging"])
  })

  test("releases with a warning when the deployed tag does not exist", async () => {
    const plan = await planRun(
      input({ trigger: push }),
      deps({ deployedCommit: async () => undefined }),
    )

    expect(plan.release.map((leg) => leg.environment)).toEqual(["staging"])
    expect(plan.release[0]?.reason).toBe("no deployed/staging/api-app tag, deploying")
    expect(plan.warnings).toEqual(["no deployed/staging/api-app tag, deploying"])
  })

  test("skips when the deployed commit already contains this commit", async () => {
    const plan = await planRun(
      input({ trigger: push }),
      deps({
        deployedCommit: async () => DEPLOYED,
        isAncestor: ancestry([[SHA, DEPLOYED]]),
        isAffectedSince: async () => true,
      }),
    )

    expect(plan.release).toEqual([])
    expect(causes(plan)).toContain(
      "staging/api-app: deployed/staging/api-app is already at or past this commit",
    )
  })

  test("releases with a warning when the deployed commit is not an ancestor", async () => {
    const plan = await planRun(
      input({ trigger: push }),
      deps({ deployedCommit: async () => DEPLOYED, isAncestor: ancestry([]) }),
    )

    expect(plan.release.map((leg) => leg.reason)).toEqual([
      "deployed/staging/api-app is not an ancestor, deploying",
    ])
    expect(plan.warnings).toEqual(["deployed/staging/api-app is not an ancestor, deploying"])
  })

  test("releases with the short deployed commit when the project changed since it", async () => {
    const asked: [string, string][] = []
    const plan = await planRun(
      input({ trigger: push }),
      deps({
        deployedCommit: async () => DEPLOYED,
        isAncestor: ancestry([[DEPLOYED, SHA]]),
        isAffectedSince: async (base, project) => {
          asked.push([base, project])
          return true
        },
      }),
    )

    expect(plan.release.map((leg) => leg.reason)).toEqual(["changed since abcdef1"])
    expect(plan.warnings).toEqual([])
    expect(asked).toEqual([[DEPLOYED, "api"]])
  })

  test("skips with the short deployed commit when the project is unchanged since it", async () => {
    const plan = await planRun(
      input({ trigger: push }),
      deps({
        deployedCommit: async () => DEPLOYED,
        isAncestor: ancestry([[DEPLOYED, SHA]]),
        isAffectedSince: async () => false,
      }),
    )

    expect(plan.release).toEqual([])
    expect(causes(plan)).toContain("staging/api-app: unchanged since abcdef1")
  })

  test("decides each auto environment of each deployable on its own tag", async () => {
    const plan = await planRun(
      input({
        trigger: push,
        environments: { staging: "auto", canary: "auto" },
        deployables: [
          deployable("api", { staging: "stg1", canary: "can1" }),
          deployable("web", { staging: "stg2" }),
        ],
      }),
      deps({
        deployedCommit: async (environment, app) =>
          environment === "canary" && app === "api-app" ? DEPLOYED : undefined,
        isAncestor: ancestry([[DEPLOYED, SHA]]),
      }),
    )

    expect(plan.release.map((leg) => `${leg.environment}/${leg.app}`)).toEqual([
      "staging/api-app",
      "staging/web-app",
    ])
    expect(plan.warnings).toEqual([
      "no deployed/staging/api-app tag, deploying",
      "no deployed/staging/web-app tag, deploying",
    ])
    expect(causes(plan)).toEqual(["canary/api-app: unchanged since abcdef1"])
  })
})

describe("workflow dispatch", () => {
  const dispatch: Trigger = {
    event: "workflow_dispatch",
    ref: MASTER_REF,
    environment: "production",
  }

  test("rejects a ref other than master", () => {
    return expect(
      planRun(input({ trigger: { ...dispatch, ref: "refs/heads/feature" } }), deps()),
    ).rejects.toThrow("workflow_dispatch deploys only master")
  })

  test("rejects an environment missing from the environments input and names it", () => {
    return expect(
      planRun(input({ trigger: { ...dispatch, environment: "preview" } }), deps()),
    ).rejects.toThrow("preview")
  })

  test("rejects a prototype key as environment", () => {
    return expect(
      planRun(input({ trigger: { ...dispatch, environment: "constructor" } }), deps()),
    ).rejects.toThrow("constructor")
  })

  test("releases every deployable declaring the environment and no other environment", async () => {
    const plan = await planRun(
      input({
        trigger: dispatch,
        deployables: [
          deployable("api", { staging: "stg1", production: "prd1" }),
          deployable("web", { staging: "stg2" }),
          deployable("worker", { production: "prd3" }),
        ],
      }),
      deps({ deployedCommit: async () => DEPLOYED, isAncestor: ancestry([[SHA, DEPLOYED]]) }),
    )

    expect(plan.release.map((leg) => `${leg.environment}/${leg.app}/${leg.reason}`)).toEqual([
      "production/api-app/manual dispatch",
      "production/worker-app/manual dispatch",
    ])
    expect(plan.build).toEqual([])
  })
})

describe("deployable declaring an unknown environment", () => {
  test.each<Trigger>([
    { event: "pull_request", sameRepo: true },
    push,
    { event: "workflow_dispatch", ref: MASTER_REF, environment: "staging" },
  ])("throws naming the project and the environment on $event", (trigger) => {
    return expect(
      planRun(
        input({ trigger, deployables: [deployable("api", { staging: "stg1", preview: "pre1" })] }),
        deps(),
      ),
    ).rejects.toThrow("api declares environment preview")
  })
})

describe("leg fields", () => {
  test("come from the deploy metadata and the environment entry", async () => {
    const plan = await planRun(
      input({ trigger: { event: "workflow_dispatch", ref: MASTER_REF, environment: "staging" } }),
      deps(),
    )

    expect(plan.release).toEqual([
      {
        app: "api-app",
        environment: "staging",
        project: "api",
        image: "ghcr.io/org/api",
        tag: `staging-${SHA}`,
        dockerfile: "api/Dockerfile",
        context: "api",
        platform: "linux/amd64",
        runner: "ubuntu-latest",
        prebuild: "bun run codegen",
        secrets: ["packages"],
        buildArgs: { API_URL: "staging" },
        coolify: "stg1",
        health: { url: "https://staging.example.com/health", commit: true },
        reason: "manual dispatch",
      },
    ])
  })

  test("pick the runner of an arm64 platform", async () => {
    const plan = await planRun(
      input({
        trigger: { event: "workflow_dispatch", ref: MASTER_REF, environment: "staging" },
        deployables: [deployable("api", { staging: "stg1" }, "linux/arm64")],
      }),
      deps(),
    )

    expect(plan.release.map((leg) => leg.runner)).toEqual(["ubuntu-24.04-arm"])
  })
})
