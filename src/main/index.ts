import { BrowserWindow, Menu, Notification, app, dialog, ipcMain, safeStorage, shell } from "electron";
import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { selectLatestNodeWindowsMsi, VC_REDIST_X64_INSTALLER } from "./codex/runtimeInstall";
import { CodexAppServer } from "./codex/codexAppServer";
import { RemoteWorkspace } from "./remote/remoteWorkspace";
import { RelayDeviceClient } from "./cloudRelay/relayDeviceClient";
import { forwardCodexEventToRelay, handleRelayRpc } from "./cloudRelay/relayCodexBridge";
import { E2eeDeviceSession, generateDeviceEd25519Keypair } from "./cloudRelay/e2ee";
import { SettingsStore, mergeSettings } from "./settings";
import { sendWebhook } from "./webhook";
import { sshProbe } from "./sshProbe";
import { mkdirRemoteAbs, scanRemoteWorkspaces } from "./sshWorkspaces";
import type {
  AppSettings,
  CodexCliInfo,
  CodexRuntimeInstallResult,
  CodexRuntimeInstallTarget,
  CodexEvent,
  CodexProviderTestResult,
  CodexUserConfigReadResult,
  CodexUserConfigWriteArgs,
  CodexUserConfigWriteResult,
  LlmChatCompleteArgs,
  LlmChatCompleteResult,
  RemoteWorkspaceConnectArgs,
  RemoteWorkspaceConnectResult,
  RemoteWorkspaceMkdirAbsArgs,
  RemoteWorkspaceMkdirAbsResult,
  RemoteOpenInTerminalArgs,
  RemoteWorkspaceScanResult,
  RemoteWorkspaceStatus,
  RelayPairingRefreshArgs,
  RelayPairingRefreshResult,
  RpcId,
  SshProbeArgs,
  SshProbeResult,
  TerminalCreateArgs,
  TerminalCreateResult,
  TerminalDisposeArgs,
  TerminalEvent,
  TerminalResizeArgs,
  TerminalRunArgs,
  TerminalRunResult,
  TerminalWriteArgs,
  WorkspaceDirEntry,
  WorkspaceListDirResult,
  WorkspaceOpResult,
  WorkspacePathResult,
  WorkspaceReadFileResult
} from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let settingsStore: SettingsStore | null = null;
let settings: AppSettings | null = null;

let codexLocal: CodexAppServer | null = null;
let remoteWorkspace: RemoteWorkspace | null = null;
let codexActiveKind: "local" | "remote" = "local";
let relayDevice: RelayDeviceClient | null = null;
let relayE2ee: E2eeDeviceSession | null = null;

type TerminalSession = {
  id: string;
  scope: "local" | "remote";
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  dispose: () => void;
};

const terminals = new Map<string, TerminalSession>();

type RpcError = { code: number; message: string; data?: unknown };

type RpcRequest = { id: RpcId; method: string; params?: unknown };
type RpcNotification = { method: string; params?: unknown };
type RpcResponse = { id: RpcId; result?: unknown; error?: RpcError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(obj: unknown, key: string): obj is Record<string, unknown> {
  return isRecord(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function isRpcRequest(value: unknown): value is RpcRequest {
  return isRecord(value) && (typeof value.id === "string" || typeof value.id === "number") && typeof value.method === "string";
}

function isRpcNotification(value: unknown): value is RpcNotification {
  return isRecord(value) && typeof value.method === "string" && !hasOwn(value, "id");
}

function isRpcResponse(value: unknown): value is RpcResponse {
  if (!isRecord(value) || (typeof value.id !== "string" && typeof value.id !== "number")) {
    return false;
  }
  if (hasOwn(value, "method") && value.method !== undefined) {
    return false;
  }
  return hasOwn(value, "result") || hasOwn(value, "error");
}

type WorkspaceWatchState = {
  rootAbs: string;
  watchersByDir: Map<string, FSWatcher>;
  debounceByDir: Map<string, NodeJS.Timeout>;
};

let workspaceWatchState: WorkspaceWatchState | null = null;

function workspaceWatchClear(): void {
  const state = workspaceWatchState;
  if (!state) {
    return;
  }
  for (const t of state.debounceByDir.values()) {
    clearTimeout(t);
  }
  state.debounceByDir.clear();
  for (const w of state.watchersByDir.values()) {
    try {
      w.close();
    } catch {
      // Best-effort.
    }
  }
  state.watchersByDir.clear();
  workspaceWatchState = null;
}

function emitTerminalToRenderer(ev: TerminalEvent): void {
  try {
    mainWindow?.webContents.send("terminal:event", ev);
  } catch {
    // Best-effort.
  }

  if (settings?.relay?.enabled && relayDevice) {
    relayDevice.sendRpc({ method: "tazhan/terminal/event", params: ev } as any);
  }
}

function emitWorkspaceDirChanged(rootAbs: string, dirAbs: string): void {
  const win = mainWindow;
  if (!win) {
    return;
  }
  if (!workspaceWatchState || workspaceWatchState.rootAbs !== rootAbs) {
    return;
  }

  const key = process.platform === "win32" ? dirAbs.toLowerCase() : dirAbs;
  const existing = workspaceWatchState.debounceByDir.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const t = setTimeout(() => {
    workspaceWatchState?.debounceByDir.delete(key);
    const atMs = Date.now();
    win.webContents.send("workspace:event", { root: rootAbs, dir: dirAbs, atMs });
    if (settings?.relay?.enabled && relayDevice) {
      relayDevice.sendRpc({ method: "tazhan/workspace/event", params: { root: rootAbs, dir: dirAbs, atMs } } as any);
    }
  }, 120);
  workspaceWatchState.debounceByDir.set(key, t);
}

function preloadPath(): string {
  return path.join(__dirname, "..", "preload", "index.js");
}

function rendererUrl(): string {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    return devUrl;
  }
  return pathToFileURL(path.join(__dirname, "..", "renderer", "index.html")).toString();
}

function windowIconPath(): string | undefined {
  if (!process.env.VITE_DEV_SERVER_URL) {
    return undefined;
  }
  return path.join(app.getAppPath(), "tubiao.png");
}

function emitToRenderer(ev: CodexEvent): void {
  mainWindow?.webContents.send("codex:event", ev);

  if (settings?.relay?.enabled && relayDevice) {
    forwardCodexEventToRelay(relayDevice, ev);
  }

  if (ev.type === "notification" && ev.method === "turn/completed") {
    const status = (ev.params as any)?.turn?.status ?? "completed";
    const threadId = (ev.params as any)?.threadId ?? "";
    const turnId = (ev.params as any)?.turn?.id ?? "";
    const supported = (() => {
      try {
        return typeof Notification.isSupported === "function" ? Notification.isSupported() : true;
      } catch {
        return true;
      }
    })();

    // Send a debug line to the renderer log so we can diagnose notification issues
    // without requiring users to open the main-process console.
    mainWindow?.webContents.send("codex:event", {
      type: "stderr",
      line: `[notify-debug] turn/completed thread=${threadId || "(missing)"} turn=${turnId || "(missing)"} status=${status} supported=${String(
        supported
      )}`
    } satisfies CodexEvent);

    const notifyEnabled = (() => {
      if (!settings) {
        return true;
      }
      const override = settings.notifyThreads[threadId];
      if (typeof override === "boolean") {
        return override;
      }
      return settings.notifyOnComplete;
    })();

    if (!notifyEnabled) {
      mainWindow?.webContents.send("codex:event", {
        type: "stderr",
        line: `[notify-debug] suppressed by settings: thread=${threadId || "(missing)"}`
      } satisfies CodexEvent);
      return;
    }

    try {
      if (process.platform === "win32") {
        // Windows toast notifications are much more reliable when an AUMID is set.
        // This is safe to call multiple times (we only do it when notifying).
        app.setAppUserModelId("com.tazhan.desktop");
      }

      new Notification({
        title: "Codex 回合已完成",
        body: `${status} ${threadId} ${turnId}`.trim()
      }).show();
      mainWindow?.webContents.send("codex:event", {
        type: "stderr",
        line: "[notify-debug] OS notification requested"
      } satisfies CodexEvent);
    } catch (err) {
      emitToRenderer({
        type: "stderr",
        line: `[notify-debug] failed to show OS notification: ${String(err)}`
      });
    }

    // Best-effort sound + taskbar attention on Windows, even if the toast is suppressed by system settings.
    try {
      shell.beep();
      mainWindow?.webContents.send("codex:event", { type: "stderr", line: "[notify-debug] shell.beep()" } satisfies CodexEvent);
    } catch {
      // Best-effort.
      mainWindow?.webContents.send("codex:event", { type: "stderr", line: "[notify-debug] shell.beep() failed" } satisfies CodexEvent);
    }
    try {
      mainWindow?.flashFrame(true);
      setTimeout(() => {
        mainWindow?.flashFrame(false);
      }, 1200);
    } catch {
      // Best-effort.
    }

    const url = settings?.notifyWebhookUrl ?? "";
    void sendWebhook(url, { event: "turn.completed", params: ev.params });
  }
}

function emitRemoteToRenderer(ev: CodexEvent): void {
  mainWindow?.webContents.send("remote:event", ev);

  if (ev.type === "notification" && ev.method === "turn/completed") {
    const status = (ev.params as any)?.turn?.status ?? "completed";
    const threadId = (ev.params as any)?.threadId ?? "";
    const turnId = (ev.params as any)?.turn?.id ?? "";
    const supported = (() => {
      try {
        return typeof Notification.isSupported === "function" ? Notification.isSupported() : true;
      } catch {
        return true;
      }
    })();

    mainWindow?.webContents.send("remote:event", {
      type: "stderr",
      line: `[notify-debug] turn/completed thread=${threadId || "(missing)"} turn=${turnId || "(missing)"} status=${status} supported=${String(
        supported
      )}`
    } satisfies CodexEvent);

    const notifyEnabled = (() => {
      if (!settings) {
        return true;
      }
      const override = settings.notifyThreads[threadId];
      if (typeof override === "boolean") {
        return override;
      }
      return settings.notifyOnComplete;
    })();

    if (!notifyEnabled) {
      mainWindow?.webContents.send("remote:event", {
        type: "stderr",
        line: `[notify-debug] suppressed by settings: thread=${threadId || "(missing)"}`
      } satisfies CodexEvent);
      return;
    }

    try {
      if (process.platform === "win32") {
        app.setAppUserModelId("com.tazhan.desktop");
      }

      new Notification({
        title: "Codex Turn Completed",
        body: `${status} ${threadId} ${turnId}`.trim()
      }).show();
      mainWindow?.webContents.send("remote:event", {
        type: "stderr",
        line: "[notify-debug] OS notification requested"
      } satisfies CodexEvent);
    } catch (err) {
      emitRemoteToRenderer({
        type: "stderr",
        line: `[notify-debug] failed to show OS notification: ${String(err)}`
      });
    }

    try {
      shell.beep();
      mainWindow?.webContents.send("remote:event", { type: "stderr", line: "[notify-debug] shell.beep()" } satisfies CodexEvent);
    } catch {
      mainWindow?.webContents.send("remote:event", { type: "stderr", line: "[notify-debug] shell.beep() failed" } satisfies CodexEvent);
    }
    try {
      mainWindow?.flashFrame(true);
      setTimeout(() => {
        mainWindow?.flashFrame(false);
      }, 1200);
    } catch {
      // Best-effort.
    }

    const url = settings?.notifyWebhookUrl ?? "";
    void sendWebhook(url, { event: "turn.completed", params: ev.params });
  }
}

type CaptureResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runCapture(command: string, args: string[], timeoutMs: number): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const useShell = process.platform === "win32";
    let done = false;

    function finish(result: CaptureResult): void {
      if (done) {
        return;
      }
      done = true;
      resolve(result);
    }

    const proc = spawn(command, args, {
      stdio: "pipe",
      shell: useShell,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Best-effort.
      }
      finish({ code: null, stdout, stderr: `${stderr}\n(timeout after ${timeoutMs}ms)`.trim() });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr });
    });
  });
}

function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

type VersionCommandProbe = {
  command: string;
  output: string;
  version: string | null;
};

type CodexCliResolution = {
  command: string;
  output: string;
  version: string;
};

function configuredCodexCommand(): { command: string; usesDefaultCommand: boolean } {
  const configured = settings?.codexPath?.trim() ?? "";
  if (!configured || configured.toLowerCase() === "codex") {
    return { command: "codex", usesDefaultCommand: true };
  }
  return { command: configured, usesDefaultCommand: false };
}

async function probeVersionCommand(command: string): Promise<VersionCommandProbe> {
  const res = await runCapture(command, ["--version"], 5000);
  const output = `${res.stdout}\n${res.stderr}`.trim();
  return {
    command,
    output,
    version: parseVersion(output)
  };
}

type NodeRuntimeResolution = {
  command: string | null;
  version: string | null;
};

async function resolveNodeRuntime(): Promise<NodeRuntimeResolution> {
  const pathLookup = await resolveNodeRuntimeCommand("node");
  if (pathLookup) {
    return pathLookup;
  }

  if (process.platform === "win32") {
    for (const candidate of windowsNodeCommandCandidates()) {
      const resolved = await resolveNodeRuntimeCommand(candidate);
      if (resolved) {
        return resolved;
      }
    }
  }

  return { command: null, version: null };
}

async function resolveNodeRuntimeCommand(command: string): Promise<NodeRuntimeResolution | null> {
  const res = await runCapture(command, ["--version"], 5000);
  const output = `${res.stdout}\n${res.stderr}`.trim();
  const version = parseVersion(output);
  if (!version) {
    return null;
  }
  return { command, version };
}

function windowsNodeCommandCandidates(): string[] {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "", "nodejs", "node.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "", "nodejs", "node.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "node.exe")
  ];
  return candidates.filter((candidate, index) => candidate.trim().length > 0 && candidates.indexOf(candidate) === index);
}

function npmCommandForNode(nodeCommand: string | null): string {
  if (!nodeCommand || nodeCommand === "node" || nodeCommand.toLowerCase() === "node.exe") {
    return "npm";
  }
  return path.join(path.dirname(nodeCommand), process.platform === "win32" ? "npm.cmd" : "npm");
}

