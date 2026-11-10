export function requireEnv(name: string, env: Record<string, string | undefined>): string {
  const value = env[name]
  if (value === undefined) throw new Error(`environment variable ${name} is not set`)
  return value
}
