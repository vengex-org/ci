export type DeployedTag = { environment: string; app: string; sha: string }

const DEPLOYED_REF = /^refs\/tags\/deployed\/([^/]+)\/([^/]+)$/

/**
 * The `exclude-tags` input of dataaxiom/ghcr-cleanup-action in its default wildcard mode (comma list):
 * the images that must survive cleanup because they are, or may still be, deployed. Wildcards, not
 * regex, so the list grows with deployed tags without hitting the action's regex length check.
 */
export function buildExcludeTags(deployed: DeployedTag[]): string {
  if (deployed.length === 0) {
    throw new Error("no deployed tags found: cleanup would be free to delete live images")
  }
  const deployedTags = new Set(deployed.map(({ environment, sha }) => `${environment}-${sha}`))
  // The legacy tags `staging`, `production`, `latest` can go once they have aged out of ghcr.
  return ["buildcache-*", "staging", "production", "latest", ...deployedTags].join(",")
}

/**
 * Parses the output of `git for-each-ref refs/tags/deployed/` with a format that prints
 * `<commit sha>\t<refname>` per tag: the peeled `%(*objectname)` of an annotated tag, else the
 * `%(objectname)` of a lightweight one.
 * Tags of the older `deployed/<app>` layout carry no environment and are not read.
 */
export function parseDeployedTags(tagLines: string): DeployedTag[] {
  const deployed: DeployedTag[] = []
  for (const line of tagLines.split("\n")) {
    if (line.trim() === "") continue
    const [sha, ref, ...rest] = line.split("\t")
    if (sha === undefined || ref === undefined || rest.length > 0 || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`unexpected deployed tag line: ${line}`)
    }
    const [, environment, app] = DEPLOYED_REF.exec(ref) ?? []
    if (environment === undefined || app === undefined) continue
    deployed.push({ environment, app, sha })
  }
  return deployed
}
