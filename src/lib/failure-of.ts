/** The message a promise rejects with, for asserting on failures in tests. */
export async function failureOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return "resolved without throwing"
}
