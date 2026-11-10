import { describe, expect, test } from "bun:test"
import { type DeployMetadata, RUNNER_BY_PLATFORM, readDeployables } from "./deploy-metadata"

const validDeploy = {
  name: "lounge-web",
  image: "ghcr.io/vengex-org/axman-lounge-web",
  dockerfile: "projects/lounge/apps/web/Dockerfile",
  context: ".",
  platform: "linux/amd64",
  secrets: ["packages", "sentry"],
  environments: {
    staging: {
      coolify: "gccw0cscggosw0os4gk8wg04",
      buildArgs: { VITE_SERVER_URL: "${vars.STAGING_SERVER_URL}" },
      health: { url: "https://staging.axman.sk/health", commit: true },
    },
  },
} satisfies DeployMetadata

function graphWith(nodes: Record<string, unknown>) {
  return {
    graph: {
      nodes: Object.fromEntries(
        Object.entries(nodes).map(([project, metadata]) => [project, { data: { metadata } }]),
      ),
    },
  }
}

describe("readDeployables", () => {
  test("returns every project that declares metadata.deploy, with its project name", () => {
    const deployables = readDeployables(
      graphWith({ "@axman/lounge-web": { deploy: validDeploy }, "@axman/ui": {} }),
    )

    expect(deployables).toEqual([
      {
        project: "@axman/lounge-web",
        deploy: {
          ...validDeploy,
          environments: { staging: { ...validDeploy.environments.staging } },
        },
      },
    ])
  })

  test("returns nothing for a workspace without deployable projects", () => {
    expect(readDeployables(graphWith({ "@vengex-org/xml": {} }))).toEqual([])
  })

  test("rejects an app name that is not a plain git ref segment, naming project and field", () => {
    const graph = graphWith({
      "@axman/lounge-web": { deploy: { ...validDeploy, name: "@axman/lounge-web" } },
    })

    expect(() => readDeployables(graph)).toThrow(/@axman\/lounge-web.*name/s)
  })

  test("rejects an environment name outside [a-z0-9-]", () => {
    const graph = graphWith({
      "@axman/lounge-web": {
        deploy: { ...validDeploy, environments: { "Staging/x": validDeploy.environments.staging } },
      },
    })

    expect(() => readDeployables(graph)).toThrow(/environments/)
  })

  test("rejects a platform without a native runner", () => {
    const graph = graphWith({
      "@axman/lounge-web": { deploy: { ...validDeploy, platform: "linux/arm/v7" } },
    })

    expect(() => readDeployables(graph)).toThrow(/platform/)
  })

  test("rejects an image outside ghcr.io", () => {
    const graph = graphWith({
      "@axman/lounge-web": { deploy: { ...validDeploy, image: "docker.io/x/y" } },
    })

    expect(() => readDeployables(graph)).toThrow(/image/)
  })

  test("rejects a build arg name a shell could misread", () => {
    const graph = graphWith({
      "@axman/lounge-web": {
        deploy: {
          ...validDeploy,
          environments: { staging: { coolify: "x", buildArgs: { "A;rm -rf": "1" } } },
        },
      },
    })

    expect(() => readDeployables(graph)).toThrow(/buildArgs/)
  })

  test("rejects a deploy block without environments", () => {
    const graph = graphWith({
      "@axman/lounge-web": { deploy: { ...validDeploy, environments: {} } },
    })

    expect(() => readDeployables(graph)).toThrow(/environments/)
  })

  test("rejects an unknown key so a typo does not silently drop a setting", () => {
    const graph = graphWith({
      "@axman/lounge-web": { deploy: { ...validDeploy, dockerFile: "x" } },
    })

    expect(() => readDeployables(graph)).toThrow(/dockerFile/)
  })
})

describe("RUNNER_BY_PLATFORM", () => {
  test("builds arm64 on the arm runner and amd64 on the x64 runner", () => {
    expect(RUNNER_BY_PLATFORM).toEqual({
      "linux/arm64": "ubuntu-24.04-arm",
      "linux/amd64": "ubuntu-latest",
    })
  })
})
