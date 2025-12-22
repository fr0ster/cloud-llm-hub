import cds from "@sap/cds/eslint.config.mjs";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginPrettier from "eslint-plugin-prettier";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  ...cds.recommended,
  {
    ignores: [
      "dist/**",
      "gen/**",
      "@cds-models/**",
      "submodules/**",
      "node_modules/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/gen/**",
      "package-lock.json",
      "*.log",
      "*.mtar",
      "mta_archives/**",
      "tools/**",
      "test/**",
      "docs/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      prettier: eslintPluginPrettier,
    },
    rules: {
      ...eslintConfigPrettier.rules,
      "prettier/prettier": [
        "error",
        {
          singleQuote: true,
          semi: true,
          trailingComma: "es5",
          printWidth: 100,
          tabWidth: 2,
          useTabs: false,
          arrowParens: "always",
          endOfLine: "lf",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    plugins: {
      prettier: eslintPluginPrettier,
    },
    rules: {
      ...eslintConfigPrettier.rules,
      "prettier/prettier": [
        "error",
        {
          singleQuote: true,
          semi: true,
          trailingComma: "es5",
          printWidth: 100,
          tabWidth: 2,
          useTabs: false,
          arrowParens: "always",
          endOfLine: "lf",
        },
      ],
    },
  },
];
