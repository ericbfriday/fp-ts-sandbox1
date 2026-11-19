import { defineConfig, type UserConfig } from "tsdown"

// ADR-0002: ESM-only, .d.ts via isolatedDeclarations.
const config: UserConfig = defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "es2024",
  dts: true,
  fixedExtension: false,
  clean: true,
  treeshake: true
})

export default config
