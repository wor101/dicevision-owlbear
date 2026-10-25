import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Two pages: the action popover and the background page, both named in
// public/manifest.json by site-relative path, so the build serves from "/".
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        action: `${root}action.html`,
        background: `${root}background.html`,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Owlbear Rodeo loads a dev manifest from http://localhost:5173 cross-origin
    cors: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
