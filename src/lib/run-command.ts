/** Runs a command without a shell and returns its stdout; a non-zero exit throws with stderr. */
export async function runCommand(
  command: [string, ...string[]],
  options: { cwd?: string } = {},
): Promise<string> {
  const child = Bun.spawn(command, { ...cwdOption(options), stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`command failed: ${command[0]}`, {
      cause: { command: commandName(command), exitCode, stderr: stderr.trim() },
    })
  }
  return stdout
}

/** Like {@link runCommand}, but an exit code 1 means "no" instead of an error (`git merge-base --is-ancestor`). */
export async function runCheck(
  command: [string, ...string[]],
  options: { cwd?: string } = {},
): Promise<boolean> {
  const child = Bun.spawn(command, { ...cwdOption(options), stdout: "ignore", stderr: "pipe" })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (exitCode === 0) return true
  if (exitCode === 1) return false
  throw new Error(`command failed: ${command[0]}`, {
    cause: { command: commandName(command), exitCode, stderr: stderr.trim() },
  })
}

/** The program and subcommand only: later arguments can carry credentials (`POSTGRES_PASSWORD=`). */
function commandName(command: [string, ...string[]]): string {
  return command.slice(0, 2).join(" ")
}

function cwdOption(options: { cwd?: string }): { cwd?: string } {
  return options.cwd === undefined ? {} : { cwd: options.cwd }
}