async function resolveNpmGlobalPrefix(npmCommand: string): Promise<string | null> {
  const res = await runCapture(npmCommand, ["config", "get", "prefix"], 5000);
  if (res.code !== 0) {
    return null;
  }

  const lines = `${res.stdout}\n${res.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("npm WARN"));
  const prefix = lines.at(-1) ?? "";
  if (!prefix || prefix.toLowerCase() === "undefined" || prefix.toLowerCase() === "null") {
    return null;
  }
  return prefix;
}

function codexCommandForNpmPrefix(prefix: string): string {
  return process.platform === "win32" ? path.join(prefix, "codex.cmd") : path.join(prefix, "bin", "codex");
}

async function defaultCodexCommandCandidates(): Promise<string[]> {
  const candidates = new Set<string>(["codex"]);

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() ?? "";
    if (appData) {
      candidates.add(path.join(appData, "npm", "codex.cmd"));
    }
  }

  const nodeRuntime = await resolveNodeRuntime();
  if (nodeRuntime.version) {
    const prefix = await resolveNpmGlobalPrefix(npmCommandForNode(nodeRuntime.command));
    if (prefix) {
      candidates.add(codexCommandForNpmPrefix(prefix));
    }
  }

  return [...candidates];
}

async function resolveCodexCli(): Promise<{
  resolution: CodexCliResolution | null;
  output: string;
  usesDefaultCommand: boolean;
}> {
  const { command, usesDefaultCommand } = configuredCodexCommand();
  const probe = await probeVersionCommand(command);
  if (probe.version) {
    return {
      resolution: {
        command: probe.command,
        output: probe.output,
        version: probe.version
      },
      output: probe.output,
      usesDefaultCommand
    };
  }

  if (!usesDefaultCommand) {
    return { resolution: null, output: probe.output, usesDefaultCommand };
  }

  const candidates = await defaultCodexCommandCandidates();
  for (const candidate of candidates) {
    if (candidate === probe.command) {
      continue;
    }

    const fallbackProbe = await probeVersionCommand(candidate);
    if (fallbackProbe.version) {
      return {
        resolution: {
          command: fallbackProbe.command,
          output: fallbackProbe.output,
          version: fallbackProbe.version
        },
        output: probe.output,
        usesDefaultCommand
      };
    }
  }

  return { resolution: null, output: probe.output, usesDefaultCommand };
}

async function detectNodeRuntime(): Promise<{ installed: boolean; version: string | null }> {
  const runtime = await resolveNodeRuntime();
  return { installed: Boolean(runtime.version), version: runtime.version };
}

async function detectVcRedistX64(): Promise<{ installed: boolean | null; version: string | null }> {
  if (process.platform !== "win32") {
    return { installed: null, version: null };
  }

  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64"
  ];

  for (const key of keys) {
    const res = await runCapture("reg", ["query", key], 5000);
    if (res.code !== 0) {
      continue;
    }

    const output = `${res.stdout}\n${res.stderr}`;
    const installedMatch = output.match(/^\s*Installed\s+REG_\w+\s+(0x1|1)\s*$/im);
    const versionMatch = output.match(/^\s*Version\s+REG_\w+\s+(.+?)\s*$/im);
    return {
      installed: Boolean(installedMatch || versionMatch),
      version: versionMatch ? versionMatch[1].trim() : null
    };
  }

  return { installed: false, version: null };
}

type RuntimeInstallPlan = {
  target: CodexRuntimeInstallTarget;
  label: string;
  version: string | null;
  fileName: string;
  downloadUrl: string;
};

async function buildRuntimeInstallPlan(target: CodexRuntimeInstallTarget): Promise<RuntimeInstallPlan> {
  if (process.platform !== "win32") {
    throw new Error("Runtime installation is currently supported on Windows only.");
  }

  switch (target) {
    case "nodejs": {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const res = await fetch("https://nodejs.org/dist/index.json", { signal: ctrl.signal });
        if (!res.ok) {
          throw new Error(`Node.js manifest request failed: HTTP ${res.status}`);
        }
        const json = (await res.json()) as Array<{ version: string; lts: string | boolean; files: string[] }>;
        const spec = selectLatestNodeWindowsMsi(json);
        if (!spec) {
          throw new Error("No compatible Windows x64 Node.js installer was found.");
        }
        return { target, ...spec };
      } finally {
        clearTimeout(timeout);
      }
    }

    case "vcRedistX64":
      return { target, ...VC_REDIST_X64_INSTALLER };
  }
}

async function downloadRuntimeInstaller(plan: RuntimeInstallPlan): Promise<string> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
  try {
    const res = await fetch(plan.downloadUrl, {
      headers: { "user-agent": "TAZHAN Desktop Runtime Installer" },
      signal: ctrl.signal
    });
    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status}`);
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    const dir = path.join(app.getPath("temp"), "tazhan-runtime-installers");
    await fs.mkdir(dir, { recursive: true });
    const installerPath = path.join(dir, plan.fileName);
    await fs.writeFile(installerPath, bytes);
    return installerPath;
  } finally {
    clearTimeout(timeout);
  }
}

function runInteractiveInstaller(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      shell: false,
      windowsHide: false
    });

    child.once("error", reject);
    child.once("close", (code) => resolve(typeof code === "number" ? code : null));
  });
}

async function installRuntime(target: CodexRuntimeInstallTarget): Promise<CodexRuntimeInstallResult> {
  const label =
    target === "nodejs" ? "Node.js" : target === "vcRedistX64" ? "Visual C++ Redistributable (x64)" : target;

  try {
    const plan = await buildRuntimeInstallPlan(target);
    const installerPath = await downloadRuntimeInstaller(plan);
    const exitCode =
      target === "nodejs"
        ? await runInteractiveInstaller("msiexec.exe", ["/i", installerPath])
        : await runInteractiveInstaller(installerPath, []);

    if (target === "nodejs") {
      const nodeRuntime = await detectNodeRuntime();
      if (nodeRuntime.installed) {
        return {
          ok: true,
          target,
          label: plan.label,
          version: nodeRuntime.version ?? plan.version,
          installerPath,
          error: null
        };
      }
    } else {
      const vcRedist = await detectVcRedistX64();
      if (vcRedist.installed) {
        return {
          ok: true,
          target,
          label: plan.label,
          version: vcRedist.version ?? plan.version,
          installerPath,
          error: null
        };
      }
    }

    return {
      ok: false,
      target,
      label: plan.label,
      version: plan.version,
      installerPath,
      error: `Installer exited before ${label} was detected${typeof exitCode === "number" ? ` (code ${exitCode})` : ""}.`
    };
  } catch (err) {
    return {
      ok: false,
      target,
      label,
      version: null,
      installerPath: null,
      error: String(err)
    };
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10));
  const pb = b.split(".").map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (av < bv) {
      return -1;
    }
    if (av > bv) {
      return 1;
    }
  }
  return 0;
}

function escapeRegex(text: string): string {
  return text.replaceAll(/[$()*+./?[\\\]^{|}-]/g, "\\$&");
}

function detectNewline(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function maskApiKey(raw: string): string {
  const v = raw.trim();
  if (!v) {
    return "****";
  }
  if (v.length <= 8) {
    return `${v.slice(0, 2)}****`;
  }
  const prefix = v.startsWith("sk-") ? "sk-" : v.slice(0, 2);
  const suffix = v.slice(-4);
  return `${prefix}****${suffix}`;
}

function parseTomlStringValue(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^"([^"]*)"|'([^']*)'/);
  if (!m) {
    return null;
  }
  return (m[1] ?? m[2] ?? "").trim();
}

