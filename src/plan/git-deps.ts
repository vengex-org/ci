import { z } from "zod"
import type { PlanDeps } from "./plan"

export const projectNames = z.array(z.string())

type Command = [string, ...string[]]

/** The two ways to run a command that {@link gitDeps} needs: `runCommand` and `runCheck` of lib/run-command. */
export type CommandRunner = {
  runCommand: (command: Command) => Promise<string>
  runCheck: (command: Command) => Promise<boolean>
}

/** Answers the plan's questions about deployed tags, ancestry and affected projects from git and Nx. */
export function gitDeps(head: string, runner: CommandRunner): PlanDeps {
  const affectedByBase = new Map<string, Promise<Set<string>>>()
  return {
    async deployedCommit(environment, app) {
      const command: Command = [
        "git",
        "rev-parse",
        "-q",
        "--verify",
        `refs/tags/deployed/${environment}/${app}^{commit}`,
      ]
      return (await runner.runCheck(command))
        ? (await runner.runCommand(command)).trim()
        : undefined
    },
    isAncestor: (ancestor, descendant) =>
      runner.runCheck(["git", "merge-base", "--is-ancestor", ancestor, descendant]),
    async isAffectedSince(base, project) {
      const affected = affectedByBase.get(base) ?? affectedProjects(base, head, runner)
      affectedByBase.set(base, affected)
      return (await affected).has(project)
    },
  }
}

async function affectedProjects(
  base: string,
  head: string,
  runner: CommandRunner,
): Promise<Set<string>> {
  const output = await runner.runCommand([
    "bunx",
    "nx",
    "show",
    "projects",
    "--affected",
    "--base",
    base,
    "--head",
    head,
    "--json",
  ])
  const projects: unknown = JSON.parse(output)
  return new Set(projectNames.parse(projects))
}
