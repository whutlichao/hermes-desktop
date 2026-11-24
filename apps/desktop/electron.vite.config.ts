import path from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolveBuildGitMeta } from "../../scripts/build-meta.mjs";

const repoRoot = path.resolve(__dirname, "../..");
const contractsEntry = path.resolve(repoRoot, "packages/contracts/src/index.ts");
const domainEntry = path.resolve(repoRoot, "packages/domain/src/index.ts");

const buildMode = process.env.HERMES_BUILD_MODE === "packaged" ? "packaged" : "dev";
const allowUnknownSha = process.env.ALLOW_UNKNOWN_SHA === "1";
const buildMeta = resolveBuildGitMeta({ repoRoot, buildMode, allowUnknownSha });

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@hermes/contracts", "@hermes/domain"] })],
    define: {
      __HERMES_BUILD_META__: JSON.stringify(buildMeta),
    },
    resolve: {
      alias: {
        "@hermes/contracts": contractsEntry,
        "@hermes/domain": domainEntry,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@hermes/contracts", "@hermes/domain"] })],
    resolve: {
      alias: {
        "@hermes/contracts": contractsEntry,
        "@hermes/domain": domainEntry,
      },
    },
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        "@hermes/host-adapter": path.resolve(__dirname, "src/renderer/host/electronAdapter.ts"),
        "@hermes/contracts": contractsEntry,
        "@hermes/domain": domainEntry,
      },
    },
    build: {
      sourcemap: false,
    },
  },
});
