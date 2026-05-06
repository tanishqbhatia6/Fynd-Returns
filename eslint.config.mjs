// ESLint flat config (eslint v9 style).
// Goals:
//   1. Catch real bugs (no-undef, no-unused-vars, hooks rules)
//   2. Keep TypeScript-aware checks but NOT block on stylistic noise
//   3. Defer formatting entirely to Prettier (eslint-config-prettier disables
//      every rule that conflicts with Prettier's output)
//
// Run with:
//   npm run lint        # check
//   npm run lint:fix    # auto-fix
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettierConfig from "eslint-config-prettier";

export default [
  // Ignore generated artifacts and dependency trees.
  {
    ignores: [
      "node_modules/**",
      "build/**",
      "dist/**",
      "coverage/**",
      "cov-base/**",
      "cov-pragma-check*/**",
      "cov-returns-*/**",
      "cov-targets*/**",
      "cov-test-pragma*/**",
      "tmp-coverage*/**",
      "tmp-shopify-cov/**",
      ".cov-target/**",
      ".react-router/**",
      "public/**",
      "app/portal/**", // hand-authored web component, separate lint pass
      "extensions/**",
      "scripts/**", // one-off node scripts
      "*.config.{js,mjs,cjs,ts}",
    ],
  },

  // Base JS rules (recommended) — applied to .js/.mjs/.cjs/.ts/.tsx alike.
  js.configs.recommended,

  // TypeScript-eslint recommended (NOT type-checked variant — that's slower
  // and overkill for this surface; we already have tsc --noEmit).
  ...tseslint.configs.recommended,

  // React + Hooks + a11y for the .tsx surface.
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        // Browser
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        File: "readonly",
        Buffer: "readonly",
        // Node
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        global: "readonly",
        // React 19 JSX runtime
        React: "readonly",
        JSX: "readonly",
        // Vitest
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        vi: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        afterAll: "readonly",
        afterEach: "readonly",
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      // ── React ─────────────────────────────────────────────────────
      "react/jsx-uses-react": "off", // React 17+ JSX runtime
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off", // TypeScript handles this
      "react/no-unescaped-entities": "off", // false positives on copy

      // ── React Hooks ───────────────────────────────────────────────
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // ── jsx-a11y (selective; this codebase has admin surfaces where
      //    some hints don't apply) ─────────────────────────────────
      "jsx-a11y/anchor-is-valid": "warn",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/no-static-element-interactions": "off",
      "jsx-a11y/label-has-associated-control": "off",

      // ── TS noise we explicitly accept ─────────────────────────────
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/ban-ts-comment": [
        "warn",
        { "ts-expect-error": "allow-with-description", "ts-ignore": false },
      ],

      // ── Hard errors only ──────────────────────────────────────────
      "no-undef": "off", // TypeScript handles
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-prototype-builtins": "off",
      "no-case-declarations": "off",
      "no-useless-escape": "warn",
      "no-irregular-whitespace": "warn",
      "no-useless-assignment": "warn",
      "no-unassigned-vars": "warn",
      "no-loss-of-precision": "warn",
      "import/first": "off",
      // These are useful diagnostics but legacy code in this project
      // hits them frequently; demote to warn so they don't block CI.
      "preserve-caught-error": "off",
      "@typescript-eslint/no-throw-literal": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/no-namespace": "warn",
    },
  },

  // Test files — relax a few rules.
  {
    files: ["**/__tests__/**", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "react-hooks/rules-of-hooks": "off",
    },
  },

  // Prettier compat — must come LAST so it wins style conflicts.
  prettierConfig,
];