function parseCodexModel(configToml: string): string | null {
  const match = configToml.match(/^\s*model\s*=\s*("[^"]*"|'[^']*')/m);
  return match ? parseTomlStringValue(match[1] ?? "") : null;
}

function parseCodexModelProvider(configToml: string): string | null {
  const match = configToml.match(/^\s*model_provider\s*=\s*("[^"]*"|'[^']*')/m);
  return match ? parseTomlStringValue(match[1] ?? "") : null;
}

function parseCodexBaseUrlForProvider(configToml: string, provider: string): string | null {
  const lines = configToml.split(/\r?\n/);
  const sectionRe = new RegExp(
    `^\\s*\\[\\s*model_providers\\.(?:"${escapeRegex(provider)}"|${escapeRegex(provider)})\\s*\\]\\s*$`
  );
  let inSection = false;
  for (const line of lines) {
    if (sectionRe.test(line)) {
      inSection = true;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) {
      continue;
    }

    const match = line.match(/^\s*base_url\s*=\s*("[^"]*"|'[^']*')/);
    if (!match) {
      continue;
    }
    return parseTomlStringValue(match[1] ?? "");
  }
  return null;
}

function parseCodexAnyProviderBaseUrl(configToml: string): { provider: string; baseUrl: string } | null {
  const lines = configToml.split(/\r?\n/);
  let currentProvider: string | null = null;
  let inProviderSection = false;

  for (const line of lines) {
    const sec = line.match(/^\s*\[\s*model_providers\.(?:"([^"]+)"|([^\]\s]+))\s*\]\s*$/);
    if (sec) {
      currentProvider = (sec[1] ?? sec[2] ?? "").trim() || null;
      inProviderSection = Boolean(currentProvider);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      currentProvider = null;
      inProviderSection = false;
      continue;
    }
    if (!inProviderSection || !currentProvider) {
      continue;
    }

    const match = line.match(/^\s*base_url\s*=\s*("[^"]*"|'[^']*')/);
    if (!match) {
      continue;
    }
    const baseUrl = parseTomlStringValue(match[1] ?? "");
    if (baseUrl) {
      return { provider: currentProvider, baseUrl };
    }
  }

  return null;
}

function isSafeProviderId(provider: string): boolean {
  const v = provider.trim();
  if (!v) {
    return false;
  }
  // Keep this strict so we can write `[model_providers.<id>]` without quoting.
  return /^[a-zA-Z0-9_-]+$/.test(v);
}

function upsertCodexModelProvider(configToml: string, provider: string): string {
  const newline = detectNewline(configToml);
  const lines = configToml.split(/\r?\n/);
  const wanted = `model_provider = "${provider}"`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = line.match(/^(\s*)model_provider\s*=\s*("[^"]*"|'[^']*'|[^#\s]+)?(\s*#.*)?$/);
    if (!match) {
      continue;
    }
    const indent = match[1] ?? "";
    const comment = (match[3] ?? "").trimEnd();
    lines[i] = `${indent}${wanted}${comment ? ` ${comment.trimStart()}` : ""}`;
    return lines.join(newline);
  }

  const out: string[] = [];
  let inserted = false;
  for (const line of lines) {
    if (!inserted) {
      const t = line.trim();
      const isComment = t.startsWith("#");
      const isBlank = t.length === 0;
      if (!isComment && !isBlank) {
        out.push(wanted, "");
        inserted = true;
      }
    }
    out.push(line);
  }
  if (!inserted) {
    out.push(wanted);
  }
  return out.join(newline);
}

function upsertCodexModel(configToml: string, model: string): string {
  const newline = detectNewline(configToml);
  const lines = configToml.split(/\r?\n/);
  const wanted = `model = "${model}"`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = line.match(/^(\s*)model\s*=\s*("[^"]*"|'[^']*'|[^#\s]+)?(\s*#.*)?$/);
    if (!match) {
      continue;
    }
    const indent = match[1] ?? "";
    const comment = (match[3] ?? "").trimEnd();
    lines[i] = `${indent}${wanted}${comment ? ` ${comment.trimStart()}` : ""}`;
    return lines.join(newline);
  }

  const out: string[] = [];
  let inserted = false;
  for (const line of lines) {
    if (!inserted) {
      const trimmed = line.trim();
      const isComment = trimmed.startsWith("#");
      const isBlank = trimmed.length === 0;
      if (!isComment && !isBlank) {
        out.push(wanted, "");
        inserted = true;
      }
    }
    out.push(line);
  }

  if (!inserted) {
    out.push(wanted);
  }
  return out.join(newline);
}

function removeCodexModel(configToml: string): string {
  const newline = detectNewline(configToml);
  const lines = configToml
    .split(/\r?\n/)
    .filter((line) => !/^\s*model\s*=\s*("[^"]*"|'[^']*'|[^#\s]+)?(\s*#.*)?$/.test(line));
  return lines.join(newline);
}

function providerSectionRange(lines: string[], provider: string): { start: number; end: number } | null {
  const sectionRe = new RegExp(
    `^\\s*\\[\\s*model_providers\\.(?:"${escapeRegex(provider)}"|${escapeRegex(provider)})\\s*\\]\\s*$`
  );

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (sectionRe.test(lines[i] ?? "")) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }

  return { start, end };
}

function materializeProviderSectionFromTemplate(
  configToml: string,
  templateProvider: string,
  targetProvider: string,
  baseUrl: string
): string | null {
  const newline = detectNewline(configToml);
  const lines = configToml.split(/\r?\n/);
  const range = providerSectionRange(lines, templateProvider);
  if (!range) {
    return null;
  }

  const templateBody = lines.slice(range.start + 1, range.end);
  const outBody: string[] = [];

  let sawBaseUrl = false;
  let sawName = false;
  for (const rawLine of templateBody) {
    const line = rawLine ?? "";
    const baseMatch = line.match(/^(\s*)base_url\s*=\s*("[^"]*"|'[^']*'|[^#\s]+)?(\s*#.*)?$/);
    if (baseMatch) {
      const indent = baseMatch[1] ?? "";
      const comment = (baseMatch[3] ?? "").trimEnd();
      outBody.push(`${indent}base_url = "${baseUrl}"${comment ? ` ${comment.trimStart()}` : ""}`);
      sawBaseUrl = true;
      continue;
    }

    const nameMatch = line.match(/^(\s*)name\s*=\s*("[^"]*"|'[^']*'|[^#\s]+)?(\s*#.*)?$/);
    if (nameMatch) {
      const indent = nameMatch[1] ?? "";
      const comment = (nameMatch[3] ?? "").trimEnd();
      outBody.push(`${indent}name = "${targetProvider}"${comment ? ` ${comment.trimStart()}` : ""}`);
      sawName = true;
      continue;
    }

    outBody.push(line);
  }

  if (!sawName) {
    outBody.unshift(`name = "${targetProvider}"`);
  }
  if (!sawBaseUrl) {
    outBody.unshift(`base_url = "${baseUrl}"`);
  }

  return [`[model_providers.${targetProvider}]`, ...outBody].join(newline);
}

function ensureCodexProviderSection(configToml: string, provider: string, baseUrl: string): string {
  const newline = detectNewline(configToml);
  const lines = configToml.split(/\r?\n/);
  const existing = providerSectionRange(lines, provider);
  if (existing) {
    return upsertCodexBaseUrl(configToml, provider, baseUrl);
  }

  const templateProvider = parseCodexModelProvider(configToml) ?? parseCodexAnyProviderBaseUrl(configToml)?.provider ?? "";
  const templated =
    templateProvider.trim().length > 0
      ? materializeProviderSectionFromTemplate(configToml, templateProvider, provider, baseUrl)
      : null;

  const fallback = [`[model_providers.${provider}]`, `name = "${provider}"`, `base_url = "${baseUrl}"`, `wire_api = "responses"`, `requires_openai_auth = true`].join(
    newline
  );
  const sectionText = templated ?? fallback;

  const trimmed = lines.join(newline).trimEnd();
  const out: string[] = trimmed.length ? [...lines] : [];
  if (out.length && out[out.length - 1]?.trim()) {
    out.push("");
  }
  out.push(sectionText, "");
  return out.join(newline);
}

function upsertCodexBaseUrl(configToml: string, provider: string, baseUrl: string): string {
  const newline = detectNewline(configToml);
  const lines = configToml.split(/\r?\n/);
  const sectionRe = new RegExp(
    `^\\s*\\[\\s*model_providers\\.(?:"${escapeRegex(provider)}"|${escapeRegex(provider)})\\s*\\]\\s*$`
  );

  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (sectionRe.test(lines[i] ?? "")) {
      sectionStart = i;
      break;
    }
  }

  const wantedLine = `base_url = "${baseUrl}"`;

  if (sectionStart === -1) {
    const trimmed = lines.join(newline).trim();
    const out: string[] = trimmed.length ? [...lines] : [];
    if (out.length && out[out.length - 1]?.trim()) {
      out.push("");
    }
    out.push(`[model_providers.${provider}]`, wantedLine);
    return out.join(newline);
  }

  // Find an existing base_url line in the section.
  let insertAt = sectionStart + 1;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*\[/.test(line)) {
      insertAt = i;
      break;
    }
    insertAt = i + 1;
    const m = line.match(/^(\s*)base_url\s*=\s*("[^"]*"|'[^']*'|[^#\s]+)?(\s*#.*)?$/);
    if (!m) {
      continue;
    }

    const indent = m[1] ?? "";
    const comment = (m[3] ?? "").trimEnd();
    lines[i] = `${indent}${wantedLine}${comment ? ` ${comment.trimStart()}` : ""}`;
    return lines.join(newline);
  }

  lines.splice(insertAt, 0, wantedLine);
  return lines.join(newline);
}

function codexHomeDir(): string {
  const configured = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME : "";
  if (configured.trim()) {
    return path.resolve(configured.trim());
  }

  // NOTE: On Windows, some tools set the `HOME` env var to a non-user directory
  // (e.g. Git/MSYS/Cygwin). `os.homedir()` uses USERPROFILE / known folders and
  // is much more reliable for locating `C:\\Users\\<name>\\.codex`.
  return path.join(os.homedir(), ".codex");
}

async function readCodexUserConfig(): Promise<CodexUserConfigReadResult> {
  const codexHome = codexHomeDir();
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");

  let model = "";
  let modelProvider: string | null = null;
  let baseUrl = "";
  let apiKeyPresent = false;
  let apiKeyMasked: string | null = null;
  const errors: string[] = [];

  const ensured = await ensureCodexUserConfigFiles();
  if (!ensured.ok && ensured.error) {
    errors.push(`ensure: ${ensured.error}`);
  }

  try {
    const configToml = await fs.readFile(configPath, "utf8");
    model = parseCodexModel(configToml) ?? "";
    const provider = parseCodexModelProvider(configToml);
    let nextProvider = provider;
    let nextBaseUrl = provider ? parseCodexBaseUrlForProvider(configToml, provider) : null;
    if (!nextBaseUrl) {
      const any = parseCodexAnyProviderBaseUrl(configToml);
      if (any) {
        nextProvider = nextProvider ?? any.provider;
        nextBaseUrl = any.baseUrl;
      }
    }

    modelProvider = nextProvider;
    baseUrl = nextBaseUrl ?? "";
  } catch (err) {
    errors.push(`config.toml: ${String(err)}`);
  }

  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    const key =
      parsed && typeof parsed.OPENAI_API_KEY === "string"
        ? parsed.OPENAI_API_KEY
        : parsed && typeof parsed.apiKey === "string"
          ? parsed.apiKey
          : parsed && typeof parsed.apikey === "string"
            ? parsed.apikey
            : "";

    const trimmed = String(key ?? "").trim();
    apiKeyPresent = trimmed.length > 0;
    apiKeyMasked = apiKeyPresent ? maskApiKey(trimmed) : null;
  } catch (err) {
    errors.push(`auth.json: ${String(err)}`);
  }

  const ok = errors.length === 0;
  return {
    ok,
    codexHome,
    configPath,
    authPath,
    model,
    modelProvider,
    baseUrl,
    apiKeyPresent,
    apiKeyMasked,
    error: ok ? null : errors.join("; ")
  };
}

async function writeCodexUserConfig(args: CodexUserConfigWriteArgs): Promise<CodexUserConfigWriteResult> {
  const codexHome = codexHomeDir();
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");

  const shouldUpdateModel = typeof args.model === "string";
  const nextModel = typeof args.model === "string" ? args.model.trim() : "";
  const requestedProvider = typeof args.modelProvider === "string" ? args.modelProvider.trim() : "";
  const nextBaseUrl = typeof args.baseUrl === "string" ? args.baseUrl.trim() : "";
  const nextApiKey = typeof args.apiKey === "string" ? args.apiKey.trim() : "";
  const clearApiKey = Boolean(args.clearApiKey);
  const hasAuthUpdate = clearApiKey || nextApiKey.length > 0;

  if (!nextBaseUrl && requestedProvider) {
    return { ok: false, error: "Base URL is required when modelProvider is set" };
  }

  if (!nextBaseUrl && !requestedProvider && !shouldUpdateModel && !hasAuthUpdate) {
    return { ok: false, error: "No config changes provided" };
  }

  if (requestedProvider && !isSafeProviderId(requestedProvider)) {
    return { ok: false, error: "Provider 标识不合法（仅允许字母/数字/下划线/短横线）" };
  }

  try {
    await fs.mkdir(codexHome, { recursive: true });
  } catch (err) {
    return { ok: false, error: `无法创建 Codex 配置目录: ${String(err)}` };
  }

  try {
    let configToml = "";
    try {
      configToml = await fs.readFile(configPath, "utf8");
    } catch {
      configToml = "";
    }

    const provider =
      requestedProvider ||
      parseCodexModelProvider(configToml) ||
      parseCodexAnyProviderBaseUrl(configToml)?.provider ||
      "custom";

    let patched = configToml.trim().length > 0 ? configToml : "";
    if (!patched && nextBaseUrl) {
      patched = `model_provider = "${provider}"

[model_providers.${provider}]
name = "${provider}"
base_url = "${nextBaseUrl}"
wire_api = "responses"
requires_openai_auth = true
`;
    } else if (patched) {
      if (requestedProvider && nextBaseUrl) {
        patched = ensureCodexProviderSection(patched, provider, nextBaseUrl);
        patched = upsertCodexModelProvider(patched, provider);
      } else if (nextBaseUrl) {
        patched = upsertCodexBaseUrl(patched, provider, nextBaseUrl);
      }
    }

    if (shouldUpdateModel) {
      patched = nextModel ? upsertCodexModel(patched, nextModel) : removeCodexModel(patched);
    }

    if (!patched.trim()) {
      patched = shouldUpdateModel && nextModel ? `model = "${nextModel}"
` : "";
    }

    await fs.writeFile(configPath, patched, { encoding: "utf8" });
  } catch (err) {
    return { ok: false, error: `写入 config.toml 失败: ${String(err)}` };
  }

  if (clearApiKey || nextApiKey) {
    try {
      let auth: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(authPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown> | null;
        auth = parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        auth = {};
      }

      if (clearApiKey) {
        delete auth.OPENAI_API_KEY;
        delete auth.apiKey;
        delete auth.apikey;
      } else {
        auth.OPENAI_API_KEY = nextApiKey;
      }

      await fs.writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8" });
    } catch (err) {
      return { ok: false, error: `写入 auth.json 失败: ${String(err)}` };
    }
  }

  return { ok: true, error: null };
}

function normalizeBaseUrl(baseUrl: string): string {
  let v = baseUrl.trim();
  while (v.endsWith("/")) {
    v = v.slice(0, -1);
  }
  return v;
}

function activeApiProfile(): { baseUrl: string; apiKey: string } | null {
  const s = settings;
  if (!s) {
    return null;
  }
  const profiles = s.apiProfiles ?? [];
  const active = s.apiActiveProfileId ? profiles.find((p) => p.id === s.apiActiveProfileId) ?? null : null;
  const chosen = active ?? profiles[0] ?? null;
  if (!chosen) {
    return null;
  }
  const baseUrl = normalizeBaseUrl(chosen.baseUrl ?? "");
  const apiKey = String(chosen.apiKey ?? "").trim();
  if (!baseUrl || !apiKey) {
    return null;
  }
  return { baseUrl, apiKey };
}

async function fallbackApiProfileFromCodexHome(): Promise<{ baseUrl: string; apiKey: string } | null> {
  const info = await readCodexUserConfig();
  const baseUrl = normalizeBaseUrl(info.baseUrl ?? "");
  if (!baseUrl) {
    return null;
  }

  const authPath = path.join(codexHomeDir(), "auth.json");
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    const key =
      parsed && typeof parsed.OPENAI_API_KEY === "string"
        ? parsed.OPENAI_API_KEY
        : parsed && typeof parsed.apiKey === "string"
          ? parsed.apiKey
          : parsed && typeof parsed.apikey === "string"
            ? parsed.apikey
            : "";
    const apiKey = String(key ?? "").trim();
    if (!apiKey) {
      return null;
    }
    return { baseUrl, apiKey };
  } catch {
    return null;
  }
}

function parseAssistantContentFromChatCompletions(json: any): string | null {
  try {
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content;
    }
  } catch {
    // Best-effort.
  }
  return null;
}

async function llmChatComplete(args: LlmChatCompleteArgs): Promise<LlmChatCompleteResult> {
  const profile = activeApiProfile() ?? (await fallbackApiProfileFromCodexHome());
  if (!profile) {
    return { ok: false, text: "", error: "API 提供商未配置或缺少 Base URL / API Key" };
  }

  const messages = Array.isArray(args?.messages) ? args.messages : [];
  const cleaned = messages
    .map((m) => ({
      role: m && typeof (m as any).role === "string" ? String((m as any).role) : "",
      content: m && typeof (m as any).content === "string" ? String((m as any).content) : ""
    }))
    .filter(
      (m) => (m.role === "system" || m.role === "user" || m.role === "assistant") && m.content.trim().length > 0
    );
  if (cleaned.length === 0) {
    return { ok: false, text: "", error: "messages 不能为空" };
  }

  const model = typeof args?.model === "string" ? args.model.trim() : "";
  const chosenModel = model.length > 0 ? model : settings?.model?.trim() ?? "";
  if (!chosenModel) {
    return { ok: false, text: "", error: "缺少 model（请先选择模型）" };
  }

  const temperature =
    typeof args?.temperature === "number" && Number.isFinite(args.temperature) ? args.temperature : 0.2;
  const maxTokens =
    typeof args?.maxOutputTokens === "number" && Number.isFinite(args.maxOutputTokens)
      ? Math.max(1, Math.floor(args.maxOutputTokens))
      : null;

  const body: any = {
    model: chosenModel,
    messages: cleaned,
    temperature
  };
  if (maxTokens) {
    body.max_tokens = maxTokens;
  }

  const attempts: { url: string }[] = [];
  attempts.push({ url: `${profile.baseUrl}/chat/completions` });
  if (!/\/v1$/i.test(profile.baseUrl)) {
    attempts.push({ url: `${profile.baseUrl}/v1/chat/completions` });
  }

  for (const attempt of attempts) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(attempt.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${profile.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const msg = text.trim().length ? `HTTP ${res.status}: ${text.slice(0, 600)}` : `HTTP ${res.status}`;
        if (res.status === 404 && attempts.length > 1) {
          continue;
        }
        return { ok: false, text: "", error: msg };
      }

      const json: any = await res.json().catch(() => null);
      const content = parseAssistantContentFromChatCompletions(json);
      if (content === null) {
        return { ok: false, text: "", error: "响应格式不兼容（无法解析 assistant content）" };
      }
      return { ok: true, text: content, error: null };
    } catch (err) {
      if (attempts.length > 1) {
        continue;
      }
      return { ok: false, text: "", error: String(err) };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, text: "", error: "请求失败（请检查 Base URL 是否需要 /v1 前缀）" };
}

async function testProvider(baseUrlRaw: string, apiKeyRaw: string): Promise<CodexProviderTestResult> {
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const apiKey = apiKeyRaw.trim();
  if (!baseUrl) {
    return { ok: false, latencyMs: null, status: null, modelsCount: null, suggestedBaseUrl: null, error: "Base URL 不能为空" };
  }
  if (!apiKey) {
    return { ok: false, latencyMs: null, status: null, modelsCount: null, suggestedBaseUrl: null, error: "API Key 不能为空" };
  }

  const attempts: { url: string; suggestedBaseUrl: string | null }[] = [];
  attempts.push({ url: `${baseUrl}/models`, suggestedBaseUrl: null });
  if (!/\/v1$/i.test(baseUrl)) {
    attempts.push({ url: `${baseUrl}/v1/models`, suggestedBaseUrl: `${baseUrl}/v1` });
  }

  for (const attempt of attempts) {
    const ctrl = new AbortController();
    const started = Date.now();
    const timeout = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(attempt.url, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal
      });
      const latencyMs = Date.now() - started;

      if (!res.ok) {
        if (res.status === 404 && attempt.suggestedBaseUrl) {
          continue;
        }
        const text = await res.text().catch(() => "");
        return {
          ok: false,
          latencyMs,
          status: res.status,
          modelsCount: null,
          suggestedBaseUrl: attempt.suggestedBaseUrl,
          error: text.trim().length ? `HTTP ${res.status}: ${text.slice(0, 300)}` : `HTTP ${res.status}`
        };
      }

      const json: any = await res.json().catch(() => null);
      const list = Array.isArray(json?.data) ? json.data : null;
      return {
        ok: true,
        latencyMs,
        status: res.status,
        modelsCount: list ? list.length : null,
        suggestedBaseUrl: attempt.suggestedBaseUrl,
        error: null
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (attempt.suggestedBaseUrl) {
        // The second attempt might succeed; keep trying.
        continue;
      }
      return {
        ok: false,
        latencyMs,
        status: null,
        modelsCount: null,
        suggestedBaseUrl: null,
        error: String(err)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, latencyMs: null, status: 404, modelsCount: null, suggestedBaseUrl: `${baseUrl}/v1`, error: "可能缺少 /v1 前缀" };
}

function normalizePathForCompare(p: string): string {
  const abs = path.resolve(p);
  if (process.platform === "win32") {
    return abs.replaceAll("/", "\\").toLowerCase();
  }
  return abs;
}

function isWithinRoot(root: string, target: string): boolean {
  const rootKey = normalizePathForCompare(root);
  const targetKey = normalizePathForCompare(target);
  if (targetKey === rootKey) {
    return true;
  }
  const prefix = rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`;
  return targetKey.startsWith(prefix);
}

function isSafeName(name: string): boolean {
  const v = name.trim();
  if (!v) {
    return false;
  }
  if (v.includes("\0")) {
    return false;
  }
  // Disallow path traversal / separators. We keep this strict since the UI only needs a single segment name.
  if (v.includes("/") || v.includes("\\") || v === "." || v === "..") {
    return false;
  }
  return true;
}

function isWithinAnyRelayAllowedRoot(candidate: string): boolean {
  if (!settings) {
    return false;
  }
  const allowed = settings.relay.allowedRoots ?? [];
  if (allowed.length === 0) {
    return false;
  }
  const candAbs = path.resolve(candidate);
  return allowed.some((root) => isWithinRoot(path.resolve(root), candAbs));
}

function requireRelayAllowedRoot(root: string): string {
  const abs = path.resolve(root);
  if (!isWithinAnyRelayAllowedRoot(abs)) {
    throw new Error(`path is outside allowed roots: ${abs}`);
  }
  return abs;
}

class TazhanRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
  }
}

function isTazhanRpcMethod(method: string): boolean {
  return method.startsWith("tazhan/");
}

function asRpcError(err: unknown): RpcError {
  if (err instanceof TazhanRpcError) {
    return err.data === undefined ? { code: err.code, message: err.message } : { code: err.code, message: err.message, data: err.data };
  }
  if (err instanceof Error) {
    return { code: -32000, message: err.message };
  }
  return { code: -32000, message: String(err) };
}

function getStringParam(params: unknown, key: string): string {
  if (!isRecord(params)) {
    return "";
  }
  const v = params[key];
  return typeof v === "string" ? v : "";
}

function getNumberParam(params: unknown, key: string): number | null {
  if (!isRecord(params)) {
    return null;
  }
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function getStringArrayParam(params: unknown, key: string): string[] {
  if (!isRecord(params)) {
    return [];
  }
  const v = params[key];
  if (!Array.isArray(v)) {
    return [];
  }
  return v.filter((it): it is string => typeof it === "string").map((s) => s.trim()).filter(Boolean);
}

function workspaceLabel(rootAbs: string): string {
  const s = settings;
  if (!s) {
    return rootAbs;
  }
  const exact = s.workspaceNames?.[rootAbs];
  if (typeof exact === "string" && exact.trim()) {
    return exact.trim();
  }
  const entries = Object.entries(s.workspaceNames ?? {});
  const key = normalizePathForCompare(rootAbs);
  for (const [k, v] of entries) {
    if (normalizePathForCompare(k) === key && v.trim()) {
      return v.trim();
    }
  }
  const base = path.basename(rootAbs);
  return base || rootAbs;
}

async function dispatchTazhanRequest(method: string, rawParams: unknown): Promise<unknown> {
  if (!settings) {
    throw new TazhanRpcError(-32000, "settings not loaded");
  }

  switch (method) {
    case "tazhan/workspace/listRoots": {
      const roots = (settings.relay.allowedRoots ?? []).map((p) => path.resolve(p));
      const data = roots.map((p) => ({ path: p, label: workspaceLabel(p) }));
      return { ok: true, roots: data, error: null };
    }

    case "tazhan/workspace/listDir": {
      const root = getStringParam(rawParams, "root");
      const dir = getStringParam(rawParams, "dir");
      if (!root || !dir) {
        throw new TazhanRpcError(-32602, "missing root or dir");
      }

      const rootAbs = requireRelayAllowedRoot(root);
      const dirAbs = path.resolve(dir);
      if (!isWithinRoot(rootAbs, dirAbs)) {
        return { ok: false, entries: [], error: "path is outside the workspace root" } satisfies WorkspaceListDirResult;
      }

      try {
        const items = await fs.readdir(dirAbs, { withFileTypes: true });
        const entries: WorkspaceDirEntry[] = items.map((it) => ({
          name: it.name,
          path: path.join(dirAbs, it.name),
          kind: it.isDirectory() ? "dir" : "file"
        }));

        entries.sort((a, b) => {
          if (a.kind !== b.kind) {
            return a.kind === "dir" ? -1 : 1;
          }
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });

        return { ok: true, entries, error: null } satisfies WorkspaceListDirResult;
      } catch (err) {
        return { ok: false, entries: [], error: String(err) } satisfies WorkspaceListDirResult;
      }
    }

    case "tazhan/workspace/readFile": {
      const root = getStringParam(rawParams, "root");
      const filePath = getStringParam(rawParams, "path");
      if (!root || !filePath) {
        throw new TazhanRpcError(-32602, "missing root or path");
      }

      const rootAbs = requireRelayAllowedRoot(root);
      const fileAbs = path.resolve(filePath);
      if (!isWithinRoot(rootAbs, fileAbs)) {
        return { ok: false, content: "", truncated: false, error: "path is outside the workspace root" } satisfies WorkspaceReadFileResult;
      }

      const maxBytes = 400_000;
      try {
        const stat = await fs.stat(fileAbs);
        if (stat.isDirectory()) {
          return { ok: false, content: "", truncated: false, error: "path is a directory" } satisfies WorkspaceReadFileResult;
        }

        const toRead = Math.min(stat.size, maxBytes);
        const fh = await fs.open(fileAbs, "r");
        try {
          const buf = Buffer.alloc(toRead);
          await fh.read(buf, 0, toRead, 0);
          const content = buf.toString("utf8");
          const truncated = stat.size > maxBytes;
          return { ok: true, content, truncated, error: null } satisfies WorkspaceReadFileResult;
        } finally {
          await fh.close();
        }
      } catch (err) {
        return { ok: false, content: "", truncated: false, error: String(err) } satisfies WorkspaceReadFileResult;
      }
    }

    case "tazhan/workspace/mkdir": {
      const root = getStringParam(rawParams, "root");
      const parentDir = getStringParam(rawParams, "parentDir");
      const name = getStringParam(rawParams, "name");
      if (!root || !parentDir) {
        throw new TazhanRpcError(-32602, "missing root or parentDir");
      }
      if (!isSafeName(name)) {
        return { ok: false, path: null, error: "invalid name" } satisfies WorkspacePathResult;
      }

      const rootAbs = requireRelayAllowedRoot(root);
      const parentAbs = path.resolve(parentDir);
      const targetAbs = path.join(parentAbs, name.trim());
      if (!isWithinRoot(rootAbs, parentAbs) || !isWithinRoot(rootAbs, targetAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" } satisfies WorkspacePathResult;
      }

      try {
        await fs.mkdir(targetAbs, { recursive: false });
        return { ok: true, path: targetAbs, error: null } satisfies WorkspacePathResult;
      } catch (err) {
        return { ok: false, path: null, error: String(err) } satisfies WorkspacePathResult;
      }
    }

    case "tazhan/workspace/createFile": {
      const root = getStringParam(rawParams, "root");
      const parentDir = getStringParam(rawParams, "parentDir");
      const name = getStringParam(rawParams, "name");
      if (!root || !parentDir) {
        throw new TazhanRpcError(-32602, "missing root or parentDir");
      }
      if (!isSafeName(name)) {
        return { ok: false, path: null, error: "invalid name" } satisfies WorkspacePathResult;
      }

      const rootAbs = requireRelayAllowedRoot(root);
      const parentAbs = path.resolve(parentDir);
      const targetAbs = path.join(parentAbs, name.trim());
      if (!isWithinRoot(rootAbs, parentAbs) || !isWithinRoot(rootAbs, targetAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" } satisfies WorkspacePathResult;
      }

      try {
        await fs.writeFile(targetAbs, "", { encoding: "utf8", flag: "wx" });
        return { ok: true, path: targetAbs, error: null } satisfies WorkspacePathResult;
      } catch (err) {
        return { ok: false, path: null, error: String(err) } satisfies WorkspacePathResult;
      }
    }

    case "tazhan/workspace/rename": {
      const root = getStringParam(rawParams, "root");
      const fromPath = getStringParam(rawParams, "path");
      const newName = getStringParam(rawParams, "newName");
      if (!root || !fromPath) {
        throw new TazhanRpcError(-32602, "missing root or path");
      }
      if (!isSafeName(newName)) {
        return { ok: false, path: null, error: "invalid newName" } satisfies WorkspacePathResult;
      }

      const rootAbs = requireRelayAllowedRoot(root);
      const fromAbs = path.resolve(fromPath);
      if (!isWithinRoot(rootAbs, fromAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" } satisfies WorkspacePathResult;
      }
      if (fromAbs === rootAbs) {
        return { ok: false, path: null, error: "cannot rename the workspace root" } satisfies WorkspacePathResult;
      }

      const toAbs = path.join(path.dirname(fromAbs), newName.trim());
      if (!isWithinRoot(rootAbs, toAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" } satisfies WorkspacePathResult;
      }

      try {
        await fs.rename(fromAbs, toAbs);
        return { ok: true, path: toAbs, error: null } satisfies WorkspacePathResult;
      } catch (err) {
        return { ok: false, path: null, error: String(err) } satisfies WorkspacePathResult;
      }
    }

    case "tazhan/workspace/delete": {
      const root = getStringParam(rawParams, "root");
      const targetPath = getStringParam(rawParams, "path");
      if (!root || !targetPath) {
        throw new TazhanRpcError(-32602, "missing root or path");
      }

      const rootAbs = requireRelayAllowedRoot(root);
      const targetAbs = path.resolve(targetPath);
      if (!isWithinRoot(rootAbs, targetAbs)) {
        return { ok: false, error: "path is outside the workspace root" } satisfies WorkspaceOpResult;
      }
      if (targetAbs === rootAbs) {
        return { ok: false, error: "cannot delete the workspace root" } satisfies WorkspaceOpResult;
      }

      try {
        await fs.rm(targetAbs, { recursive: true, force: true });
        return { ok: true, error: null } satisfies WorkspaceOpResult;
      } catch (err) {
        return { ok: false, error: String(err) } satisfies WorkspaceOpResult;
      }
    }

    case "tazhan/workspace/writeFile": {
      const root = getStringParam(rawParams, "root");
      const filePath = getStringParam(rawParams, "path");
      const content = getStringParam(rawParams, "content");
      if (!root || !filePath) {
        throw new TazhanRpcError(-32602, "missing root or path");
      }

      const rootAbs = requireRelayAllowedRoot(root);
      const fileAbs = path.resolve(filePath);
      if (!isWithinRoot(rootAbs, fileAbs)) {
        return { ok: false, error: "path is outside the workspace root" } satisfies WorkspaceOpResult;
      }

      try {
        await fs.mkdir(path.dirname(fileAbs), { recursive: true });
      } catch (err) {
        return { ok: false, error: `failed to create parent directories: ${String(err)}` } satisfies WorkspaceOpResult;
      }

      try {
        const stat = await fs.stat(fileAbs);
        if (stat.isDirectory()) {
          return { ok: false, error: "path is a directory" } satisfies WorkspaceOpResult;
        }
      } catch {
        // If stat fails, we still attempt to write (creating a new file is ok).
      }

      try {
        await fs.writeFile(fileAbs, content, { encoding: "utf8" });
        return { ok: true, error: null } satisfies WorkspaceOpResult;
      } catch (err) {
        return { ok: false, error: String(err) } satisfies WorkspaceOpResult;
      }
    }

    case "tazhan/workspace/watchSet": {
      const root = getStringParam(rawParams, "root");
      const dirs = getStringArrayParam(rawParams, "dirs");

      if (!root || dirs.length === 0) {
        workspaceWatchClear();
        return { ok: true, error: null };
      }

      if (dirs.length > 80) {
        throw new TazhanRpcError(-32602, "too many dirs (max 80)");
      }

      const rootAbs = requireRelayAllowedRoot(root);
      const dirAbsList = dirs.map((d) => path.resolve(d));
      for (const dirAbs of dirAbsList) {
        if (!isWithinRoot(rootAbs, dirAbs)) {
          return { ok: false, error: "path is outside the workspace root" };
        }
      }

      if (!workspaceWatchState || workspaceWatchState.rootAbs !== rootAbs) {
        workspaceWatchClear();
        workspaceWatchState = { rootAbs, watchersByDir: new Map(), debounceByDir: new Map() };
      }

      const next = new Set<string>();
      for (const dirAbs of dirAbsList) {
        next.add(dirAbs);
      }

      const state = workspaceWatchState!;
      for (const [dirAbs, w] of state.watchersByDir.entries()) {
        if (next.has(dirAbs)) {
          continue;
        }
        try {
          w.close();
        } catch {
          // Best-effort.
        }
        state.watchersByDir.delete(dirAbs);
      }

      for (const dirAbs of next) {
        if (state.watchersByDir.has(dirAbs)) {
          continue;
        }
        try {
          const w = watch(dirAbs, { persistent: true, recursive: false }, () => emitWorkspaceDirChanged(rootAbs, dirAbs));
          w.on("error", () => emitWorkspaceDirChanged(rootAbs, dirAbs));
          state.watchersByDir.set(dirAbs, w);
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }

      emitWorkspaceDirChanged(rootAbs, rootAbs);
      return { ok: true, error: null };
    }

    case "tazhan/terminal/create": {
      const cwd = getStringParam(rawParams, "cwd").trim();
      const cols = getNumberParam(rawParams, "cols");
      const rows = getNumberParam(rawParams, "rows");
      if (!cwd) {
        return { ok: false, terminalId: null, error: "missing cwd" } satisfies TerminalCreateResult;
      }
      const cwdAbs = requireRelayAllowedRoot(cwd);
      const c = cols !== null && cols > 0 ? Math.floor(cols) : 80;
      const r = rows !== null && rows > 0 ? Math.floor(rows) : 24;

      const id = `term_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      if (terminals.has(id)) {
        return { ok: false, terminalId: null, error: "terminal id collision" } satisfies TerminalCreateResult;
      }

      try {
        const ptyMod: any = await import("node-pty");
        const pty = ptyMod?.spawn ? ptyMod : ptyMod?.default;
        if (!pty?.spawn) {
          return { ok: false, terminalId: null, error: "node-pty is not available" } satisfies TerminalCreateResult;
        }

        const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "bash";
        const shellArgs = process.platform === "win32" ? ["-NoLogo"] : [];

        const term = pty.spawn(shell, shellArgs, {
          name: "xterm-256color",
          cols: c,
          rows: r,
          cwd: cwdAbs,
          env: { ...process.env }
        });

        const onData = (data: string) => emitTerminalToRenderer({ type: "data", terminalId: id, data });
        const onExit = (ev: any) =>
          emitTerminalToRenderer({
            type: "exit",
            terminalId: id,
            exitCode: typeof ev?.exitCode === "number" ? ev.exitCode : null,
            signal: typeof ev?.signal === "string" ? ev.signal : null
          });

        term.onData(onData);
        term.onExit(onExit);

        const session: TerminalSession = {
          id,
          scope: "local",
          write: (data: string) => {
            try {
              term.write(String(data ?? ""));
            } catch {
              // Best-effort.
            }
          },
          resize: (c2: number, r2: number) => {
            try {
              const c3 = Number.isFinite(c2) && c2 > 0 ? Math.floor(c2) : c;
              const r3 = Number.isFinite(r2) && r2 > 0 ? Math.floor(r2) : r;
              term.resize(c3, r3);
            } catch {
              // Best-effort.
            }
          },
          dispose: () => {
            try {
              term.offData(onData);
            } catch {
              // Best-effort.
            }
            try {
              term.offExit(onExit);
            } catch {
              // Best-effort.
            }
            try {
              term.kill();
            } catch {
              // Best-effort.
            }
          }
        };

        terminals.set(id, session);
        return { ok: true, terminalId: id, error: null } satisfies TerminalCreateResult;
      } catch (err) {
        return {
          ok: false,
          terminalId: null,
          error: `failed to start local terminal: ${String(err)} (node-pty may require allowing build scripts: pnpm approve-builds)`
        } satisfies TerminalCreateResult;
      }
    }

    case "tazhan/terminal/write": {
      const terminalId = getStringParam(rawParams, "terminalId");
      const data = getStringParam(rawParams, "data");
      const sess = terminalId ? terminals.get(terminalId) ?? null : null;
      if (!sess) {
        return { ok: false, error: "terminal not found" };
      }
      try {
        sess.write(data);
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

    case "tazhan/terminal/resize": {
      const terminalId = getStringParam(rawParams, "terminalId");
      const cols = getNumberParam(rawParams, "cols");
      const rows = getNumberParam(rawParams, "rows");
      const sess = terminalId ? terminals.get(terminalId) ?? null : null;
      if (!sess) {
        return { ok: false, error: "terminal not found" };
      }
      try {
        sess.resize(cols ?? 0, rows ?? 0);
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

    case "tazhan/terminal/dispose": {
      const terminalId = getStringParam(rawParams, "terminalId");
      const sess = terminalId ? terminals.get(terminalId) ?? null : null;
      if (!sess) {
        return { ok: true, error: null };
      }
      try {
        sess.dispose();
        terminals.delete(terminalId);
        return { ok: true, error: null };
      } catch (err) {
        terminals.delete(terminalId);
        return { ok: false, error: String(err) };
      }
    }

    case "tazhan/terminal/run": {
      const cwd = getStringParam(rawParams, "cwd");
      const command = getStringParam(rawParams, "command");
      const timeoutMs = getNumberParam(rawParams, "timeoutMs");

      if (!cwd.trim()) {
        return { ok: false, stdout: "", stderr: "", exitCode: null, error: "missing cwd" } satisfies TerminalRunResult;
      }
      if (!command.trim()) {
        return { ok: false, stdout: "", stderr: "", exitCode: null, error: "missing command" } satisfies TerminalRunResult;
      }

      const cwdAbs = requireRelayAllowedRoot(cwd);
      const t = timeoutMs !== null && timeoutMs > 0 ? Math.floor(timeoutMs) : 60_000;

      try {
        return await new Promise<TerminalRunResult>((resolve) => {
          const maxCapturedBytesPerStream = 300_000;
          const truncSuffix = "\n...[truncated]";

          function clampAppendUtf8(prev: string, chunk: string, maxBytes: number): { next: string; truncated: boolean } {
            if (!chunk) {
              return { next: prev, truncated: false };
            }
            const prevBytes = Buffer.byteLength(prev, "utf8");
            if (prevBytes >= maxBytes) {
              return { next: prev, truncated: true };
            }
            // Fast path.
            if (Buffer.byteLength(chunk, "utf8") <= maxBytes - prevBytes) {
              return { next: prev + chunk, truncated: false };
            }

            // Binary search the largest prefix that fits.
            let lo = 1;
            let hi = chunk.length;
            let best = 0;
            while (lo <= hi) {
              const mid = Math.floor((lo + hi) / 2);
              let cand = chunk.slice(0, mid);
              const last = cand.charCodeAt(cand.length - 1);
              if (last >= 0xd800 && last <= 0xdbff) {
                cand = cand.slice(0, -1);
              }
              const bytes = Buffer.byteLength(cand, "utf8");
              if (bytes <= maxBytes - prevBytes && cand.length > 0) {
                best = cand.length;
                lo = mid + 1;
              } else {
                hi = mid - 1;
              }
            }
            if (best <= 0) {
              return { next: prev, truncated: true };
            }
            return { next: prev + chunk.slice(0, best), truncated: true };
          }

          let stdout = "";
          let stderr = "";
          let stdoutTruncated = false;
          let stderrTruncated = false;
          let done = false;

          const child = spawn(command, { cwd: cwdAbs, shell: true, windowsHide: true });
          child.stdout?.on("data", (chunk: Buffer) => {
            if (stdoutTruncated) {
              return;
            }
            const res = clampAppendUtf8(stdout, chunk.toString("utf8"), maxCapturedBytesPerStream);
            stdout = res.next;
            if (res.truncated) {
              stdoutTruncated = true;
            }
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            if (stderrTruncated) {
              return;
            }
            const res = clampAppendUtf8(stderr, chunk.toString("utf8"), maxCapturedBytesPerStream);
            stderr = res.next;
            if (res.truncated) {
              stderrTruncated = true;
            }
          });

          const timer = setTimeout(() => {
            if (done) {
              return;
            }
            done = true;
            try {
              child.kill();
            } catch {
              // Best-effort.
            }
            if (stdoutTruncated && !stdout.endsWith(truncSuffix)) {
              const res = clampAppendUtf8(stdout, truncSuffix, maxCapturedBytesPerStream);
              stdout = res.next;
            }
            if (stderrTruncated && !stderr.endsWith(truncSuffix)) {
              const res = clampAppendUtf8(stderr, truncSuffix, maxCapturedBytesPerStream);
              stderr = res.next;
            }
            resolve({ ok: false, stdout, stderr, exitCode: null, error: "timeout" });
          }, t);

          child.on("error", (err) => {
            if (done) {
              return;
            }
            done = true;
            clearTimeout(timer);
            resolve({ ok: false, stdout, stderr: `${stderr}\n${String(err)}`.trim(), exitCode: null, error: String(err) });
          });
          child.on("close", (code) => {
            if (done) {
              return;
            }
            done = true;
            clearTimeout(timer);
            if (stdoutTruncated && !stdout.endsWith(truncSuffix)) {
              const res = clampAppendUtf8(stdout, truncSuffix, maxCapturedBytesPerStream);
              stdout = res.next;
            }
            if (stderrTruncated && !stderr.endsWith(truncSuffix)) {
              const res = clampAppendUtf8(stderr, truncSuffix, maxCapturedBytesPerStream);
              stderr = res.next;
            }
            resolve({ ok: true, stdout, stderr, exitCode: typeof code === "number" ? code : null, error: null });
          });
        });
      } catch (err) {
        return { ok: false, stdout: "", stderr: "", exitCode: null, error: String(err) } satisfies TerminalRunResult;
      }
    }

    default:
      throw new TazhanRpcError(-32601, `method not found: ${method}`);
  }
}

async function handleRelayTazhanRpc(relay: RelayDeviceClient, rpc: unknown): Promise<boolean> {
  if (isRpcRequest(rpc) && isTazhanRpcMethod(rpc.method)) {
    try {
      const result = await dispatchTazhanRequest(rpc.method, rpc.params);
      relay.sendRpc({ id: rpc.id, result } as any);
    } catch (err) {
      relay.sendRpc({ id: rpc.id, error: asRpcError(err) } as any);
    }
    return true;
  }

  if (isRpcNotification(rpc) && isTazhanRpcMethod(rpc.method)) {
    // v1: no notification-only methods; ignore for forward compatibility.
    return true;
  }

  return false;
}

async function readCodexCliInfo(): Promise<CodexCliInfo> {
  const [nodeRuntime, vcRedistX64, codexCli] = await Promise.all([
    detectNodeRuntime(),
    detectVcRedistX64(),
    resolveCodexCli()
  ]);
  const installed = Boolean(codexCli.resolution);
  const version = codexCli.resolution?.version ?? null;

  const latestVersion: string | null = null;
  const updateAvailable = false;
  let error: string | null = null;

  if (!installed) {
    error = codexCli.output.length ? codexCli.output : "codex not found";
    return {
      installed: false,
      resolvedCommand: null,
      version: null,
      latestVersion,
      updateAvailable,
      nodeInstalled: nodeRuntime.installed,
      nodeVersion: nodeRuntime.version,
      vcRedistX64Installed: vcRedistX64.installed,
      vcRedistX64Version: vcRedistX64.version,
      error
    };
  }

  return {
    installed: true,
    resolvedCommand: codexCli.resolution?.command ?? null,
    version,
    latestVersion,
    updateAvailable,
    nodeInstalled: nodeRuntime.installed,
    nodeVersion: nodeRuntime.version,
    vcRedistX64Installed: vcRedistX64.installed,
    vcRedistX64Version: vcRedistX64.version,
    error
  };
}

async function installCodexCli(): Promise<{ ok: boolean; error: string | null }> {
  const nodeRuntime = await resolveNodeRuntime();
  if (!nodeRuntime.version) {
    return {
      ok: false,
      error: "Node.js not found. Please install Node.js first from Runtime Dependencies."
    };
  }

  const npmCommand = npmCommandForNode(nodeRuntime.command);
  const res = await runCapture(npmCommand, ["install", "-g", "@openai/codex@latest"], 10 * 60 * 1000);
  if (res.code === 0) {
    return { ok: true, error: null };
  }
  const err = `${res.stdout}\n${res.stderr}`.trim() || "install failed";
  return { ok: false, error: err };
}

function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === code);
}

function defaultCodexConfigToml(): string {
  // Keep this minimal but parseable by our API settings screen (model_provider + base_url).
  return `model_provider = "custom"

[model_providers.custom]
name = "Custom"
base_url = ""
wire_api = "responses"
requires_openai_auth = true
`;
}

async function ensureCodexUserConfigFiles(): Promise<{ ok: boolean; error: string | null }> {
  const codexHome = codexHomeDir();
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const errors: string[] = [];

  try {
    await fs.mkdir(codexHome, { recursive: true });
  } catch (err) {
    errors.push(`mkdir: ${String(err)}`);
    return { ok: false, error: errors.join("; ") };
  }

  try {
    await fs.stat(configPath);
  } catch (err) {
    if (isErrno(err, "ENOENT")) {
      try {
        await fs.writeFile(configPath, defaultCodexConfigToml(), { encoding: "utf8" });
        emitToRenderer({ type: "stderr", line: `[codex] created ${configPath}` });
      } catch (writeErr) {
        errors.push(`config.toml: ${String(writeErr)}`);
      }
    } else {
      errors.push(`config.toml: ${String(err)}`);
    }
  }

  try {
    await fs.stat(authPath);
  } catch (err) {
    if (isErrno(err, "ENOENT")) {
      try {
        await fs.writeFile(authPath, "{}\n", { encoding: "utf8" });
        emitToRenderer({ type: "stderr", line: `[codex] created ${authPath}` });
      } catch (writeErr) {
        errors.push(`auth.json: ${String(writeErr)}`);
      }
    } else {
      errors.push(`auth.json: ${String(err)}`);
    }
  }

  return { ok: errors.length === 0, error: errors.length === 0 ? null : errors.join("; ") };
}

let codexCliEnsureInFlight: Promise<string> | null = null;
async function ensureCodexCliInstalled(): Promise<string> {
  if (codexCliEnsureInFlight) {
    return await codexCliEnsureInFlight;
  }

  codexCliEnsureInFlight = (async () => {
    const info = await readCodexCliInfo();
    if (info.installed && info.resolvedCommand) {
      return info.resolvedCommand;
    }

    const { usesDefaultCommand } = configuredCodexCommand();
    if (!usesDefaultCommand) {
      // If the user provided a custom path, we should not mutate their environment.
      throw new Error(info.error || "codex not found (custom path)");
    }

    throw new Error("codex not found; install it manually or set a custom Codex path in Preferences");
  })();

  try {
    return await codexCliEnsureInFlight;
  } finally {
    codexCliEnsureInFlight = null;
  }
}

async function ensureCodexLocalConnected(): Promise<void> {
  if (!codexLocal) {
    codexLocal = new CodexAppServer(emitToRenderer);
  }
  if (!settings) {
    throw new Error("settings not loaded");
  }
  const codexCommand = await ensureCodexCliInstalled();
  // Best-effort: ensure the config files exist so the API settings modal can read them.
  void ensureCodexUserConfigFiles();
  await codexLocal.connect(codexCommand, {
    name: "tazhan_desktop",
    title: "TAZHAN Desktop",
    version: app.getVersion()
  });
}

async function applySettingsPatch(patch: Partial<AppSettings>): Promise<void> {
  if (!settingsStore || !settings) {
    throw new Error("settings not loaded");
  }
  settings = mergeSettings(settings, patch);
  await settingsStore.save(settings);
}

function normalizeRelayBaseUrl(raw: string): { ok: true; baseUrl: string; insecure: boolean } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "empty baseUrl" };
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, error: "invalid baseUrl (must include http(s)://)" };
  }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: `unsupported protocol: ${u.protocol}` };
  }

  const insecure = u.protocol === "http:";
  if (insecure) {
    const allowInsecure = (process.env.TAZHAN_RELAY_ALLOW_INSECURE ?? "").trim() === "1";
    const host = u.hostname.toLowerCase();
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!allowInsecure && !isLocal) {
      return { ok: false, error: "insecure baseUrl blocked (use https:// or set TAZHAN_RELAY_ALLOW_INSECURE=1 for dev)" };
    }
  }

  // Canonicalize so downstream URL joins are stable.
  u.pathname = u.pathname.replace(/\/+$/, "");
  u.search = "";
  u.hash = "";
  return { ok: true, baseUrl: u.toString(), insecure };
}

