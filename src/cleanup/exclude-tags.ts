export type DeployedTag = { environment: string; app: string; sha: string }

const DEPLOYED_REF = /^refs\/tags\/deployed\/([^/]+)\/([^/]+?)(\^\{\})?$/

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
 * Parses `git ls-remote --tags origin 'refs/tags/deployed/*'` (`<sha>\trefs/tags/deployed/<env>/<app>`).
 * An annotated tag lists its own object and a peeled `^{}` line with the commit; the commit wins.
 * Tags of the older `deployed/<app>` layout carry no environment and are not read.
 */
export function parseDeployedTags(lsRemoteOutput: string): DeployedTag[] {
  const byTag = new Map<string, DeployedTag & { peeled: boolean }>()
  for (const line of lsRemoteOutput.split("\n")) {
    if (line.trim() === "") continue
    const [sha, ref, ...rest] = line.split("\t")
    if (sha === undefined || ref === undefined || rest.length > 0 || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`unexpected deployed tag line: ${line}`)
    }
    const match = DEPLOYED_REF.exec(ref)
    if (match === null) continue
    const [, environment, app, peeledMarker] = match
    if (environment === undefined || app === undefined) continue
    const key = `${environment}/${app}`
    const peeled = peeledMarker !== undefined
    if (byTag.get(key)?.peeled === true && !peeled) continue
    byTag.set(key, { environment, app, sha, peeled })
  }
  return [...byTag.values()].map(({ environment, app, sha }) => ({ environment, app, sha }))
}
