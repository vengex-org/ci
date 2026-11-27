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
        type: choice
        options: [staging, production]
        required: true

concurrency:
  # The event is part of the group, so a push never replaces a pending production dispatch.
  group: ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}
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
      # Only runs on master (push or dispatch) deploy; pull requests and other refs get no deploy token.
      COOLIFY_TOKEN: ${{ github.ref == 'refs/heads/master' && secrets.COOLIFY_TOKEN || '' }}
      SENTRY_AUTH_TOKEN: ${{ github.ref == 'refs/heads/master' && secrets.SENTRY_AUTH_TOKEN || '' }}
```

The deploy tokens have to be repository secrets. A job of a workflow called from another repository
cannot read the caller's environment secrets, so they cannot be scoped to an environment. The
`release` job uses them only for pushes and dispatches on master, and the caller above does not
pass them to pull request runs. Anyone who can open a pull request in the repository could still change the
calling workflow to read them, as with any repository secret.

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

Inputs are listed with their defaults in `.github/workflows/nx-pipeline.yml`. The caller's `permissions` are the most any job may get: each job of the pipeline asks only for
what it needs, so a pull request run never writes. A dispatch from a branch other than master fails
in `prepare`. The timeouts must
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
- `PACKAGES_TOKEN` is a read-only token for the `@vengex-org` packages. Pull requests from the
  repository run their own install scripts and Nx targets with it, so it must not grant more.
- `COOLIFY_READ_TOKEN` is a repository secret holding a read-only Coolify token. Without it, the
  pull request preflight is skipped with a warning.
- Each Coolify resource is a Docker Image application whose image name equals `image`.

## Runners

`prepare` and `pipeline-checks` (and both jobs of the image cleanup) run on `ubuntu-latest` unless
the caller's repository sets the Actions variable `RUNNER` to a runner label, e.g. `gaming-pc`. It has
to be a repository variable: an organization variable does not reach these workflows when another
repository calls them. While the variable is set and no such runner is online, these jobs wait in the queue
(GitHub cancels them after 24 hours) and nothing after them runs, so unset the variable before the
machine goes offline; the next run then uses GitHub-hosted runners.

`build` and `release` run on the native runner of the app's platform (`ubuntu-24.04-arm` for
`linux/arm64`, `ubuntu-latest` for `linux/amd64`) unless the caller's repository sets the Actions
variable `BUILD_RUNNER`, again a repository variable. When it is set, both jobs run on that label and
set up QEMU first, so an x64 machine can build `linux/arm64` images. An emulated build is several
times slower than a native one, so raise `build-timeout` and `release-timeout` to match. With
`BUILD_RUNNER` set, the release runs as the job `release-after-checks`, which starts only after
`pipeline-checks` passed instead of building while the checks run. Release jobs that waited on the
runners would otherwise keep the checks queued when both variables name the same machine.

A self-hosted runner needs Docker for the Postgres the checks start, published on its `localhost`.
When it mounts `/nx`, `actions/setup` keeps the Nx cache and workspace data in
`/nx/<owner>/<repo>/`, so later runs read unchanged targets from the cache. Every job that runs there,
pull requests included, writes to that cache, so give such a runner only to repositories whose
pull requests come from people with write access. With `BUILD_RUNNER`, `build` also runs a pull
request's own Dockerfile on that machine, which has QEMU registered in its kernel. `release`
builds its `prebuild` without the Nx cache, so nothing a pull request wrote reaches a pushed image.

On a self-hosted runner `build` and `release` set `DOCKER_CONFIG` to the job's temp directory, so
jobs running side by side on one machine keep their buildx builder and ghcr login apart. Docker's
CLI plugins must then be installed system wide or in `~/.docker/cli-plugins`, which the job links
in. Each job removes its builder at the end; layers come from the registry build cache on the next
run. QEMU stays registered on the machine.

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
