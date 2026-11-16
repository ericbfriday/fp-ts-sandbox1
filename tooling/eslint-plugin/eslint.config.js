// ESLint runs ONLY the local custom rules (ADR-0003); Oxlint owns everything else.
// typescript-eslint needs the classic TS compiler API (peer typescript <6.1), so this
// package pins typescript ~6.0 for its type-aware program while the repo builds on TS 7.
import tseslint from "typescript-eslint"
import friday from "./src/index.ts"

export default [
  {
    files: ["packages/*/src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "@friday-friday": friday },
    // Rules are enabled here as they land in #8, e.g. "@friday-friday/must-use-result": "error".
    rules: {}
  }
]
