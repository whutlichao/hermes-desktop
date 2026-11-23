import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TestSandbox {
  rootDir: string;
  userDataDir: string;
  hermesHomeDir: string;
  cleanup: (passed: boolean) => void;
}

export function createTestSandbox(prefix = "hermes-test-"): TestSandbox {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const userDataDir = path.join(rootDir, "user-data");
  const hermesHomeDir = path.join(rootDir, "hermes-home");
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(hermesHomeDir, { recursive: true, mode: 0o700 });

  const realHermes = path.resolve(os.homedir(), ".hermes");
  if (path.resolve(hermesHomeDir) === realHermes || path.resolve(userDataDir) === os.homedir()) {
    throw new Error("Test sandbox must never point to real ~/.hermes or ~");
  }

  return {
    rootDir,
    userDataDir,
    hermesHomeDir,
    cleanup(passed: boolean) {
      const keep = process.env.KEEP_TEST_SANDBOX === "1";
      if (!passed || keep) {
        return;
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
