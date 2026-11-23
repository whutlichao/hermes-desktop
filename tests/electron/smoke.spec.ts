import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { startFakeGatewayServer, startFakeRemoteGatewayServer } from "../helpers/fakeGatewayServer";
import { createTestSandbox } from "../helpers/sandbox";

function writeElectronFakeCli(options: {
  cliPath: string;
  counterFile: string;
  wsUrl: string;
  withHostScope?: boolean;
}) {
  const caps = options.withHostScope
    ? ["session-authority-v1", "host-scope-interactive"]
    : ["session-authority-v1"];
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const profileIdx = args.indexOf("--profile");
const profileId = profileIdx >= 0 && args[profileIdx + 1] ? args[profileIdx + 1] : "default";
const rest = profileIdx >= 0 ? args.slice(profileIdx + 2) : args;

if (rest[0] === "--version") {
  console.log("Hermes Agent v0.23.3");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "--help") {
  console.log("{run,ensure,attach,tickets,restart}");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "ensure" && rest[2] === "--help") {
  console.log("--json --timeout");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "attach" && rest[2] === "--help") {
  console.log("--json --recover");
  process.exit(0);
}
if (rest[0] === "gateway" && rest[1] === "tickets") {
  console.log(JSON.stringify({ protocol: 1, purposes: ["interactive", "native-http"] }));
  process.exit(0);
}
if (rest[0] === "gateway" && (rest[1] === "ensure" || rest[1] === "attach")) {
  let ticketFields = {};
  if (rest[1] === "attach") {
    let n = 0;
    try {
      n = Number(fs.readFileSync(${JSON.stringify(options.counterFile)}, "utf8")) || 0;
    } catch {}
    n += 1;
    fs.writeFileSync(${JSON.stringify(options.counterFile)}, String(n), "utf8");
    ticketFields = { ticket: "tkt_elec_" + n, expires_in_seconds: 30 };
  }
  const payload = {
    state: "ready",
    attachable: true,
    install_code_sha: "sha_e2e",
    client_code_sha: "sha_e2e",
    ...ticketFields,
    endpoint: {
      profile_id: profileId,
      instance_id: "inst-elec-1",
      authority_epoch: 1,
      runtime_protocol: 1,
      capabilities: ${JSON.stringify(caps)},
      code_sha: "sha_e2e",
      ws_url: ${JSON.stringify(options.wsUrl)},
      ws_protocol: "hermes-gateway-v1",
      ticket_protocol_prefix: "hermes-gateway-ticket."
    }
  };
  console.log(JSON.stringify(payload));
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(options.cliPath, script, { encoding: "utf8", mode: 0o755 });
}

test.describe("Electron hardened smoke", () => {
  test("launches real BrowserWindow with sandbox, contextIsolation, frozen window.hermesHost, no Node globals, and real empty state", async () => {
    const sandbox = createTestSandbox("hermes-electron-smoke-");
    let passed = false;
    const remoteGw = await startFakeRemoteGatewayServer({
      protocol: "http",
      validTokens: new Set(["elec-secret-tok-123"]),
      useTicketEndpoint: true,
    });

    const electronApp = await electron.launch({
      args: [path.resolve(process.cwd(), "apps/desktop/out/main/index.js")],
      env: {
        ...process.env,
        HERMES_USER_DATA_DIR: sandbox.userDataDir,
        HERMES_HOME: sandbox.hermesHomeDir,
      },
    });

    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");

      // Verify BrowserWindow webPreferences from Main process
      const windowHardening = await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const prefs = win.webContents.getLastWebPreferences() as Record<string, unknown>;
        return {
          contextIsolation: prefs.contextIsolation,
          sandbox: prefs.sandbox,
          nodeIntegration: prefs.nodeIntegration,
          webSecurity: prefs.webSecurity,
        };
      });

      expect(windowHardening).toEqual({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      });

      // Verify Renderer has no Node exposure and only frozen window.hermesHost
      const bridgeFacts = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const host = w.hermesHost as Record<string, unknown> | undefined;
        return {
          hasRequire: typeof w.require !== "undefined",
          hasProcess: typeof w.process !== "undefined",
          hasBuffer: typeof w.Buffer !== "undefined",
          hasMockGlobal: typeof w.__HERMES_MOCK_HOST__ !== "undefined",
          hostExists: Boolean(host),
          hostFrozen: host ? Object.isFrozen(host) : false,
          hostVersion: host ? host.version : null,
        };
      });

      expect(bridgeFacts).toEqual({
        hasRequire: false,
        hasProcess: false,
        hasBuffer: false,
        hasMockGlobal: false,
        hostExists: true,
        hostFrozen: true,
        hostVersion: 1,
      });

      // Verify native menu accelerators in Main
      const menuAccelerators = await electronApp.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu();
        if (!menu) return [];
        const list: string[] = [];
        const walk = (items: Electron.MenuItem[]) => {
          for (const item of items) {
            if (item.accelerator) list.push(item.accelerator);
            if (item.submenu) walk(item.submenu.items);
          }
        };
        walk(menu.items);
        return list;
      });
      for (const acc of [
        "CmdOrCtrl+K",
        "CmdOrCtrl+,",
        "CmdOrCtrl+B",
        "CmdOrCtrl+N",
        "CmdOrCtrl+W",
        "CmdOrCtrl+Q",
        "CmdOrCtrl+Shift+/",
      ]) {
        expect(menuAccelerators).toContain(acc);
      }

      // Verify real empty state and Electron host mode label
      await expect(page.getByRole("heading", { name: "尚未连接到 Hermes Gateway" })).toBeVisible();
      await expect(page.locator("footer.status-footer")).toContainText("Electron 宿主模式");
      await expect(page.locator("body")).not.toContainText("Homelab");
      await expect(page.locator("body")).not.toContainText("SIMULATED DATA");

      // Verify Settings -> Gateways runs real read-only Test before Save, writes 0600 registry file without leaking secret across bridge
      await page.getByRole("button", { name: "打开 Settings" }).click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: "添加连接" }).click();
      await settings.getByLabel("设备名称").fill("Electron Remote");
      await settings.getByLabel("Gateway 地址").fill(remoteGw.baseUrl);
      await settings.getByLabel("静态 Token（仅写入 Main）").fill("elec-secret-tok-123");
      await expect(settings.getByRole("button", { name: "保存连接" })).toBeDisabled();
      await settings.getByRole("button", { name: "测试连接" }).click();
      await expect(settings.getByText("HTTP 与 WebSocket 双端测试通过，可以保存此 Remote 连接。")).toBeVisible();
      await settings.getByRole("button", { name: "保存连接" }).click();
      await expect(settings.locator('[data-connection-id="electron-remote"]')).toBeVisible();
      await expect(settings).not.toContainText("elec-secret-tok-123");

      const regFile = path.join(sandbox.hermesHomeDir, "gateway-connections.json");
      expect(fs.existsSync(regFile)).toBe(true);
      expect(fs.statSync(regFile).mode & 0o777).toBe(0o600);

      // Verify same-source AppInfo across bridge.hello, diagnostics.export, and Settings -> About/Updates
      const diagnosticsCheck = await page.evaluate(async () => {
        const w = window as unknown as {
          hermesHost: {
            request: (cmd: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean; value: unknown }>;
          };
        };
        const hello = await w.hermesHost.request("bridge.hello", {});
        const diag = await w.hermesHost.request("diagnostics.export", {});
        return { hello, diag };
      });
      expect(diagnosticsCheck.hello.ok).toBe(true);
      expect(diagnosticsCheck.diag.ok).toBe(true);

      const helloInfo = diagnosticsCheck.hello.value as {
        appVersion: string;
        gitSha: string;
        buildMode: string;
        distribution: string;
        arch: string;
      };
      const diagPayload = diagnosticsCheck.diag.value as {
        appInfo: typeof helloInfo;
        display: { headline: string; buildLine: string; runtimeLine: string; updatesNotice: string };
      };
      expect(diagPayload.appInfo).toEqual(helloInfo);
      expect(helloInfo.buildMode).toBe("dev");
      expect(helloInfo.distribution).toBe("local-unsigned");
      expect(JSON.stringify(diagPayload)).not.toContain(process.cwd());

      await expect(settings).toContainText(diagPayload.display.headline);
      await expect(settings).toContainText(diagPayload.display.buildLine);
      await expect(settings).toContainText(diagPayload.display.runtimeLine);
      await expect(settings).toContainText("本地开发构建，不检查更新");
      await expect(settings.getByRole("button", { name: /检查更新|Update/i })).toHaveCount(0);

      passed = true;
    } finally {
      await electronApp.close();
      await remoteGw.close();
      sandbox.cleanup(passed);
    }
  });

  test("renders Local blocked repair card and exports sanitized diagnostics without leaking paths", async () => {
    const sandbox = createTestSandbox("hermes-electron-local-blocked-");
    let passed = false;

    const nonExecBin = path.join(sandbox.rootDir, "secret-dir", "hermes");
    fs.mkdirSync(path.dirname(nonExecBin), { recursive: true, mode: 0o700 });
    fs.writeFileSync(nonExecBin, "#!/bin/sh\necho hi\n", { encoding: "utf8", mode: 0o644 });
    fs.writeFileSync(
      path.join(sandbox.userDataDir, "local-preferences.json"),
      JSON.stringify({ cliOverridePath: nonExecBin }),
      { encoding: "utf8", mode: 0o600 },
    );

    const electronApp = await electron.launch({
      args: [path.resolve(process.cwd(), "apps/desktop/out/main/index.js")],
      env: {
        ...process.env,
        HERMES_USER_DATA_DIR: sandbox.userDataDir,
        HERMES_HOME: sandbox.hermesHomeDir,
      },
    });

    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");

      const localCard = page.locator("section.local-repair-card");
      await expect(localCard).toContainText("This device");
      await expect(localCard).toContainText("连接受阻");
      await expect(localCard).toContainText("发生了什么");
      await expect(localCard).toContainText("不具备可执行权限");
      await expect(localCard).not.toContainText(sandbox.rootDir);
      await expect(localCard).not.toContainText("secret-dir");

      const diagBtn = localCard.getByRole("button", { name: "导出脱敏诊断" });
      await expect(diagBtn).toBeVisible();
      await diagBtn.click();

      const diagModal = page.getByRole("dialog", { name: "脱敏诊断摘要" });
      await expect(diagModal).toBeVisible();
      await expect(diagModal).toContainText("cli_not_executable");
      await expect(diagModal).toContainText("temp");

      const jsonText = await diagModal.locator("pre.diagnostics-json").innerText();
      expect(jsonText).not.toContain(sandbox.rootDir);
      expect(jsonText).not.toContain("secret-dir");
      expect(jsonText).not.toContain("stderr");
      expect(jsonText).toContain('"typedFailureCode": "cli_not_executable"');

      passed = true;
    } finally {
      await electronApp.close();
      sandbox.cleanup(passed);
    }
  });

  test("connects Local gateway via control socket ticket, scopes profiles/sessions, streams reply/tools, and handles Stop failure honestly", async () => {
    const sandbox = createTestSandbox("hc-");
    let passed = false;
    const validTickets = new Set<string>(["tkt_elec_1", "tkt_elec_2", "tkt_elec_3"]);
    let udsCounter = 0;
    let stopShouldFail = true;

    const gw = await startFakeGatewayServer({
      validTickets,
      profiles: [
        { profile_id: "default", display_name: "Default", handle: "default", is_default: true },
        { profile_id: "work", display_name: "Work", handle: "work", is_default: false },
      ],
      initialSessions: [
        { profile_id: "default", session_id: "sess-def-1", title: "Local Intro", preview: "ready" },
        { profile_id: "work", session_id: "sess-work-1", title: "Work Review", preview: "ops" },
      ],
      onRpc: async (method, params, ctx) => {
        if (method === "prompt.submit") {
          const sid = String(params.session_id);
          const turnId = "turn-elec-1";
          const assistantMsgId = "msg-elec-a1";
          ctx.replyResult({
            accepted: true,
            session_id: sid,
            turn_id: turnId,
            user_message_id: "msg-elec-u1",
            assistant_message_id: assistantMsgId,
          });
          setTimeout(() => {
            ctx.sendNotification("prompt.delta", {
              session_id: sid,
              turn_id: turnId,
              message_id: assistantMsgId,
              delta: "好的，核心片段如下：\n```ts\nconst answer = 42;\n```",
            });
            ctx.sendNotification("activity", {
              session_id: sid,
              turn_id: turnId,
              message_id: assistantMsgId,
              tool_call_id: "tc-elec-1",
              name: "read_file",
              status: "completed",
              summary: "README.md",
            });
          }, 25);
          return true;
        }
        if (method === "prompt.cancel") {
          if (stopShouldFail) {
            ctx.replyError(-32000, "Stop ACK timeout");
            return true;
          }
          ctx.replyResult({ stopped: true, session_id: params.session_id, turn_id: params.turn_id });
          ctx.sendNotification("prompt.stopped", {
            session_id: params.session_id,
            turn_id: params.turn_id,
            message_id: "msg-elec-a1",
          });
          return true;
        }
        return false;
      },
    });

    const sockPath = path.join(sandbox.hermesHomeDir, "gateway.sock");
    const udsServer = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        if (req.op === "resolve-profile") {
          socket.write(
            JSON.stringify({
              status: "ok",
              state: "ready",
              attachable: true,
              purposes: ["interactive"],
              endpoint: {
                profile_id: req.profile_id ?? "default",
                instance_id: "inst-elec-1",
                authority_epoch: 1,
                runtime_protocol: 1,
                capabilities: ["session-authority-v1", "host-scope-interactive"],
                code_sha: "sha_e2e",
                ws_url: gw.wsUrl,
              },
            }) + "\n",
          );
        } else if (req.op === "session-ticket") {
          udsCounter += 1;
          socket.write(
            JSON.stringify({ status: "ok", ticket: `tkt_elec_${udsCounter}`, expires_in_seconds: 30 }) + "\n",
          );
        }
      });
    });
    await new Promise<void>((resolve) => udsServer.listen(sockPath, resolve));
    fs.chmodSync(sockPath, 0o600);

    const cliPath = path.join(sandbox.rootDir, "hermes");
    writeElectronFakeCli({
      cliPath,
      counterFile: path.join(sandbox.rootDir, "cli-counter.txt"),
      wsUrl: gw.wsUrl,
      withHostScope: true,
    });
    fs.writeFileSync(
      path.join(sandbox.userDataDir, "local-preferences.json"),
      JSON.stringify({ cliOverridePath: cliPath }),
      { encoding: "utf8", mode: 0o600 },
    );

    const electronApp = await electron.launch({
      args: [path.resolve(process.cwd(), "apps/desktop/out/main/index.js")],
      env: {
        ...process.env,
        HERMES_USER_DATA_DIR: sandbox.userDataDir,
        HERMES_HOME: sandbox.hermesHomeDir,
      },
    });

    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");

      // Wait for real Local connection over UDS ticket + WS
      const routeStrip = page.locator(".route-strip");
      await expect(routeStrip).toContainText("This device");
      await expect(routeStrip).toContainText("Default", { timeout: 15_000 });
      await expect(routeStrip).toContainText("已连接", { timeout: 15_000 });

      // Session rail is scoped strictly to (local, default)
      const sidebar = page.locator("nav.sidebar");
      await expect(sidebar).toContainText("Local Intro");
      await expect(sidebar).not.toContainText("Work Review");

      // Switch Profile -> Work swaps visible sessions without opening another WS
      await routeStrip.getByRole("button", { name: /已连接/ }).click();
      const scopeDialog = page.getByRole("dialog", { name: "选择 Scope" });
      await scopeDialog.getByRole("button", { name: /Work/ }).click();
      await expect(routeStrip).toContainText("Work");
      await expect(sidebar).toContainText("Work Review");
      await expect(sidebar).not.toContainText("Local Intro");
      expect(gw.connections).toHaveLength(1);
      expect(gw.connections[0].headers.origin).toBeUndefined();

      // Switch back to Default & send first prompt
      await routeStrip.getByRole("button", { name: /已连接/ }).click();
      await page.getByRole("dialog", { name: "选择 Scope" }).getByRole("button", { name: /Default/ }).click();
      await expect(sidebar).toContainText("Local Intro");

      await page.locator("#composer-input").fill("帮我看下 README");
      await page.getByRole("button", { name: "发送消息" }).click();

      const thread = page.locator(".transcript-list");
      await expect(thread).toContainText("帮我看下 README");
      await expect(thread).toContainText("const answer = 42;");
      await expect(thread).toContainText("read_file");
      await expect(thread).toContainText("README.md");

      // Stop fails on first attempt -> alert shown AND Stop button remains visible (not faking stopped!)
      const stopBtn = page.getByRole("button", { name: "停止 Turn" });
      await expect(stopBtn).toBeVisible();
      await stopBtn.click();
      await expect(page.locator(".chat-alert")).toContainText("停止 Turn 失败");
      await expect(stopBtn).toBeVisible();

      // Second Stop ACKs cleanly -> stopped badge shown
      stopShouldFail = false;
      await stopBtn.click();
      await expect(thread).toContainText("已停止");
      await expect(stopBtn).toHaveCount(0);

      // Verify zero ticket / wsUrl leak in DOM or diagnostics.export
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toContain("tkt_elec_");
      expect(bodyText).not.toContain(gw.wsUrl);
      const diagJson = await page.evaluate(async () => {
        const w = window as unknown as {
          hermesHost: { request: (cmd: string, p?: Record<string, unknown>) => Promise<unknown> };
        };
        return JSON.stringify(await w.hermesHost.request("diagnostics.export", {}));
      });
      expect(diagJson).not.toContain("tkt_elec_");
      expect(diagJson).not.toContain(gw.wsUrl);

      passed = true;
    } finally {
      await electronApp.close();
      udsServer.close();
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  test("hides composer when gateway omits prompt.submit capability", async () => {
    const sandbox = createTestSandbox("hr-");
    let passed = false;
    const validTickets = new Set<string>(["tkt_elec_1", "tkt_elec_2"]);

    const gw = await startFakeGatewayServer({
      validTickets,
      servedMethods: [
        "runtime.describe",
        "client.capabilities",
        "subscribe",
        "profiles.list",
        "session.list",
        "session.resume",
        "session.transcript",
      ],
      initialSessions: [
        { profile_id: "default", session_id: "sess-ro-1", title: "Readonly Session", preview: "view only" },
      ],
    });

    const cliPath = path.join(sandbox.rootDir, "hermes");
    writeElectronFakeCli({
      cliPath,
      counterFile: path.join(sandbox.rootDir, "cli-counter.txt"),
      wsUrl: gw.wsUrl,
      withHostScope: false,
    });
    fs.writeFileSync(
      path.join(sandbox.userDataDir, "local-preferences.json"),
      JSON.stringify({ cliOverridePath: cliPath }),
      { encoding: "utf8", mode: 0o600 },
    );

    const electronApp = await electron.launch({
      args: [path.resolve(process.cwd(), "apps/desktop/out/main/index.js")],
      env: {
        ...process.env,
        HERMES_USER_DATA_DIR: sandbox.userDataDir,
        HERMES_HOME: sandbox.hermesHomeDir,
      },
    });

    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");

      await expect(page.locator(".route-strip")).toContainText("已连接", { timeout: 15_000 });
      await expect(page.locator(".chat-unavailable-card")).toContainText("当前 Gateway 暂不支持 Chat");
      await expect(page.locator("form.composer-shell")).toHaveCount(0);

      passed = true;
    } finally {
      await electronApp.close();
      await gw.close();
      sandbox.cleanup(passed);
    }
  });

  test("Remote HTTP+WS wizard runs read-only Test, preserves draft on failure, clears token on Save, connects Remote Scope, and sends prompt", async () => {
    const sandbox = createTestSandbox("hr-remote-");
    let passed = false;
    const remoteGw = await startFakeRemoteGatewayServer({
      protocol: "http",
      validTokens: new Set(["remote-e2e-token-999"]),
      useTicketEndpoint: true,
      profiles: [
        { profile_id: "default", display_name: "Prod Default", handle: "default", is_default: true },
      ],
      initialSessions: [
        {
          profile_id: "default",
          session_id: "remote-elec-sess-1",
          title: "Remote Electron Session",
          preview: "ready",
        },
      ],
    });

    const electronApp = await electron.launch({
      args: [path.resolve(process.cwd(), "apps/desktop/out/main/index.js")],
      env: {
        ...process.env,
        HERMES_USER_DATA_DIR: sandbox.userDataDir,
        HERMES_HOME: sandbox.hermesHomeDir,
      },
    });

    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");

      await page.getByRole("button", { name: "打开 Settings" }).click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: "添加连接" }).click();

      // Failing Test (bad token) keeps Save disabled & preserves draft; 0 registry writes
      await settings.getByLabel("设备名称").fill("Staging Remote");
      await settings.getByLabel("Gateway 地址").fill(remoteGw.baseUrl);
      await settings.getByLabel("静态 Token（仅写入 Main）").fill("wrong-token");
      await settings.getByRole("button", { name: "测试连接" }).click();
      await expect(settings.getByText("Remote 认证失败或凭据无效")).toBeVisible();
      await expect(settings.getByRole("button", { name: "保存连接" })).toBeDisabled();
      await expect(settings.getByLabel("设备名称")).toHaveValue("Staging Remote");
      await expect(settings.getByLabel("Gateway 地址")).toHaveValue(remoteGw.baseUrl);
      expect(fs.existsSync(path.join(sandbox.hermesHomeDir, "gateway-connections.json"))).toBe(false);

      // Valid token passes Test -> enables Save -> commits & dials Remote WS -> re-scopes cleanly
      await settings.getByLabel("静态 Token（仅写入 Main）").fill("remote-e2e-token-999");
      await settings.getByRole("button", { name: "测试连接" }).click();
      await expect(settings.getByText("HTTP 与 WebSocket 双端测试通过，可以保存此 Remote 连接。")).toBeVisible();
      await settings.getByRole("button", { name: "保存连接" }).click();

      const stagingRow = settings.locator('[data-connection-id="staging-remote"]');
      await expect(stagingRow).toBeVisible();
      await expect(stagingRow).toContainText("Main 已保存凭据（Main only）");
      await expect(settings).not.toContainText("remote-e2e-token-999");

      // Reopen edit shows blank token + Main only
      await stagingRow.getByRole("button", { name: "编辑 / 改名" }).click();
      await expect(settings.getByLabel("静态 Token（仅写入 Main）")).toHaveValue("");
      await expect(settings).toContainText("Main 已保存凭据（Main only）");
      await page.keyboard.press("Escape");

      // Remote Scope becomes ready & loads Remote sessions + handles prompt.submit
      const routeStrip = page.locator(".route-strip");
      await expect(routeStrip).toContainText("Staging Remote", { timeout: 15_000 });
      await expect(routeStrip).toContainText("已连接", { timeout: 15_000 });
      await expect(page.locator("nav.sidebar")).toContainText("Remote Electron Session");

      await page.locator("#composer-input").fill("check remote cluster");
      await page.getByRole("button", { name: "发送消息" }).click();
      await expect(page.locator(".transcript-list")).toContainText("check remote cluster");
      expect(
        remoteGw.rpcCalls.some(
          (call) => call.method === "prompt.submit" && call.params.text === "check remote cluster",
        ),
      ).toBe(true);

      // Verify zero secret token leak in DOM or diagnostics.export
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toContain("remote-e2e-token-999");
      const diagJson = await page.evaluate(async () => {
        const w = window as unknown as {
          hermesHost: { request: (cmd: string, p?: Record<string, unknown>) => Promise<unknown> };
        };
        return JSON.stringify(await w.hermesHost.request("diagnostics.export", {}));
      });
      expect(diagJson).not.toContain("remote-e2e-token-999");

      passed = true;
    } finally {
      await electronApp.close();
      await remoteGw.close();
      sandbox.cleanup(passed);
    }
  });
});
