import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import prettierConfig from "eslint-config-prettier";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-unused-vars": "off",
      // Flags a genuinely empty block (including `catch {}`) - a block
      // containing only a comment is NOT flagged (ESLint's own default
      // behavior), which is exactly the pattern used anywhere an error is
      // deliberately, explicitly ignored (e.g. check-transactions.ts's
      // disposable-collection cleanup). Zero violations as of this commit
      // (every catch in the codebase either returns/throws a typed error
      // or logs) - this is a guardrail against a FUTURE truly silent one,
      // not a fix for an existing one.
      "no-empty": "error",
    },
  },
  prettierConfig,
];
