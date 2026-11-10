# vengex-org/ci

Shared GitHub Actions for the vengex Nx + bun monorepos. One reusable workflow checks the affected
projects and deploys the affected apps to Coolify. A second one deletes old images from ghcr.

This repository is public because repositories in other organizations call it. It holds no
secrets: callers pass their own.

## Pipeline

```yaml
# .github/workflows/ci.yml in a consumer repo
name: CI
on:
  pull_request:
  push:
    branches: [master]
  workflow_dispatch:
    inputs:
      environment:
        description: Environment to redeploy from master
        type: string
        required: true

concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  pipeline:
    uses: vengex-org/ci/.github/workflows/nx-pipeline.yml@v1
    permissions:
      contents: write
      packages: write
      actions: read
    with:
      environments: '{"staging":"auto","production":"manual"}'
      dispatch-environment: ${{ inputs.environment }}
      coolify-url: https://coolify.example.com
      postgres: '{"image":"postgres:18-alpine","user":"postgres","password":"postgres","db":"postgres","port":5432}'
      setup: tools/ci-setup.sh
    secrets:
      PACKAGES_TOKEN: ${{ secrets.VENGEX_PACKAGES_TOKEN }}
      COOLIFY_READ_TOKEN: ${{ secrets.COOLIFY_READ_TOKEN }}
```

`COOLIFY_TOKEN` and `SENTRY_AUTH_TOKEN` are not passed here. The `release` job runs in the deploy
environment and reads them from that environment's secrets.

What one run does:

- `prepare` finds the affected Nx projects. The base is the last green run on master, or the merge
  base for a pull request. With no green run yet, every project counts as affected. It then plans
  which apps to build and deploy.
- `pipeline-checks` runs `inputs.targets` (default `lint format:check typecheck test build`) on the
  affected projects. Repo-specific checks belong in Nx targets, so the workflow stays the same in
  every repo.
- `build` runs for pull requests from the same repository. It builds the image of every affected
  app without pushing it, and checks the app's Coolify resources with a read-only token.
- `release` runs for a push to master or a dispatch on master. It builds the image on a native
  runner and waits for this run's `pipeline-checks` job. Once the checks pass, it pushes
  `<image>:<env>-<sha>`, deploy it to Coolify, wait for the result and the health check, and move
  the git tag `deployed/<env>/<app>`.

Environments:

- `auto`: a push to master deploys the apps changed since `deployed/<env>/<app>`.
- `manual`: only a `workflow_dispatch` on master deploys. A dispatch always rebuilds and
  redeploys every app of the named environment. Use it after changing a repository variable that
  is baked into an image.

A fork pull request gets no secrets, so it builds no image. A deploy is never cancelled halfway.

Inputs are listed with their defaults in `.github/workflows/nx-pipeline.yml`. The timeouts must
nest: `wait-timeout` must be greater than `checks-timeout`, and `release-timeout` must be at least
`build + wait + deploy`. `prepare` fails when they do not.

## Deployable apps

An app is deployable when its `project.json` declares `metadata.deploy`. Adding an app means adding
this block, with no workflow change:

```json
{
  "metadata": {
    "deploy": {
      "name": "web",
      "image": "ghcr.io/vengex-org/example-web",
      "dockerfile": "apps/web/Dockerfile",
      "context": ".",
      "platform": "linux/arm64",
      "prebuild": "@example/query:generate",
      "secrets": ["packages", "sentry"],
      "environments": {
        "staging": {
          "coolify": "<coolify application uuid>",
          "buildArgs": { "VITE_SERVER_URL": "${vars.STAGING_SERVER_URL}" },
          "health": { "url": "https://staging.example.com/health", "commit": true }
        }
      }
    }
  }
}
```

- `name` is the app's name in tags and logs, matching `[a-z0-9-]+`.
- `platform` is either `linux/arm64` or `linux/amd64`. It is built on the matching native runner,
  never with QEMU.
- `prebuild` is an Nx target run on the runner before `docker build`.
- `secrets` lists the BuildKit secrets the Dockerfile mounts:
  - `packages` is mounted as `vengex_packages_token`.
  - `sentry` is mounted as `sentry_auth_token`. Pull request builds do not mount it, so the
    Dockerfile must treat it as optional and skip the upload without it.
- Every build gets the build args `BUN_VERSION` (from `packageManager`), `ENVIRONMENT` and
  `GIT_COMMIT`. `${vars.NAME}` reads a repository variable. Never put a secret there: build
  args end up in the image and the logs.
- With `health.commit: true`, the response body must contain the deployed commit as `"commit"`.

## Before the first run

- Every deploy environment exists under Settings > Environments, and its deployment branches are
  limited to `master`.
- `COOLIFY_TOKEN` and `SENTRY_AUTH_TOKEN` exist only as environment secrets. Delete any
  repository-level copy: a pull request run can read repository secrets.
- `PACKAGES_TOKEN` is a read-only token for the `@vengex-org` packages. Pull requests from the
  repository run their own install scripts and Nx targets with it, so it must not grant more.
- `COOLIFY_READ_TOKEN` is a repository secret holding a read-only Coolify token. Without it, the
  pull request preflight is skipped with a warning.
- Each Coolify resource is a Docker Image application whose image name equals `image`.

## Image cleanup

```yaml
# .github/workflows/ghcr-cleanup.yml in a consumer repo
on:
  schedule:
    - cron: "0 3 * * 1"
  workflow_dispatch:
jobs:
  cleanup:
    uses: vengex-org/ci/.github/workflows/ghcr-cleanup.yml@v1
    permissions:
      contents: read
      packages: write
    secrets:
      PACKAGES_TOKEN: ${{ secrets.VENGEX_PACKAGES_TOKEN }}
```

- Untagged images are deleted after 1 day.
- Tagged images older than 30 days are deleted, but the newest 10 per package are always kept.
- These images are never deleted:
  - `buildcache-*` tags.
  - The old `staging`, `production` and `latest` tags.
  - Every image a `deployed/<env>/<app>` tag points to.
- With no deployed tag at all the run fails, since it cannot tell which images are live.
- Each package must grant the repository Admin under "Manage Actions access".
- Run with `dry-run: true` first.

## Versions

Callers use `@v1`, a tag that moves with every compatible release. Every release also has a fixed
`v1.x.y` tag. To pin a commit instead, use the commit SHA of a release.
