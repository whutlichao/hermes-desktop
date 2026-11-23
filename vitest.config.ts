import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@hermes/contracts": path.resolve(__dirname, "packages/contracts/src/index.ts"),
      "@hermes/domain": path.resolve(__dirname, "packages/domain/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "scripts/**/*.test.mjs",
      "tests/unit/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/domain/src/**/*.ts", "packages/contracts/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
    },
  },
});
