import { describe, expect, test } from "bun:test"
import { failureOf } from "../lib/failure-of"
import { type CommandRunner, gitDeps } from "./git-deps"

const HEAD = "1".repeat(40)
const DEPLOYED = "a".repeat(40)

/** `checks` answers `runCheck` and `outputs` answers `runCommand`, each in call order. */
function runner(answers: { checks?: boolean[]; outputs?: string[] }) {
  const commands: string[] = []
  const checks = [...(answers.checks ?? [])]
  const outputs = [...(answers.outputs ?? [])]
  const fake: CommandRunner = {
    runCommand: async (command) => {
      commands.push(command.join(" "))
      return outputs.shift() ?? ""
    },
    runCheck: async (command) => {
      commands.push(command.join(" "))
      return checks.shift() ?? false
    },
  }
  return { fake, commands }
}

describe("gitDeps", () => {
  test("reads the commit a deployed tag points to", async () => {
    const { fake, commands } = runner({ checks: [true], outputs: [`${DEPLOYED}\n`] })

    expect(await gitDeps(HEAD, fake).deployedCommit("staging", "api")).toBe(DEPLOYED)
    expect(commands).toEqual([
      "git rev-parse -q --verify refs/tags/deployed/staging/api^{commit}",
      "git rev-parse -q --verify refs/tags/deployed/staging/api^{commit}",
    ])
  })

  test("returns undefined when the deployed tag does not exist", async () => {
    const { fake, commands } = runner({ checks: [false] })

    expect(await gitDeps(HEAD, fake).deployedCommit("staging", "api")).toBeUndefined()
    expect(commands).toHaveLength(1)
  })

  test("asks git whether one commit is an ancestor of another", async () => {
    const { fake, commands } = runner({ checks: [true, false] })
    const deps = gitDeps(HEAD, fake)

    expect(await deps.isAncestor(DEPLOYED, HEAD)).toBe(true)
    expect(await deps.isAncestor(HEAD, DEPLOYED)).toBe(false)
    expect(commands).toEqual([
      `git merge-base --is-ancestor ${DEPLOYED} ${HEAD}`,
      `git merge-base --is-ancestor ${HEAD} ${DEPLOYED}`,
    ])
  })

  test("asks Nx once per base and reuses the answer for every project", async () => {
    const otherBase = "b".repeat(40)
    const { fake, commands } = runner({ outputs: ['["api"]', '["web"]'] })
    const deps = gitDeps(HEAD, fake)

    expect(await deps.isAffectedSince(DEPLOYED, "api")).toBe(true)
    expect(await deps.isAffectedSince(DEPLOYED, "web")).toBe(false)
    expect(commands).toEqual([
      `bunx nx show projects --affected --base ${DEPLOYED} --head ${HEAD} --json`,
    ])

    expect(await deps.isAffectedSince(otherBase, "web")).toBe(true)
    expect(commands).toHaveLength(2)
  })

  test("rejects Nx output that is not a list of project names", async () => {
    const { fake } = runner({ outputs: ['{"api":true}'] })

    const failure = await failureOf(gitDeps(HEAD, fake).isAffectedSince(DEPLOYED, "api"))

    expect(failure).not.toBe("resolved without throwing")
  })
})
