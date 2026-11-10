import { z } from "zod"

/** An environment or app name: one segment of the `deployed/<env>/<app>` git tag and a shell-safe word. */
export const refName = z.string().regex(/^[a-z0-9-]+$/)
