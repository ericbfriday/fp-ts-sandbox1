import { defineConfig, type UserConfig } from "tsdown"

// ADR-0002: ESM-only, .d.ts via isolatedDeclarations. Three entries:
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
  treeshake: true,
  // #65: nothing from node_modules may be inlined (tsdown fails the build instead of hinting).
  // `@standard-schema/spec` was inlined into index.d.ts while it was a devDependency; it is a
  // dependency now, as in schema, so consumers share one StandardSchemaV1.
  deps: { onlyBundle: [] }
})

export default config
