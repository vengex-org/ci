import { requireEnv } from "../lib/require-env"
import type { Trigger } from "./plan"

/** Narrows the GitHub event context in `env` to the {@link Trigger} the plan decides on. */
export function readTrigger(env: Record<string, string | undefined>): Trigger {
  const event = requireEnv("GITHUB_EVENT_NAME", env)
  switch (event) {
    case "pull_request":
      return { event, sameRepo: requireEnv("SAME_REPO", env) === "true" }
    case "push":
      return { event, ref: requireEnv("GITHUB_REF", env) }
    case "workflow_dispatch":
      return {
        event,
        ref: requireEnv("GITHUB_REF", env),
        environment: requireEnv("DISPATCH_ENVIRONMENT", env),
      }
    default:
      throw new Error(`unsupported event ${event}`)
  }
}
