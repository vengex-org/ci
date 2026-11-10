import { z } from "zod"
import { refName } from "./ref-name"
import { strictRecord } from "./strict-record"

export const PLATFORMS = ["linux/arm64", "linux/amd64"] as const
export type Platform = (typeof PLATFORMS)[number]

export const RUNNER_BY_PLATFORM = {
  "linux/arm64": "ubuntu-24.04-arm",
  "linux/amd64": "ubuntu-latest",
} as const satisfies Record<Platform, string>

/** BuildKit secrets an image may mount; the workflow maps each to its secret id and token. */
export const BUILD_SECRETS = ["packages", "sentry"] as const
export type BuildSecret = (typeof BUILD_SECRETS)[number]

const environmentDeploySchema = z
  .object({
    coolify: z.string().regex(/^[a-z0-9]+$/),
    buildArgs: strictRecord(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
    health: z
      .object({ url: z.url({ protocol: /^https$/ }), commit: z.boolean() })
      .strict()
      .optional(),
  })
  .strict()

const deployMetadataSchema = z
  .object({
    name: refName,
    image: z.string().regex(/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._-]+$/),
    dockerfile: z.string().min(1),
    context: z.string().min(1),
    platform: z.enum(PLATFORMS),
    prebuild: z.string().min(1).optional(),
    secrets: z.array(z.enum(BUILD_SECRETS)),
    environments: strictRecord(refName, environmentDeploySchema).refine(
      (environments) => Object.keys(environments).length > 0,
      "at least one environment",
    ),
  })
  .strict()

export type DeployMetadata = z.infer<typeof deployMetadataSchema>
export type EnvironmentDeploy = z.infer<typeof environmentDeploySchema>
export type Deployable = { project: string; deploy: DeployMetadata }

const projectGraphSchema = z.object({
  graph: z.object({
    nodes: z.record(
      z.string(),
      z.object({
        data: z.object({ metadata: z.object({ deploy: z.unknown() }).partial().optional() }),
      }),
    ),
  }),
})

/** Reads `metadata.deploy` of every project from `nx graph --file` output. */
export function readDeployables(graphJson: unknown): Deployable[] {
  const { nodes } = projectGraphSchema.parse(graphJson).graph
  return Object.entries(nodes).flatMap(([project, node]) => {
    const deploy = node.data.metadata?.deploy
    if (deploy === undefined) return []
    const parsed = deployMetadataSchema.safeParse(deploy)
    if (!parsed.success) {
      throw new Error(`${project}: invalid metadata.deploy\n${z.prettifyError(parsed.error)}`, {
        cause: parsed.error,
      })
    }
    return [{ project, deploy: parsed.data }]
  })
}
