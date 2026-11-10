import { setTimeout } from "node:timers/promises"
import * as core from "@actions/core"
import { parsePostgresInput } from "../inputs/pipeline-inputs"
import { runCommand } from "../lib/run-command"
import { startPostgres } from "./postgres"

// 60 checks 2 s apart: postgres:18-alpine is healthy in ~3 s on a runner; one minute is a starting guess.
const ATTEMPTS = 60
const INTERVAL_MS = 2000

try {
  const service = parsePostgresInput(process.env["POSTGRES"] ?? "")
  if (service === undefined) throw new Error("POSTGRES is empty")
  await startPostgres(service, {
    runCommand: (command) => runCommand(command),
    sleep: (ms) => setTimeout(ms),
    attempts: ATTEMPTS,
    intervalMs: INTERVAL_MS,
  })
  core.info(`postgres ${service.image} healthy on port ${service.port}`)
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