function encryptSecretForSettings(raw: string): string {
  const v = raw.trim();
  if (!v) {
    return "";
  }
  try {
    if (typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(v);
      return `enc:${enc.toString("base64")}`;
    }
  } catch {
    // Fall back to plaintext.
  }
  return v;
}

function decryptSecretFromSettings(stored: string): string {
  const v = stored.trim();
  if (!v) {
    return "";
  }
  if (!v.startsWith("enc:")) {
    return v;
  }
  const b64 = v.slice("enc:".length);
  try {
    return safeStorage.decryptString(Buffer.from(b64, "base64"));
  } catch {
    return "";
  }
}

async function ensureRelayE2eeDeviceKeypair(): Promise<void> {
  const s = settings;
  if (!s) {
    return;
  }
  const e2ee = s.relay.e2ee;
  if (!e2ee.enabled) {
    return;
  }
  if (e2ee.deviceKeyId && e2ee.deviceEd25519PublicKey && e2ee.deviceEd25519PrivateKey) {
    return;
  }

  const generated = generateDeviceEd25519Keypair();
  emitToRenderer({
    type: "stderr",
    line: `[relay][e2ee] generated device signing key: ${generated.keyId} fp=${generated.fingerprint}`
  });

  await applySettingsPatch({
    relay: {
      e2ee: {
        deviceKeyId: generated.keyId,
        deviceEd25519PublicKey: generated.publicKeyDerB64,
        deviceEd25519PrivateKey: encryptSecretForSettings(generated.privateKeyDerB64)
      } as any
    } as any
  });
}

