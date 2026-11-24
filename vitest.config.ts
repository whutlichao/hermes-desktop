import { defineConfig } from "vitest/config";
import path from "node:path";

const PURE_BRANCH_COVERAGE_MODULES = [
  "packages/domain/src/activeChatResolver.ts",
  "packages/domain/src/appInfo.ts",
  "packages/domain/src/copy.ts",
  "packages/domain/src/drafts.ts",
  "packages/domain/src/fleetLifecycle.ts",
  "packages/domain/src/gatewayProtocol.ts",
  "packages/domain/src/settingsAndScope.ts",
  "packages/domain/src/shell.ts",
  "packages/domain/src/ssh.ts",
  "packages/domain/src/terminal.ts",
  "packages/domain/src/workspace.ts",
];

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
      thresholds: {
        "packages/contracts/src/**/*.ts": {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        "packages/domain/src/**/*.ts": {
          lines: 90,
          branches: 85,
        },
        ...Object.fromEntries(
          PURE_BRANCH_COVERAGE_MODULES.map((modulePath) => [
            modulePath,
            { branches: 100 },
          ]),
        ),
      },
    },
  },
});
