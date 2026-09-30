/// <reference types="vitest" />
import fs from "node:fs";
import path from "path";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// package.json is the single source of truth for the version (tauri.conf.json
// resolves "version": "../package.json"), so the frontend gets it injected
// here rather than hardcoding it anywhere.
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

export default defineConfig({
  plugins: [
    react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } }),
    tailwindcss(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },

  // Tauri-specific settings
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    // Never recurse into nested git worktrees (the harness uses .claude/worktrees/;
    // superpowers:using-git-worktrees uses .worktrees/). Their own tests/node_modules
    // must not pollute this project's run.
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/.worktrees/**"],
  },
});