function configureRelayE2ee(): void {
  const s = settings;
  const relay = relayDevice;
  if (!s || !relay) {
    return;
  }

  const e2ee = s.relay.e2ee;
  relayE2ee = null;

  if (!e2ee.enabled) {
    relay.setOutgoingRpcTransform(null);
    return;
  }

  const deviceId = s.relay.auth?.deviceId ?? "";
  if (!deviceId) {
    relay.setOutgoingRpcTransform((rpc) => {
      if (isRecord(rpc) && typeof rpc.type === "string" && rpc.type.startsWith("e2ee/")) {
        return rpc as any;
      }
      if (settings?.relay.e2ee.required) {
        throw new Error("e2ee is required but deviceId is not ready");
      }
      return rpc;
    });
    return;
  }

  if (!e2ee.deviceKeyId || !e2ee.deviceEd25519PublicKey || !e2ee.deviceEd25519PrivateKey) {
    relay.setOutgoingRpcTransform((rpc) => {
      if (isRecord(rpc) && typeof rpc.type === "string" && rpc.type.startsWith("e2ee/")) {
        return rpc as any;
      }
      if (settings?.relay.e2ee.required) {
        throw new Error("e2ee is required but device keys are missing");
      }
      return rpc;
    });
    return;
  }

  try {
    relayE2ee = new E2eeDeviceSession({
      deviceId,
      e2ee,
      decryptDevicePrivateKey: decryptSecretFromSettings,
      onTrustPeer: (peer) => {
        void (async () => {
          const cur = settings;
          if (!cur) {
            return;
          }
          const existing = cur.relay.e2ee.trustedPeers ?? [];
          if (existing.some((p) => p.keyId === peer.keyId)) {
            return;
          }
          await applySettingsPatch({ relay: { e2ee: { trustedPeers: [...existing, peer] } as any } as any });
        })();
      }
    });
  } catch (err) {
    emitToRenderer({ type: "stderr", line: `[relay][e2ee] failed to initialize: ${String(err)}` });
    relayE2ee = null;
  }

  relay.setOutgoingRpcTransform((rpc) => {
    const session = relayE2ee;
    if (session) {
      return session.encryptOutgoing(rpc);
    }
    if (isRecord(rpc) && typeof rpc.type === "string" && rpc.type.startsWith("e2ee/")) {
      return rpc as any;
    }
    if (settings?.relay.e2ee.required) {
      throw new Error("e2ee is required but no session is configured");
    }
    return rpc;
  });
}

