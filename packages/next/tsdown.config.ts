import { defineConfig, type UserConfig } from "tsdown"

// ADR-0002: ESM-only, .d.ts via isolatedDeclarations. Two entries:
// - index.js     -> the react-server condition (server helpers)
// - client.js    -> the /client subpath (client-only boundary)
// - server-only-stub.js -> the default condition (throws outside react-server)
const config: UserConfig = defineConfig({
  entry: ["src/index.ts", "src/client.ts", "src/server-only-stub.ts"],
  format: "esm",
  platform: "neutral",
  target: "es2024",
  dts: true,
  fixedExtension: false,
  clean: true,
  treeshake: true
})

export default config
