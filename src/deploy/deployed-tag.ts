import type { HttpFetch } from "./http-fetch"

/**
 * Points `deployed/<environment>/<app>` at `sha`, creating the tag on the first deploy. The tag
 * moves through the REST API, not `git push`: a push from a shallow checkout sends a pack, and
 * GitHub once refused one with "missing necessary objects"; moving a ref to a commit the server
 * already has sends no objects.
 */
export async function moveDeployedTag(
  input: { repo: string; environment: string; app: string; sha: string; token: string },
  fetch: HttpFetch,
): Promise<void> {
  const { repo, environment, app, sha, token } = input
  const tag = `deployed/${environment}/${app}`
  const update = await github(
    token,
    "PATCH",
    `/repos/${repo}/git/refs/tags/${tag}`,
    { sha, force: true },
    fetch,
  )

  if (update.ok) return
  if (!(await isMissingRef(update))) throw await githubError("PATCH", update)

  const create = await github(
    token,
    "POST",
    `/repos/${repo}/git/refs`,
    { ref: `refs/tags/${tag}`, sha },
    fetch,
  )
  if (!create.ok) throw await githubError("POST", create)
}

/** GitHub answers an update of a missing ref with 404, or with 422 "Reference does not exist". */
async function isMissingRef(response: Response): Promise<boolean> {
  if (response.status === 404) return true
  if (response.status !== 422) return false
  return /reference does not exist/i.test(await response.clone().text())
}

async function github(
  token: string,
  method: string,
  path: string,
  body: object,
  fetch: HttpFetch,
): Promise<Response> {
  return await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify(body),
  })
}

async function githubError(method: string, response: Response): Promise<Error> {
  return new Error(`github answered ${response.status} to ${method} of the deployed tag`, {
    cause: { status: response.status, body: (await response.text()).slice(0, 500) },
  })
}
