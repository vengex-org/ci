import type { PostgresService } from "../inputs/pipeline-inputs"

export type PostgresDeps = {
  runCommand: (command: [string, ...string[]]) => Promise<string>
  sleep: (ms: number) => Promise<void>
  attempts: number
  intervalMs: number
}

const CONTAINER = "ci-postgres"

/** Starts the checks' Postgres in Docker and resolves once its healthcheck passes. */
export async function startPostgres(service: PostgresService, deps: PostgresDeps): Promise<void> {
  await deps.runCommand([
    "docker",
    "run",
    "--detach",
    "--name",
    CONTAINER,
    "--env",
    `POSTGRES_USER=${service.user}`,
    "--env",
    `POSTGRES_PASSWORD=${service.password}`,
    "--env",
    `POSTGRES_DB=${service.db}`,
    "--publish",
    `${service.port}:5432`,
    "--health-cmd",
    `pg_isready -U ${service.user}`,
    "--health-interval",
    "2s",
    service.image,
  ])
  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    const status = (
      await deps.runCommand([
        "docker",
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        CONTAINER,
      ])
    ).trim()
    if (status === "healthy") return
    if (status === "unhealthy") throw new Error("postgres container is unhealthy")
    await deps.sleep(deps.intervalMs)
  }
  throw new Error(`postgres not healthy after ${deps.attempts} checks`)
}
