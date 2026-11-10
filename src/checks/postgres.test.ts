import { describe, expect, test } from "bun:test"
import { failureOf } from "../lib/failure-of"
import { startPostgres } from "./postgres"

const service = {
  image: "postgres:18-alpine",
  user: "vengex",
  password: "secret",
  db: "vengex",
  port: 5433,
}

function fakeDocker(healthSequence: string[]) {
  const calls: string[][] = []
  const statuses = [...healthSequence]
  return {
    calls,
    deps: {
      runCommand: async (command: [string, ...string[]]) => {
        calls.push(command)
        if (command[1] === "inspect") return `${statuses.shift() ?? "starting"}\n`
        return "container-id\n"
      },
      sleep: async () => {},
      attempts: 5,
      intervalMs: 1,
    },
  }
}

describe("startPostgres", () => {
  test("runs the image with the service's credentials on its port and waits until healthy", async () => {
    const docker = fakeDocker(["starting", "healthy"])

    await startPostgres(service, docker.deps)

    expect(docker.calls[0]).toEqual([
      "docker",
      "run",
      "--detach",
      "--name",
      "ci-postgres",
      "--env",
      "POSTGRES_USER=vengex",
      "--env",
      "POSTGRES_PASSWORD=secret",
      "--env",
      "POSTGRES_DB=vengex",
      "--publish",
      "5433:5432",
      "--health-cmd",
      "pg_isready -U vengex",
      "--health-interval",
      "2s",
      "postgres:18-alpine",
    ])
    expect(docker.calls.filter((command) => command[1] === "inspect")).toHaveLength(2)
  })

  test("fails when the database never turns healthy within the attempts", async () => {
    const docker = fakeDocker([])

    expect(await failureOf(startPostgres(service, docker.deps))).toMatch(
      /not healthy after 5 checks/,
    )
  })

  test("fails at once when the container reports unhealthy", async () => {
    const docker = fakeDocker(["unhealthy"])

    expect(await failureOf(startPostgres(service, docker.deps))).toMatch(/unhealthy/)
    expect(docker.calls.filter((command) => command[1] === "inspect")).toHaveLength(1)
  })
})
