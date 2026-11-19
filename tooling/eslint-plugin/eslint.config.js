// ESLint runs ONLY the local custom rules (ADR-0003); Oxlint owns everything else.
// typescript-eslint needs the classic TS compiler API (peer typescript <6.1), so this
// package pins typescript ~6.0 for its type-aware program while the repo builds on TS 7.
import tseslint from "typescript-eslint"
import friday from "./src/index.ts"

export default [
  // `next build` output in examples/ (gitignored, but ESLint does not read .gitignore).
  { ignores: ["**/.next/**", "**/next-env.d.ts"] },
  {
    // App code too: the redirect trap lives where apps call next/navigation (issue #43).
    files: ["packages/*/src/**/*.ts", "examples/*/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "@friday-friday": friday },
    rules: {
      "@friday-friday/must-use-result": "error",
      "@friday-friday/no-try-around-redirect": "error",
      "@friday-friday/no-instanceof-tagged-error": "error"
    }
  }
]
