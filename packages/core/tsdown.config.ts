import { defineConfig, type UserConfig } from "tsdown"

// ADR-0002: ESM-only, .d.ts via isolatedDeclarations (oxc transformer, no TS compiler API).
const config: UserConfig = defineConfig({
  entry: ["src/index.ts", "src/async.ts", "src/gen.ts", "src/wire.ts"],
  format: "esm",
  platform: "neutral",
  target: "es2024",
  dts: true,
  fixedExtension: false,
  clean: true,
  treeshake: true
})

export default config
