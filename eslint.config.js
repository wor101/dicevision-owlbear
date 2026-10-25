import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The extension's pages run in the browser inside Owlbear Rodeo
    files: ["src/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["tests/**/*.ts", "vite.config.ts", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
