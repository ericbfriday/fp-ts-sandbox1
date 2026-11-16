import plugin from "@friday-friday/eslint-plugin"
import { describe, expect, it } from "vitest"

describe("@friday-friday/eslint-plugin skeleton", () => {
  it("exposes plugin meta and a rules map", () => {
    expect(plugin.meta?.name).toBe("@friday-friday/eslint-plugin")
    expect(plugin.rules).toEqual({})
  })

  // Rules arrive in #8, each with a typescript-eslint RuleTester suite.
  it.todo("must-use-result")
  it.todo("no-try-around-redirect")
  it.todo("no-instanceof-tagged-error")
})
