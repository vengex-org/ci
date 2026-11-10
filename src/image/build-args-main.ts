import * as core from "@actions/core"
import { z } from "zod"
import { fail } from "../lib/fail"
import { parseBuildLeg, parseLeg } from "../plan/leg"
import { readBunVersion, resolveBuildArgs } from "./build-args"

try {
  const env = z
    .object({
      LEG_KIND: z.enum(["build", "release"]),
      LEG_JSON: z.string().min(1),
      REPO_VARS_JSON: z.string().min(1),
      GITHUB_SHA: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .parse(process.env)
  const vars: unknown = JSON.parse(env.REPO_VARS_JSON)
  const packageJson: unknown = await Bun.file("./package.json").json()

  core.setOutput(
    "build-args",
    resolveBuildArgs({
      leg: env.LEG_KIND === "build" ? parseBuildLeg(env.LEG_JSON) : parseLeg(env.LEG_JSON),
      vars: z.record(z.string(), z.string()).parse(vars),
      sha: env.GITHUB_SHA,
      bunVersion: readBunVersion(packageJson),
    }),
  )
} catch (error) {
  fail(error)
}
