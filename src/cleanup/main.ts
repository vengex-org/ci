import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as core from "@actions/core"
import { readDeployables } from "../inputs/deploy-metadata"
import { fail } from "../lib/fail"
import { runCommand } from "../lib/run-command"
import { buildExcludeTags, parseDeployedTags } from "./exclude-tags"
import { legacyTagWarning } from "./legacy-tags"

try {
  // `<commit sha>, a tab, <refname>` per tag, read from the full clone.
  const tagLines = await runCommand([
    "git",
    "for-each-ref",
    "--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%09%(refname)",
    "refs/tags/deployed/",
  ])
  const legacyWarning = legacyTagWarning(tagLines)
  if (legacyWarning !== undefined) core.warning(legacyWarning)
  const excludeTags = buildExcludeTags(parseDeployedTags(tagLines))
  const packages = [
    ...new Set(
      readDeployables(await readProjectGraph()).map(({ deploy }) =>
        deploy.image.slice(deploy.image.lastIndexOf("/") + 1),
      ),
    ),
  ]
  if (packages.length === 0)
    throw new Error("no project declares metadata.deploy, nothing to clean")

  core.setOutput("exclude-tags", excludeTags)
  core.setOutput("packages", JSON.stringify(packages))
  await core.summary
    .addHeading("ghcr cleanup")
    .addRaw(`Packages: ${packages.join(", ")}`, true)
    .addRaw(`Excluded tags: ${excludeTags}`, true)
    .write()
} catch (error) {
  fail(error)
}

async function readProjectGraph(): Promise<unknown> {
  const tmp = await mkdtemp(join(tmpdir(), "nx-graph-"))
  try {
    const file = join(tmp, "graph.json")
    await runCommand(["bunx", "nx", "graph", `--file=${file}`])
    const graph: unknown = JSON.parse(await readFile(file, "utf8"))
    return graph
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
