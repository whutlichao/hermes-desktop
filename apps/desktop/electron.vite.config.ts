import path from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const contractsEntry = path.resolve(__dirname, "../../packages/contracts/src/index.ts");
const domainEntry = path.resolve(__dirname, "../../packages/domain/src/index.ts");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@hermes/contracts", "@hermes/domain"] })],
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