async function startRelayIfEnabled(): Promise<void> {
  if (!settings) {
    return;
  }

  const envBaseUrl = (process.env.TAZHAN_RELAY_BASE_URL ?? "").trim();
  const envEnabled = (process.env.TAZHAN_RELAY_ENABLED ?? "").trim() === "1";

  const baseUrlRaw = (envBaseUrl || settings.relay.baseUrl || "").trim();
  const enabled = envEnabled || Boolean(envBaseUrl) || Boolean(settings.relay.enabled);

  if (!enabled) {
    return;
  }
  if (!baseUrlRaw) {
    emitToRenderer({ type: "stderr", line: "[relay] enabled but baseUrl is empty (set settings.relay.baseUrl or TAZHAN_RELAY_BASE_URL)" });
    return;
  }

  const normalized = normalizeRelayBaseUrl(baseUrlRaw);
  if (!normalized.ok) {
    emitToRenderer({ type: "stderr", line: `[relay] invalid baseUrl: ${normalized.error}` });
    return;
  }
  const baseUrl = normalized.baseUrl;
  if (normalized.insecure) {
    emitToRenderer({ type: "stderr", line: "[relay] warning: using insecure http:// relay baseUrl (TLS disabled)" });
  }

  await ensureRelayE2eeDeviceKeypair();

  if (settings.relay.allowedRoots.length === 0 && settings.defaultCwd.trim()) {
    // Minimal safe default: only allow remote control inside the default workspace.
    await applySettingsPatch({ relay: { allowedRoots: [settings.defaultCwd.trim()] } as any });
  }
  if (settings.relay.allowedRoots.length === 0) {
    emitToRenderer({ type: "stderr", line: "[relay] relay.allowedRoots is empty; remote filesystem/terminal APIs will be blocked (configure Preferences -> Default Workspace or relay.allowedRoots)" });
  }

  if (!relayDevice) {
    relayDevice = new RelayDeviceClient((line) => emitToRenderer({ type: "stderr", line }));

    relayDevice.on("status", (st) => {
      emitToRenderer({ type: "stderr", line: `[relay] status=${st.status}${st.details ? ` details=${st.details}` : ""}` });
      if (st.status === "disconnected") {
        relayE2ee?.resetSession();
      }
    });

    relayDevice.on("error", (e) => {
      emitToRenderer({ type: "stderr", line: `[relay] error: ${e.message}` });
    });

    relayDevice.on("pairing", async (p) => {
      // Best-effort: persist the latest pairing code so a future UI can display it.
      try {
        await applySettingsPatch({
          relay: { lastPairingCode: p.pairingCode, lastPairingExpiresAt: p.expiresAt, lastPairingQrPayload: p.qrPayload } as any
        });
      } catch {
        // ignore
      }
      emitToRenderer({ type: "stderr", line: `[relay] pairingCode=${p.pairingCode} expiresAt=${p.expiresAt}` });
    });

    relayDevice.on("rpc", ({ rpc }) => {
      void (async () => {
        try {
          const s = settings;
          if (!s) {
            return;
          }

          let effectiveRpc: unknown = rpc;
          if (s.relay.e2ee.enabled) {
            const session = relayE2ee;
            if (session) {
              const res = session.handleIncoming(rpc);
              if (res.kind === "send") {
                relayDevice!.sendRpc(res.message as any);
                return;
              }
              if (res.kind === "error") {
                relayDevice!.sendRpc(res.error as any);
                emitToRenderer({ type: "stderr", line: `[relay][e2ee] ${res.error.code}: ${res.error.message}` });
                return;
              }
              if (res.kind === "rpc") {
                effectiveRpc = res.rpc;
              }
            } else if (s.relay.e2ee.required) {
              // Enforce required mode even if the session isn't initialized yet.
              if (isRecord(rpc) && typeof rpc.type === "string" && rpc.type.startsWith("e2ee/")) {
                // Allow handshake/error messages through.
              } else {
                relayDevice!.sendRpc({ type: "e2ee/error", v: 1, code: "e2ee_required", message: "e2ee is required" } as any);
                return;
              }
            }
          }

          if (await handleRelayTazhanRpc(relayDevice!, effectiveRpc)) {
            return;
          }
          await handleRelayRpc({
            relay: relayDevice!,
            relaySettings: s.relay,
            rpc: effectiveRpc as any,
            ensureCodexConnected: async () => {
              await ensureCodexLocalConnected();
            },
            codexCall: async (method, params) => {
              await ensureCodexLocalConnected();
              if (!codexLocal) {
                throw new Error("codex app-server is not connected");
              }
              return await codexLocal.call(method, params);
            },
            codexNotify: (method, params) => {
              void (async () => {
                await ensureCodexLocalConnected();
                codexLocal?.notify(method, params);
              })();
            },
            codexRespond: (id, result) => {
              void (async () => {
                await ensureCodexLocalConnected();
                codexLocal?.respond(id, result);
              })();
            },
            codexRespondError: (id, error) => {
              void (async () => {
                await ensureCodexLocalConnected();
                codexLocal?.respondError(id, error);
              })();
            }
          });
        } catch (err) {
          emitToRenderer({ type: "stderr", line: `[relay] rpc handler failed: ${String(err)}` });
        }
      })();
    });
  }

  // If we don't have auth yet, register once on first enable.
  relayDevice.configure(baseUrl, settings.relay.auth);
  const auth = settings.relay.auth;
  if (auth && typeof auth.expiresAt === "number") {
    const now = Math.floor(Date.now() / 1000);
    if (auth.expiresAt <= now + 120) {
      emitToRenderer({ type: "stderr", line: "[relay] refreshing device token..." });
      const refreshed = await relayDevice.refreshAuth();
      await applySettingsPatch({ relay: { auth: refreshed } as any });
      relayDevice.configure(baseUrl, refreshed);
    }
  }
  if (!settings.relay.auth) {
    emitToRenderer({ type: "stderr", line: `[relay] registering device at ${baseUrl}...` });
    const e2ee = settings.relay.e2ee;
    const registrationE2ee =
      e2ee.enabled && e2ee.deviceKeyId.trim() && e2ee.deviceEd25519PublicKey.trim()
        ? { deviceKeyId: e2ee.deviceKeyId, deviceEd25519Pub: e2ee.deviceEd25519PublicKey, required: e2ee.required }
        : null;
    const registered = await relayDevice.ensureRegistered(app.getVersion(), registrationE2ee);
    await applySettingsPatch({
      relay: {
        enabled: true,
        baseUrl,
        auth: registered.auth,
        lastPairingCode: registered.pairingCode,
        lastPairingExpiresAt: registered.pairingExpiresAt,
        lastPairingQrPayload: registered.pairingQrPayload
      } as any
    });
    relayDevice.configure(baseUrl, registered.auth);
  }

  // Persist env overrides (best-effort) so the setting survives restarts.
  if (settings.relay.baseUrl.trim() !== baseUrl || !settings.relay.enabled) {
    await applySettingsPatch({ relay: { enabled: true, baseUrl } as any });
  }

  configureRelayE2ee();
  relayDevice.start();
}

function activeCodex(): { call: (method: string, params?: unknown) => Promise<unknown>; notify: (method: string, params?: unknown) => void; respond: (id: string | number, result: unknown) => void } {
  if (codexActiveKind === "remote") {
    if (!remoteWorkspace || !remoteWorkspace.isConnected()) {
      throw new Error("remote workspace is not connected");
    }
    const rw = remoteWorkspace;
    return {
      call: (method, params) => rw.call(method, params),
      notify: (method, params) => rw.notify(method, params),
      respond: (id, result) => rw.respond(id, result)
    };
  }
  if (!codexLocal) {
    throw new Error("codex is not connected");
  }
  const c = codexLocal;
  return {
    call: (method, params) => c.call(method, params),
    notify: (method, params) => c.notify(method, params),
    respond: (id, result) => c.respond(id, result)
  };
}

async function ensureActiveCodexConnected(): Promise<void> {
  if (codexActiveKind === "remote") {
    if (!remoteWorkspace || !remoteWorkspace.isConnected()) {
      throw new Error("remote workspace is not connected");
    }
    return;
  }
  await ensureCodexLocalConnected();
}

