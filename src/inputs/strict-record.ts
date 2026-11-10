import { z } from "zod"

/**
 * `z.record` that rejects keys failing `key`. Plain `z.record` silently drops `__proto__`, so a
 * misnamed environment or build arg would vanish instead of failing.
 */
export const strictRecord = <V extends z.ZodType>(key: z.ZodString, value: V) =>
  z
    .custom<Record<string, unknown>>(
      (input) => typeof input === "object" && input !== null && !Array.isArray(input),
      "expected an object",
    )
    .superRefine((input, ctx) => {
      for (const name of Object.keys(input)) {
        if (!key.safeParse(name).success) {
          ctx.addIssue({ code: "custom", path: [name], message: `invalid key "${name}"` })
        }
      }
    })
    .pipe(z.record(key, value))
