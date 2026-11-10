import { describe, expect, test } from "bun:test"
import { parsePipelineInputs } from "./pipeline-inputs"

const raw = {
  environments: '{"staging":"auto","production":"manual"}',
  postgres: "",
  "coolify-url": "https://coolify.example.com",
  "checks-timeout": "30",
  "wait-timeout": "35",
  "build-timeout": "15",
  "deploy-timeout": "15",
  "release-timeout": "70",
}

describe("parsePipelineInputs", () => {
  test("parses environments and timeouts", () => {
    expect(parsePipelineInputs(raw)).toEqual({
      environments: { staging: "auto", production: "manual" },
      postgres: undefined,
      coolifyUrl: "https://coolify.example.com",
      timeouts: { checks: 30, wait: 35, build: 15, deploy: 15, release: 70 },
    })
  })

  test("accepts a repo with no deploy environments and no coolify url", () => {
    const inputs = parsePipelineInputs({ ...raw, environments: "{}", "coolify-url": "" })

    expect(inputs.environments).toEqual({})
    expect(inputs.coolifyUrl).toBeUndefined()
  })

  test("requires the coolify url once an environment is declared", () => {
    expect(() => parsePipelineInputs({ ...raw, "coolify-url": "" })).toThrow(/coolify-url/)
  })

  test.each(["http://coolify.example.com", "coolify.example.com", " "])(
    "rejects coolify url %p",
    (value) => {
      expect(() => parsePipelineInputs({ ...raw, "coolify-url": value })).toThrow(/coolify-url/)
    },
  )

  test("parses the postgres service as one object", () => {
    const inputs = parsePipelineInputs({
      ...raw,
      postgres:
        '{"image":"postgres:18-alpine","user":"vengex","password":"vengex","db":"vengex","port":5433}',
    })

    expect(inputs.postgres).toEqual({
      image: "postgres:18-alpine",
      user: "vengex",
      password: "vengex",
      db: "vengex",
      port: 5433,
    })
  })

  test("rejects an environment trigger other than auto or manual", () => {
    expect(() => parsePipelineInputs({ ...raw, environments: '{"staging":"always"}' })).toThrow(
      /staging/,
    )
  })

  test("rejects an environment name that would break a git ref", () => {
    expect(() => parsePipelineInputs({ ...raw, environments: '{"../prod":"auto"}' })).toThrow(
      /environments/,
    )
  })

  test("rejects an environment name that is a prototype key", () => {
    expect(() => parsePipelineInputs({ ...raw, environments: '{"__proto__":"auto"}' })).toThrow(
      /environments/,
    )
  })

  test("rejects environments that are not JSON", () => {
    expect(() => parsePipelineInputs({ ...raw, environments: "staging=auto" })).toThrow(
      /environments/,
    )
  })

  test("rejects a wait shorter than the checks job it waits for", () => {
    expect(() => parsePipelineInputs({ ...raw, "wait-timeout": "30" })).toThrow(/wait-timeout/)
  })

  test("rejects a release job shorter than build + wait + deploy", () => {
    expect(() => parsePipelineInputs({ ...raw, "release-timeout": "64" })).toThrow(
      /release-timeout/,
    )
  })

  test.each(["0", "-5", "1.5", "NaN", "Infinity", ""])("rejects timeout %p", (value) => {
    expect(() => parsePipelineInputs({ ...raw, "checks-timeout": value })).toThrow(/checks-timeout/)
  })

  test("rejects a postgres port outside 1-65535", () => {
    const postgres =
      '{"image":"postgres:18-alpine","user":"u","password":"p","db":"d","port":70000}'

    expect(() => parsePipelineInputs({ ...raw, postgres })).toThrow(/postgres/)
  })
})
