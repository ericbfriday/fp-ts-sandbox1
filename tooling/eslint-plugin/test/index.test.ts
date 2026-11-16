import plugin from "@friday-friday/eslint-plugin"
import { describe, expect, it } from "vitest"

describe("@friday-friday/eslint-plugin skeleton", () => {
  it("exposes plugin meta and a rules map", () => {
    expect(plugin.meta?.name).toBe("@friday-friday/eslint-plugin")
    expect(Object.keys(plugin.rules ?? {}).sort()).toEqual([
      "must-use-result",
      "no-instanceof-tagged-error",
      "no-try-around-redirect"
    ])
  })
})