async function createWindow(): Promise<void> {
  const icon = windowIconPath();
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: "#ffffff",
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath()
    }
  });

  await mainWindow.loadURL(rendererUrl());
  mainWindow.on("closed", () => {
    mainWindow = null;
    workspaceWatchClear();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("before-quit", () => {
  codexLocal?.disconnect();
  remoteWorkspace?.disconnect();
  relayDevice?.stop("app quitting");
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  if (process.platform === "win32") {
    // Ensure Windows toast notifications are associated with a stable AUMID.
    // When unset, `new Notification().show()` is often silently dropped.
    app.setAppUserModelId("com.tazhan.desktop");
  }

  settingsStore = new SettingsStore(app.getPath("userData"));
  settings = await settingsStore.load();

  await createWindow();

  // Best-effort: connect to the cloud relay early so a phone can control this desktop.
  void startRelayIfEnabled().catch((err) => {
    emitToRenderer({ type: "stderr", line: `[relay] failed to start: ${String(err)}` });
  });

  ipcMain.handle("settings:get", async () => settings);
  ipcMain.handle("settings:set", async (_evt, patch: Partial<AppSettings>) => {
    if (!settingsStore || !settings) {
      throw new Error("settings not loaded");
    }
    const prevRelayEnabled = Boolean(settings.relay?.enabled);
    const prevRelayBaseUrl = (settings.relay?.baseUrl ?? "").trim();
    settings = mergeSettings(settings, patch);
    await settingsStore.save(settings);

    const nextRelayEnabled = Boolean(settings.relay?.enabled);
    const nextRelayBaseUrl = (settings.relay?.baseUrl ?? "").trim();

    // Ensure E2EE keys exist before we (re)connect, and refresh transforms for in-flight relay sessions.
    try {
      await ensureRelayE2eeDeviceKeypair();
    } catch (err) {
      emitToRenderer({ type: "stderr", line: `[relay][e2ee] key ensure failed: ${String(err)}` });
    }
    configureRelayE2ee();

    if (!nextRelayEnabled) {
      relayDevice?.stop("relay disabled by settings");
    } else if (!prevRelayEnabled || prevRelayBaseUrl !== nextRelayBaseUrl) {
      relayDevice?.stop("relay settings changed");
      void startRelayIfEnabled().catch((err) => {
        emitToRenderer({ type: "stderr", line: `[relay] failed to start: ${String(err)}` });
      });
    }
    return settings;
  });

  ipcMain.handle("relay:pairingRefresh", async (_evt, args?: RelayPairingRefreshArgs): Promise<RelayPairingRefreshResult> => {
    const s = settings;
    if (!s) {
      return { ok: false, pairing: null, error: "settings not loaded" };
    }

    const requestedBaseUrl = (args?.baseUrl ?? "").trim();
    const baseUrlRaw = (requestedBaseUrl || s.relay.baseUrl || "").trim();
    const normalized = normalizeRelayBaseUrl(baseUrlRaw);
    if (!normalized.ok) {
      return { ok: false, pairing: null, error: normalized.error };
    }

    try {
      await applySettingsPatch({ relay: { enabled: true, baseUrl: normalized.baseUrl } as any });
      await startRelayIfEnabled();
      if (!relayDevice) {
        return { ok: false, pairing: null, error: "relay is not initialized" };
      }
      const pairing = await relayDevice.refreshPairingCode();
      // Best-effort persist for renderer display.
      try {
        await applySettingsPatch({
          relay: { lastPairingCode: pairing.pairingCode, lastPairingExpiresAt: pairing.expiresAt, lastPairingQrPayload: pairing.qrPayload } as any
        });
      } catch {
        // ignore
      }
      return { ok: true, pairing: { pairingCode: pairing.pairingCode, expiresAt: pairing.expiresAt, qrPayload: pairing.qrPayload }, error: null };
    } catch (err) {
      return { ok: false, pairing: null, error: String(err) };
    }
  });

  ipcMain.handle("dialog:pickWorkspace", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select a workspace folder",
      properties: ["openDirectory"]
    });
    if (result.canceled) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle("dialog:pickFile", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select a file",
      properties: ["openFile"]
    });
    if (result.canceled) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle("dialog:pickFolder", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select a folder",
      properties: ["openDirectory"]
    });
    if (result.canceled) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle("workspace:openInExplorer", async (_evt, args: { path?: unknown }) => {
    const target = typeof args?.path === "string" ? args.path : "";
    if (!target) {
      return { ok: false, error: "missing path" };
    }

    try {
      const res = await shell.openPath(target);
      return res ? { ok: false, error: res } : { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("workspace:openInTerminal", async (_evt, args: { cwd?: unknown }) => {
    const cwd = typeof args?.cwd === "string" ? args.cwd : "";
    if (!cwd) {
      return { ok: false, error: "missing cwd" };
    }

    try {
      if (process.platform === "win32") {
        spawn("cmd.exe", ["/c", "start", "\"\"", "/D", cwd, "cmd.exe"], { windowsHide: true });
        return { ok: true, error: null };
      }

      if (process.platform === "darwin") {
        spawn("open", ["-a", "Terminal", cwd], { windowsHide: true });
        return { ok: true, error: null };
      }

      spawn("x-terminal-emulator", ["--working-directory", cwd], { windowsHide: true, shell: true });
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("terminal:create", async (_evt, raw: unknown): Promise<TerminalCreateResult> => {
    const args = (raw ?? {}) as Partial<TerminalCreateArgs>;
    const scope = args.scope === "remote" ? "remote" : "local";
    const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const cols = typeof args.cols === "number" && Number.isFinite(args.cols) && args.cols > 0 ? Math.floor(args.cols) : 80;
    const rows = typeof args.rows === "number" && Number.isFinite(args.rows) && args.rows > 0 ? Math.floor(args.rows) : 24;

    if (!cwd) {
      return { ok: false, terminalId: null, error: "missing cwd" };
    }

    const id = `term_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    // Ensure uniqueness (extremely unlikely, but cheap).
    if (terminals.has(id)) {
      return { ok: false, terminalId: null, error: "terminal id collision" };
    }

    if (scope === "remote") {
      try {
        const rw = ensureRemoteWorkspaceConnected();
        const opened = await rw.terminalOpenPty({ cwd, cols, rows });
        if (!opened.ok) {
          return { ok: false, terminalId: null, error: opened.error };
        }

        const ch = opened.channel as any;
        const onData = (data: Buffer) => emitTerminalToRenderer({ type: "data", terminalId: id, data: data.toString("utf8") });
        const onClose = (code: number | null, signal?: string) =>
          emitTerminalToRenderer({ type: "exit", terminalId: id, exitCode: typeof code === "number" ? code : null, signal: signal ?? null });
        const onError = (err: unknown) => emitTerminalToRenderer({ type: "error", terminalId: id, error: String(err) });

        ch.on("data", onData);
        ch.on("close", onClose);
        ch.on("error", onError);

        const session: TerminalSession = {
          id,
          scope,
          write: (data: string) => {
            try {
              ch.write(String(data ?? ""));
            } catch {
              // Best-effort.
            }
          },
          resize: (c: number, r: number) => {
            try {
              const c2 = Number.isFinite(c) && c > 0 ? Math.floor(c) : cols;
              const r2 = Number.isFinite(r) && r > 0 ? Math.floor(r) : rows;
              ch.setWindow(r2, c2, 0, 0);
            } catch {
              // Best-effort.
            }
          },
          dispose: () => {
            try {
              ch.off("data", onData);
              ch.off("close", onClose);
              ch.off("error", onError);
            } catch {
              // Best-effort.
            }
            try {
              ch.close();
            } catch {
              // Best-effort.
            }
            try {
              ch.end();
            } catch {
              // Best-effort.
            }
          }
        };

        terminals.set(id, session);
        return { ok: true, terminalId: id, error: null };
      } catch (err) {
        return { ok: false, terminalId: null, error: String(err) };
      }
    }

    // local
    try {
      // node-pty requires a native binding; it may fail to load if build scripts were blocked.
      const ptyMod: any = await import("node-pty");
      const pty = ptyMod?.spawn ? ptyMod : ptyMod?.default;
      if (!pty?.spawn) {
        return { ok: false, terminalId: null, error: "node-pty is not available" };
      }

      const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "bash";
      const shellArgs = process.platform === "win32" ? ["-NoLogo"] : [];

      const term = pty.spawn(shell, shellArgs, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: path.resolve(cwd),
        env: { ...process.env }
      });

      const onData = (data: string) => emitTerminalToRenderer({ type: "data", terminalId: id, data });
      const onExit = (ev: any) =>
        emitTerminalToRenderer({
          type: "exit",
          terminalId: id,
          exitCode: typeof ev?.exitCode === "number" ? ev.exitCode : null,
          signal: typeof ev?.signal === "string" ? ev.signal : null
        });

      term.onData(onData);
      term.onExit(onExit);

      const session: TerminalSession = {
        id,
        scope,
        write: (data: string) => {
          try {
            term.write(String(data ?? ""));
          } catch {
            // Best-effort.
          }
        },
        resize: (c: number, r: number) => {
          try {
            const c2 = Number.isFinite(c) && c > 0 ? Math.floor(c) : cols;
            const r2 = Number.isFinite(r) && r > 0 ? Math.floor(r) : rows;
            term.resize(c2, r2);
          } catch {
            // Best-effort.
          }
        },
        dispose: () => {
          try {
            term.offData(onData);
          } catch {
            // Best-effort.
          }
          try {
            term.offExit(onExit);
          } catch {
            // Best-effort.
          }
          try {
            term.kill();
          } catch {
            // Best-effort.
          }
        }
      };

      terminals.set(id, session);
      return { ok: true, terminalId: id, error: null };
    } catch (err) {
      return {
        ok: false,
        terminalId: null,
        error: `failed to start local terminal: ${String(err)} (node-pty may require allowing build scripts: pnpm approve-builds)`
      };
    }
  });

  ipcMain.handle("terminal:write", async (_evt, raw: unknown): Promise<{ ok: boolean; error: string | null }> => {
    const args = (raw ?? {}) as Partial<TerminalWriteArgs>;
    const terminalId = typeof args.terminalId === "string" ? args.terminalId : "";
    const data = typeof args.data === "string" ? args.data : "";
    const sess = terminalId ? terminals.get(terminalId) ?? null : null;
    if (!sess) {
      return { ok: false, error: "terminal not found" };
    }
    try {
      sess.write(data);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("terminal:resize", async (_evt, raw: unknown): Promise<{ ok: boolean; error: string | null }> => {
    const args = (raw ?? {}) as Partial<TerminalResizeArgs>;
    const terminalId = typeof args.terminalId === "string" ? args.terminalId : "";
    const cols = typeof args.cols === "number" && Number.isFinite(args.cols) ? Math.floor(args.cols) : 0;
    const rows = typeof args.rows === "number" && Number.isFinite(args.rows) ? Math.floor(args.rows) : 0;
    const sess = terminalId ? terminals.get(terminalId) ?? null : null;
    if (!sess) {
      return { ok: false, error: "terminal not found" };
    }
    try {
      sess.resize(cols, rows);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("terminal:dispose", async (_evt, raw: unknown): Promise<{ ok: boolean; error: string | null }> => {
    const args = (raw ?? {}) as Partial<TerminalDisposeArgs>;
    const terminalId = typeof args.terminalId === "string" ? args.terminalId : "";
    const sess = terminalId ? terminals.get(terminalId) ?? null : null;
    if (!sess) {
      return { ok: true, error: null };
    }
    try {
      sess.dispose();
      terminals.delete(terminalId);
      return { ok: true, error: null };
    } catch (err) {
      terminals.delete(terminalId);
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("terminal:run", async (_evt, raw: unknown): Promise<TerminalRunResult> => {
    const args = (raw ?? {}) as Partial<TerminalRunArgs>;
    const scope = args.scope === "remote" ? "remote" : "local";
    const cwd = typeof args.cwd === "string" ? args.cwd : "";
    const command = typeof args.command === "string" ? args.command : "";
    const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) ? Math.floor(args.timeoutMs) : 60_000;

    if (!cwd.trim()) {
      return { ok: false, stdout: "", stderr: "", exitCode: null, error: "missing cwd" };
    }
    if (!command.trim()) {
      return { ok: false, stdout: "", stderr: "", exitCode: null, error: "missing command" };
    }

    if (scope === "remote") {
      try {
        const rw = ensureRemoteWorkspaceConnected();
        return await rw.terminalRun(cwd, command, timeoutMs);
      } catch (err) {
        return { ok: false, stdout: "", stderr: "", exitCode: null, error: String(err) };
      }
    }

    try {
      const cwdAbs = path.resolve(cwd);
      return await new Promise<TerminalRunResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let done = false;

        const child = spawn(command, { cwd: cwdAbs, shell: true, windowsHide: true });
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        const timer = setTimeout(() => {
          if (done) {
            return;
          }
          done = true;
          try {
            child.kill();
          } catch {
            // Best-effort.
          }
          resolve({ ok: false, stdout, stderr, exitCode: null, error: "timeout" });
        }, timeoutMs);

        child.on("error", (err) => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, stdout, stderr: `${stderr}\n${String(err)}`.trim(), exitCode: null, error: String(err) });
        });
        child.on("close", (code) => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          resolve({ ok: true, stdout, stderr, exitCode: typeof code === "number" ? code : null, error: null });
        });
      });
    } catch (err) {
      return { ok: false, stdout: "", stderr: "", exitCode: null, error: String(err) };
    }
  });

  ipcMain.handle(
    "workspace:watchSet",
    async (_evt, args: { root?: unknown; dirs?: unknown[] }): Promise<{ ok: boolean; error: string | null }> => {
      const root = typeof args?.root === "string" ? args.root : "";
      const dirsRaw = Array.isArray(args?.dirs) ? (args.dirs as unknown[]) : [];
      const dirs = dirsRaw
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim())
        .filter(Boolean);

      if (!root) {
        workspaceWatchClear();
        return { ok: true, error: null };
      }

      const rootAbs = path.resolve(root);
      if (dirs.length === 0) {
        workspaceWatchClear();
        return { ok: true, error: null };
      }

      if (!workspaceWatchState || workspaceWatchState.rootAbs !== rootAbs) {
        workspaceWatchClear();
        workspaceWatchState = { rootAbs, watchersByDir: new Map(), debounceByDir: new Map() };
      }

      const next = new Set<string>();
      for (const dir of dirs) {
        const dirAbs = path.resolve(dir);
        if (!isWithinRoot(rootAbs, dirAbs)) {
          return { ok: false, error: "path is outside the workspace root" };
        }
        next.add(dirAbs);
      }

      const state = workspaceWatchState!;
      for (const [dirAbs, w] of state.watchersByDir.entries()) {
        if (next.has(dirAbs)) {
          continue;
        }
        try {
          w.close();
        } catch {
          // Best-effort.
        }
        state.watchersByDir.delete(dirAbs);
      }

      for (const dirAbs of next) {
        if (state.watchersByDir.has(dirAbs)) {
          continue;
        }
        try {
          const w = watch(dirAbs, { persistent: true, recursive: false }, () => emitWorkspaceDirChanged(rootAbs, dirAbs));
          w.on("error", () => emitWorkspaceDirChanged(rootAbs, dirAbs));
          state.watchersByDir.set(dirAbs, w);
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }

      emitWorkspaceDirChanged(rootAbs, rootAbs);
      return { ok: true, error: null };
    }
  );

  ipcMain.handle(
    "workspace:listDir",
    async (_evt, args: { scope?: unknown; root?: unknown; dir?: unknown }): Promise<WorkspaceListDirResult> => {
      const scope = args?.scope === "remote" ? "remote" : "local";
      const root = typeof args?.root === "string" ? args.root : "";
      const dir = typeof args?.dir === "string" ? args.dir : "";
      if (!root || !dir) {
        return { ok: false, entries: [], error: "missing root or dir" };
      }

      if (scope === "remote") {
        if (!remoteWorkspace?.isConnected()) {
          return { ok: false, entries: [], error: "remote workspace is not connected" };
        }
        return await remoteWorkspace.listDir(root, dir);
      }

      const rootAbs = path.resolve(root);
      const dirAbs = path.resolve(dir);
      if (!isWithinRoot(rootAbs, dirAbs)) {
        return { ok: false, entries: [], error: "path is outside the workspace root" };
      }

      try {
        const items = await fs.readdir(dirAbs, { withFileTypes: true });
        const entries: WorkspaceDirEntry[] = items.map((it) => ({
          name: it.name,
          path: path.join(dirAbs, it.name),
          kind: it.isDirectory() ? "dir" : "file"
        }));

        entries.sort((a, b) => {
          if (a.kind !== b.kind) {
            return a.kind === "dir" ? -1 : 1;
          }
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });

        return { ok: true, entries, error: null };
      } catch (err) {
        return { ok: false, entries: [], error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "workspace:readFile",
    async (_evt, args: { scope?: unknown; root?: unknown; path?: unknown }): Promise<WorkspaceReadFileResult> => {
      const scope = args?.scope === "remote" ? "remote" : "local";
      const root = typeof args?.root === "string" ? args.root : "";
      const filePath = typeof args?.path === "string" ? args.path : "";
      if (!root || !filePath) {
        return { ok: false, content: "", truncated: false, error: "missing root or path" };
      }

      if (scope === "remote") {
        if (!remoteWorkspace?.isConnected()) {
          return { ok: false, content: "", truncated: false, error: "remote workspace is not connected" };
        }
        return await remoteWorkspace.readFile(root, filePath);
      }

      const rootAbs = path.resolve(root);
      const fileAbs = path.resolve(filePath);
      if (!isWithinRoot(rootAbs, fileAbs)) {
        return { ok: false, content: "", truncated: false, error: "path is outside the workspace root" };
      }

      const maxBytes = 400_000;
      try {
        const stat = await fs.stat(fileAbs);
        if (stat.isDirectory()) {
          return { ok: false, content: "", truncated: false, error: "path is a directory" };
        }

        const toRead = Math.min(stat.size, maxBytes);
        const fh = await fs.open(fileAbs, "r");
        try {
          const buf = Buffer.alloc(toRead);
          await fh.read(buf, 0, toRead, 0);
          const content = buf.toString("utf8");
          const truncated = stat.size > maxBytes;
          return { ok: true, content, truncated, error: null };
        } finally {
          await fh.close();
        }
      } catch (err) {
        return { ok: false, content: "", truncated: false, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "workspace:mkdir",
    async (_evt, args: { scope?: unknown; root?: unknown; parentDir?: unknown; name?: unknown }): Promise<WorkspacePathResult> => {
      const scope = args?.scope === "remote" ? "remote" : "local";
      const root = typeof args?.root === "string" ? args.root : "";
      const parentDir = typeof args?.parentDir === "string" ? args.parentDir : "";
      const name = typeof args?.name === "string" ? args.name : "";
      if (!root || !parentDir) {
        return { ok: false, path: null, error: "missing root or parentDir" };
      }
      if (!isSafeName(name)) {
        return { ok: false, path: null, error: "invalid name" };
      }

      if (scope === "remote") {
        if (!remoteWorkspace?.isConnected()) {
          return { ok: false, path: null, error: "remote workspace is not connected" };
        }
        return await remoteWorkspace.mkdir(root, parentDir, name);
      }

      const rootAbs = path.resolve(root);
      const parentAbs = path.resolve(parentDir);
      const targetAbs = path.join(parentAbs, name.trim());
      if (!isWithinRoot(rootAbs, parentAbs) || !isWithinRoot(rootAbs, targetAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" };
      }

      try {
        await fs.mkdir(targetAbs, { recursive: false });
        return { ok: true, path: targetAbs, error: null };
      } catch (err) {
        return { ok: false, path: null, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "workspace:createFile",
    async (_evt, args: { scope?: unknown; root?: unknown; parentDir?: unknown; name?: unknown }): Promise<WorkspacePathResult> => {
      const scope = args?.scope === "remote" ? "remote" : "local";
      const root = typeof args?.root === "string" ? args.root : "";
      const parentDir = typeof args?.parentDir === "string" ? args.parentDir : "";
      const name = typeof args?.name === "string" ? args.name : "";
      if (!root || !parentDir) {
        return { ok: false, path: null, error: "missing root or parentDir" };
      }
      if (!isSafeName(name)) {
        return { ok: false, path: null, error: "invalid name" };
      }

      if (scope === "remote") {
        if (!remoteWorkspace?.isConnected()) {
          return { ok: false, path: null, error: "remote workspace is not connected" };
        }
        return await remoteWorkspace.createFile(root, parentDir, name);
      }

      const rootAbs = path.resolve(root);
      const parentAbs = path.resolve(parentDir);
      const targetAbs = path.join(parentAbs, name.trim());
      if (!isWithinRoot(rootAbs, parentAbs) || !isWithinRoot(rootAbs, targetAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" };
      }

      try {
        await fs.writeFile(targetAbs, "", { encoding: "utf8", flag: "wx" });
        return { ok: true, path: targetAbs, error: null };
      } catch (err) {
        return { ok: false, path: null, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "workspace:rename",
    async (_evt, args: { scope?: unknown; root?: unknown; path?: unknown; newName?: unknown }): Promise<WorkspacePathResult> => {
      const scope = args?.scope === "remote" ? "remote" : "local";
      const root = typeof args?.root === "string" ? args.root : "";
      const fromPath = typeof args?.path === "string" ? args.path : "";
      const newName = typeof args?.newName === "string" ? args.newName : "";
      if (!root || !fromPath) {
        return { ok: false, path: null, error: "missing root or path" };
      }
      if (!isSafeName(newName)) {
        return { ok: false, path: null, error: "invalid newName" };
      }

      if (scope === "remote") {
        if (!remoteWorkspace?.isConnected()) {
          return { ok: false, path: null, error: "remote workspace is not connected" };
        }
        return await remoteWorkspace.rename(root, fromPath, newName);
      }

      const rootAbs = path.resolve(root);
      const fromAbs = path.resolve(fromPath);
      if (!isWithinRoot(rootAbs, fromAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" };
      }
      if (fromAbs === rootAbs) {
        return { ok: false, path: null, error: "cannot rename the workspace root" };
      }

      const toAbs = path.join(path.dirname(fromAbs), newName.trim());
      if (!isWithinRoot(rootAbs, toAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" };
      }

      try {
        await fs.rename(fromAbs, toAbs);
        return { ok: true, path: toAbs, error: null };
      } catch (err) {
        return { ok: false, path: null, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "workspace:delete",
    async (_evt, args: { scope?: unknown; root?: unknown; path?: unknown }): Promise<WorkspaceOpResult> => {
      const scope = args?.scope === "remote" ? "remote" : "local";
      const root = typeof args?.root === "string" ? args.root : "";
      const targetPath = typeof args?.path === "string" ? args.path : "";
      if (!root || !targetPath) {
        return { ok: false, error: "missing root or path" };
      }

      if (scope === "remote") {
        if (!remoteWorkspace?.isConnected()) {
          return { ok: false, error: "remote workspace is not connected" };
        }
        return await remoteWorkspace.delete(root, targetPath);
      }

      const rootAbs = path.resolve(root);
      const targetAbs = path.resolve(targetPath);
      if (!isWithinRoot(rootAbs, targetAbs)) {
        return { ok: false, error: "path is outside the workspace root" };
      }
      if (targetAbs === rootAbs) {
        return { ok: false, error: "cannot delete the workspace root" };
      }

      try {
        await fs.rm(targetAbs, { recursive: true, force: true });
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "workspace:writeFile",
    async (_evt, args: { scope?: unknown; root?: unknown; path?: unknown; content?: unknown }): Promise<WorkspaceOpResult> => {
      const scope = args?.scope === "remote" ? "remote" : "local";
      const root = typeof args?.root === "string" ? args.root : "";
      const filePath = typeof args?.path === "string" ? args.path : "";
      const content = typeof args?.content === "string" ? args.content : "";
      if (!root || !filePath) {
        return { ok: false, error: "missing root or path" };
      }

      if (scope === "remote") {
        if (!remoteWorkspace?.isConnected()) {
          return { ok: false, error: "remote workspace is not connected" };
        }
        return await remoteWorkspace.writeFile(root, filePath, content);
      }

      const rootAbs = path.resolve(root);
      const fileAbs = path.resolve(filePath);
      if (!isWithinRoot(rootAbs, fileAbs)) {
        return { ok: false, error: "path is outside the workspace root" };
      }

      try {
        await fs.mkdir(path.dirname(fileAbs), { recursive: true });
      } catch (err) {
        return { ok: false, error: `failed to create parent directories: ${String(err)}` };
      }

      try {
        const stat = await fs.stat(fileAbs);
        if (stat.isDirectory()) {
          return { ok: false, error: "path is a directory" };
        }
      } catch {
        // If stat fails, we still attempt to write (creating a new file is ok).
      }

      try {
        await fs.writeFile(fileAbs, content, { encoding: "utf8" });
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  ipcMain.handle("codex:connect", async () => {
    await ensureCodexLocalConnected();
    return {};
  });

  ipcMain.handle("codex:disconnect", async () => {
    codexLocal?.disconnect();
    codexLocal = null;
    return {};
  });

  ipcMain.handle("remote:connect", async (_evt, args: RemoteWorkspaceConnectArgs): Promise<RemoteWorkspaceConnectResult> => {
    remoteWorkspace?.disconnect();
    remoteWorkspace = null;

    const rw = new RemoteWorkspace(emitRemoteToRenderer);
    try {
      await rw.connect(args, { name: "tazhan_desktop", title: "TAZHAN Desktop", version: app.getVersion() });
      remoteWorkspace = rw;
      return { ok: true, error: null };
    } catch (err) {
      rw.disconnect();
      remoteWorkspace = null;
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("remote:disconnect", async (): Promise<{ ok: boolean; error: string | null }> => {
    try {
      remoteWorkspace?.disconnect();
      remoteWorkspace = null;
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("remote:status", async (): Promise<RemoteWorkspaceStatus> => {
    return remoteWorkspace?.getStatus() ?? { connected: false, host: "", port: 22, username: "", workspaceRoot: "" };
  });

  ipcMain.handle("remote:scanWorkspaces", async (_evt, args: SshProbeArgs): Promise<RemoteWorkspaceScanResult> => {
    return await scanRemoteWorkspaces(args);
  });

  ipcMain.handle("remote:mkdirAbs", async (_evt, args: RemoteWorkspaceMkdirAbsArgs): Promise<RemoteWorkspaceMkdirAbsResult> => {
    return await mkdirRemoteAbs(args);
  });

  function ensureRemoteWorkspaceConnected(): RemoteWorkspace {
    if (!remoteWorkspace || !remoteWorkspace.isConnected()) {
      throw new Error("remote workspace is not connected");
    }
    return remoteWorkspace;
  }

  ipcMain.handle("remote:uploadFile", async (_evt, raw: unknown): Promise<WorkspaceOpResult> => {
    const rw = ensureRemoteWorkspaceConnected();
    const args = (raw ?? {}) as { destDir?: unknown; localPath?: unknown };
    const destDir = typeof args.destDir === "string" ? args.destDir : "";
    const localPath = typeof args.localPath === "string" ? args.localPath : "";
    if (!destDir || !localPath) {
      return { ok: false, error: "missing destDir or localPath" };
    }
    const root = rw.getStatus().workspaceRoot;
    return await rw.uploadFile(root, destDir, localPath);
  });

  ipcMain.handle("remote:uploadFolder", async (_evt, raw: unknown): Promise<WorkspaceOpResult> => {
    const rw = ensureRemoteWorkspaceConnected();
    const args = (raw ?? {}) as { destDir?: unknown; localPath?: unknown };
    const destDir = typeof args.destDir === "string" ? args.destDir : "";
    const localPath = typeof args.localPath === "string" ? args.localPath : "";
    if (!destDir || !localPath) {
      return { ok: false, error: "missing destDir or localPath" };
    }
    const root = rw.getStatus().workspaceRoot;
    return await rw.uploadFolder(root, destDir, localPath);
  });

  ipcMain.handle("remote:openInTerminal", async (_evt, raw: unknown): Promise<{ ok: boolean; error: string | null }> => {
    try {
      const rw = ensureRemoteWorkspaceConnected();
      const status = rw.getStatus();

      const args = (raw ?? {}) as Partial<RemoteOpenInTerminalArgs>;
      const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
      const host = status.host.trim();
      const port = Number.isFinite(status.port) && status.port > 0 ? Math.floor(status.port) : 22;
      const username = status.username.trim();
      const targetCwd = cwd || status.workspaceRoot;

      if (!host || !username || !targetCwd) {
        return { ok: false, error: "missing host/username/cwd" };
      }

      const sshTarget = `${username}@${host}`;
      const cwdQuoted = `'${targetCwd.replaceAll("'", `'\"'\"'`)}'`;
      const sshLine = `ssh -p ${port} ${sshTarget} -t "cd ${cwdQuoted} && bash -l"`;

      if (process.platform === "win32") {
        // Open a real console window that stays open (/k). User can type password if needed.
        spawn("cmd.exe", ["/c", "start", "\"\"", "cmd.exe", "/k", sshLine], { windowsHide: true });
        return { ok: true, error: null };
      }

      if (process.platform === "darwin") {
        // Best-effort: open Terminal and run ssh via AppleScript.
        const osa = `tell application "Terminal"\nactivate\ndo script "${sshLine.replaceAll("\\\\", "\\\\\\\\").replaceAll("\"", "\\\\\"")}"\nend tell`;
        spawn("osascript", ["-e", osa], { windowsHide: true });
        return { ok: true, error: null };
      }

      // Linux: best-effort open a terminal emulator.
      spawn("x-terminal-emulator", ["-e", sshLine], { windowsHide: true, shell: true });
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("remoteCodex:modelList", async () => {
    const rw = ensureRemoteWorkspaceConnected();
    const out: any[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = (await rw.call("model/list", { cursor, limit: 200 })) as any;
      const data = (page?.data ?? []) as any[];
      out.push(...data);
      const nextCursor = (page?.nextCursor ?? null) as string | null;
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    return out;
  });

  ipcMain.handle("remoteCodex:threadStart", async (_evt, params: unknown) => {
    const rw = ensureRemoteWorkspaceConnected();
    return await rw.call("thread/start", params);
  });

  ipcMain.handle("remoteCodex:threadList", async (_evt, params: unknown) => {
    const rw = ensureRemoteWorkspaceConnected();
    return await rw.call("thread/list", params);
  });

  ipcMain.handle("remoteCodex:threadRead", async (_evt, params: unknown) => {
    const rw = ensureRemoteWorkspaceConnected();
    return await rw.call("thread/read", params);
  });

  ipcMain.handle("remoteCodex:threadResume", async (_evt, params: unknown) => {
    const rw = ensureRemoteWorkspaceConnected();
    return await rw.call("thread/resume", params);
  });

  ipcMain.handle("remoteCodex:threadNameSet", async (_evt, params: unknown) => {
    const rw = ensureRemoteWorkspaceConnected();
    return await rw.call("thread/name/set", params);
  });

  ipcMain.handle("remoteCodex:turnStart", async (_evt, params: unknown) => {
    const rw = ensureRemoteWorkspaceConnected();
    return await rw.call("turn/start", params);
  });

  ipcMain.handle("remoteCodex:turnSteer", async (_evt, params: unknown) => {
    const rw = ensureRemoteWorkspaceConnected();
    return await rw.call("turn/steer", params);
  });

  ipcMain.handle("remoteCodex:turnInterrupt", async (_evt, params: unknown) => {
    const rw = ensureRemoteWorkspaceConnected();
    return await rw.call("turn/interrupt", params);
  });

  ipcMain.handle("remoteCodex:respond", async (_evt, args: { id: RpcId; result: unknown }) => {
    const rw = ensureRemoteWorkspaceConnected();
    rw.respond(args.id, args.result);
    return {};
  });

  ipcMain.handle("codex:cliInfo", async () => readCodexCliInfo());

  ipcMain.handle("codex:cliInstall", async () => installCodexCli());

  ipcMain.handle("codex:runtimeInstall", async (_evt, target: CodexRuntimeInstallTarget): Promise<CodexRuntimeInstallResult> => {
    return installRuntime(target);
  });

  ipcMain.handle("codex:userConfigRead", async (): Promise<CodexUserConfigReadResult> => readCodexUserConfig());

  ipcMain.handle("codex:userConfigWrite", async (_evt, raw: unknown): Promise<CodexUserConfigWriteResult> => {
    const args = (raw ?? {}) as Partial<CodexUserConfigWriteArgs>;
    return writeCodexUserConfig({
      model: typeof args.model === "string" ? args.model : null,
      modelProvider: typeof args.modelProvider === "string" ? args.modelProvider : null,
      baseUrl: typeof args.baseUrl === "string" ? args.baseUrl : "",
      apiKey: typeof args.apiKey === "string" ? args.apiKey : null,
      clearApiKey: Boolean(args.clearApiKey)
    });
  });

  ipcMain.handle("codex:providerTest", async (_evt, raw: unknown): Promise<CodexProviderTestResult> => {
    const args = (raw ?? {}) as { baseUrl?: unknown; apiKey?: unknown };
    const baseUrl = typeof args.baseUrl === "string" ? args.baseUrl : "";
    const apiKey = typeof args.apiKey === "string" ? args.apiKey : "";
    return testProvider(baseUrl, apiKey);
  });

  ipcMain.handle("llm:chatComplete", async (_evt, raw: unknown): Promise<LlmChatCompleteResult> => {
    const args = (raw ?? {}) as Partial<LlmChatCompleteArgs>;
    return llmChatComplete({
      messages: Array.isArray(args.messages) ? (args.messages as any) : [],
      model: typeof args.model === "string" ? args.model : undefined,
      temperature: typeof args.temperature === "number" ? args.temperature : undefined,
      maxOutputTokens: typeof args.maxOutputTokens === "number" ? args.maxOutputTokens : undefined
    });
  });

  ipcMain.handle("codex:modelList", async () => {
    await ensureActiveCodexConnected();
    const c = activeCodex();
    const out: any[] = [];
    let cursor: string | null = null;
    // Cursor pagination: keep fetching until the server says there are no more pages.
    for (;;) {
      const page = (await c.call("model/list", { cursor, limit: 200 })) as any;
      const data = (page?.data ?? []) as any[];
      out.push(...data);
      const nextCursor = (page?.nextCursor ?? null) as string | null;
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    return out;
  });

  ipcMain.handle("codex:threadStart", async (_evt, params: unknown) => {
    await ensureActiveCodexConnected();
    const result = await activeCodex().call("thread/start", params);
    return result;
  });

  ipcMain.handle("codex:threadList", async (_evt, params: unknown) => {
    await ensureActiveCodexConnected();
    const result = await activeCodex().call("thread/list", params);
    return result;
  });

  ipcMain.handle("codex:threadRead", async (_evt, params: unknown) => {
    await ensureActiveCodexConnected();
    const result = await activeCodex().call("thread/read", params);
    return result;
  });

  ipcMain.handle("codex:threadResume", async (_evt, params: unknown) => {
    await ensureActiveCodexConnected();
    const result = await activeCodex().call("thread/resume", params);
    return result;
  });

  ipcMain.handle("codex:threadNameSet", async (_evt, params: unknown) => {
    await ensureActiveCodexConnected();
    const result = await activeCodex().call("thread/name/set", params);
    return result;
  });

  ipcMain.handle("codex:turnStart", async (_evt, params: unknown) => {
    await ensureActiveCodexConnected();
    const result = await activeCodex().call("turn/start", params);
    return result;
  });

  ipcMain.handle("codex:turnSteer", async (_evt, params: unknown) => {
    await ensureActiveCodexConnected();
    const result = await activeCodex().call("turn/steer", params);
    return result;
  });

  ipcMain.handle("codex:turnInterrupt", async (_evt, params: unknown) => {
    await ensureActiveCodexConnected();
    const result = await activeCodex().call("turn/interrupt", params);
    return result;
  });

  ipcMain.handle("codex:respond", async (_evt, args: { id: string | number; result: unknown }) => {
    await ensureActiveCodexConnected();
    activeCodex().respond(args.id, args.result);
    return {};
  });

  ipcMain.handle("ssh:probe", async (_evt, args: SshProbeArgs) => {
    const result: SshProbeResult = await sshProbe(args);
    return result;
  });

  emitToRenderer({ type: "status", status: "disconnected" });
});
