import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readDesktopPackageMeta, resolveBuildGitMeta } from "../../scripts/build-meta.mjs";

const repoRoot = path.resolve(__dirname, "../..");
const gitMeta = resolveBuildGitMeta({ repoRoot, buildMode: "dev", allowUnknownSha: true });
const pkgMeta = readDesktopPackageMeta(__dirname);
const webPort = Number(process.env.HERMES_WEB_PORT || 4173);

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  plugins: [react()],
  define: {
    __HERMES_MOCK_BUILD_META__: JSON.stringify({
      ...gitMeta,
      appVersion: pkgMeta.appVersion,
      electronVersion: pkgMeta.electronVersion,
      chromiumVersion: "build-time",
      nodeVersion: process.versions.node,
    }),
  },
  resolve: {
    alias: {
      "@hermes/host-adapter": path.resolve(__dirname, "src/mock/mockHostAdapter.ts"),
      "@hermes/contracts": path.resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@hermes/domain": path.resolve(__dirname, "../../packages/domain/src/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, "dist-web"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
