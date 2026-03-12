import { contextBridge, ipcRenderer } from "electron";

import type {
  AppSettings,
  CodexCliInfo,
  CodexRuntimeInstallResult,
  CodexRuntimeInstallTarget,
  CodexEvent,
  CodexModel,
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
  RelayPairingRefreshArgs,
  RelayPairingRefreshResult,
  RemoteWorkspaceScanResult,
  RemoteWorkspaceStatus,
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
  WorkspaceListDirResult,
  WorkspaceOpResult,
  WorkspacePathResult,
  WorkspaceReadFileResult,
  WorkspaceWatchEvent,
  WorkspaceWatchSetArgs,
  WorkspaceWatchSetResult
} from "../shared/types";

export type TazhanApi = {
  getSettings: () => Promise<AppSettings>;
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  pickWorkspace: () => Promise<string | null>;
  pickFile: () => Promise<string | null>;
  pickFolder: () => Promise<string | null>;
  openInExplorer: (path: string) => Promise<{ ok: boolean; error: string | null }>;
  openInTerminal: (cwd: string) => Promise<{ ok: boolean; error: string | null }>;
  workspaceListDir: (args: { scope?: "local" | "remote"; root: string; dir: string }) => Promise<WorkspaceListDirResult>;
  workspaceReadFile: (args: { scope?: "local" | "remote"; root: string; path: string }) => Promise<WorkspaceReadFileResult>;
  workspaceMkdir: (args: { scope?: "local" | "remote"; root: string; parentDir: string; name: string }) => Promise<WorkspacePathResult>;
  workspaceCreateFile: (args: { scope?: "local" | "remote"; root: string; parentDir: string; name: string }) => Promise<WorkspacePathResult>;
  workspaceRename: (args: { scope?: "local" | "remote"; root: string; path: string; newName: string }) => Promise<WorkspacePathResult>;
  workspaceDelete: (args: { scope?: "local" | "remote"; root: string; path: string }) => Promise<WorkspaceOpResult>;
  workspaceWriteFile: (args: { scope?: "local" | "remote"; root: string; path: string; content: string }) => Promise<WorkspaceOpResult>;
  workspaceWatchSet: (args: WorkspaceWatchSetArgs) => Promise<WorkspaceWatchSetResult>;
  codexConnect: () => Promise<void>;
  codexDisconnect: () => Promise<void>;
  codexCliInfo: () => Promise<CodexCliInfo>;
  codexCliInstall: () => Promise<{ ok: boolean; error: string | null }>;
  codexRuntimeInstall: (target: CodexRuntimeInstallTarget) => Promise<CodexRuntimeInstallResult>;
  codexUserConfigRead: () => Promise<CodexUserConfigReadResult>;
  codexUserConfigWrite: (args: CodexUserConfigWriteArgs) => Promise<CodexUserConfigWriteResult>;
  codexProviderTest: (args: { baseUrl: string; apiKey: string }) => Promise<CodexProviderTestResult>;
  llmChatComplete: (args: LlmChatCompleteArgs) => Promise<LlmChatCompleteResult>;
  sshProbe: (args: SshProbeArgs) => Promise<SshProbeResult>;
  remoteWorkspaceConnect: (args: RemoteWorkspaceConnectArgs) => Promise<RemoteWorkspaceConnectResult>;
  remoteWorkspaceDisconnect: () => Promise<{ ok: boolean; error: string | null }>;
  remoteWorkspaceStatus: () => Promise<RemoteWorkspaceStatus>;
  remoteScanWorkspaces: (args: SshProbeArgs) => Promise<RemoteWorkspaceScanResult>;
  remoteMkdirAbs: (args: RemoteWorkspaceMkdirAbsArgs) => Promise<RemoteWorkspaceMkdirAbsResult>;
  remoteUploadFile: (args: { destDir: string; localPath: string }) => Promise<WorkspaceOpResult>;
  remoteUploadFolder: (args: { destDir: string; localPath: string }) => Promise<WorkspaceOpResult>;
  remoteOpenInTerminal: (args: RemoteOpenInTerminalArgs) => Promise<{ ok: boolean; error: string | null }>;
  terminalRun: (args: TerminalRunArgs) => Promise<TerminalRunResult>;
  terminalCreate: (args: TerminalCreateArgs) => Promise<TerminalCreateResult>;
  terminalWrite: (args: TerminalWriteArgs) => Promise<{ ok: boolean; error: string | null }>;
  terminalResize: (args: TerminalResizeArgs) => Promise<{ ok: boolean; error: string | null }>;
  terminalDispose: (args: TerminalDisposeArgs) => Promise<{ ok: boolean; error: string | null }>;
  relayPairingRefresh: (args?: RelayPairingRefreshArgs) => Promise<RelayPairingRefreshResult>;
  modelList: () => Promise<CodexModel[]>;
  remoteModelList: () => Promise<CodexModel[]>;
  threadStart: (params: unknown) => Promise<unknown>;
  threadList: (params: unknown) => Promise<unknown>;
  threadRead: (params: unknown) => Promise<unknown>;
  threadResume: (params: unknown) => Promise<unknown>;
  threadNameSet: (params: unknown) => Promise<unknown>;
  turnStart: (params: unknown) => Promise<unknown>;
  turnSteer: (params: unknown) => Promise<unknown>;
  turnInterrupt: (params: unknown) => Promise<unknown>;
  respond: (id: RpcId, result: unknown) => Promise<void>;
  remoteThreadStart: (params: unknown) => Promise<unknown>;
  remoteThreadList: (params: unknown) => Promise<unknown>;
  remoteThreadRead: (params: unknown) => Promise<unknown>;
  remoteThreadResume: (params: unknown) => Promise<unknown>;
  remoteThreadNameSet: (params: unknown) => Promise<unknown>;
  remoteTurnStart: (params: unknown) => Promise<unknown>;
  remoteTurnSteer: (params: unknown) => Promise<unknown>;
  remoteTurnInterrupt: (params: unknown) => Promise<unknown>;
  remoteRespond: (id: RpcId, result: unknown) => Promise<void>;
  onCodexEvent: (listener: (ev: CodexEvent) => void) => () => void;
  onRemoteEvent: (listener: (ev: CodexEvent) => void) => () => void;
  onWorkspaceEvent: (listener: (ev: WorkspaceWatchEvent) => void) => () => void;
  onTerminalEvent: (listener: (ev: TerminalEvent) => void) => () => void;
};

const api: TazhanApi = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  pickWorkspace: () => ipcRenderer.invoke("dialog:pickWorkspace"),
  pickFile: () => ipcRenderer.invoke("dialog:pickFile"),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  openInExplorer: (path) => ipcRenderer.invoke("workspace:openInExplorer", { path }),
  openInTerminal: (cwd) => ipcRenderer.invoke("workspace:openInTerminal", { cwd }),
  workspaceListDir: (args) => ipcRenderer.invoke("workspace:listDir", args),
  workspaceReadFile: (args) => ipcRenderer.invoke("workspace:readFile", args),
  workspaceMkdir: (args) => ipcRenderer.invoke("workspace:mkdir", args),
  workspaceCreateFile: (args) => ipcRenderer.invoke("workspace:createFile", args),
  workspaceRename: (args) => ipcRenderer.invoke("workspace:rename", args),
  workspaceDelete: (args) => ipcRenderer.invoke("workspace:delete", args),
  workspaceWriteFile: (args) => ipcRenderer.invoke("workspace:writeFile", args),
  workspaceWatchSet: (args) => ipcRenderer.invoke("workspace:watchSet", args),
  codexConnect: async () => {
    await ipcRenderer.invoke("codex:connect");
  },
  codexDisconnect: async () => {
    await ipcRenderer.invoke("codex:disconnect");
  },
  codexCliInfo: async () => ipcRenderer.invoke("codex:cliInfo"),
  codexCliInstall: async () => ipcRenderer.invoke("codex:cliInstall"),
  codexRuntimeInstall: async (target) => ipcRenderer.invoke("codex:runtimeInstall", target),
  codexUserConfigRead: async () => ipcRenderer.invoke("codex:userConfigRead"),
  codexUserConfigWrite: async (args) => ipcRenderer.invoke("codex:userConfigWrite", args),
  codexProviderTest: async (args) => ipcRenderer.invoke("codex:providerTest", args),
  llmChatComplete: async (args) => ipcRenderer.invoke("llm:chatComplete", args),
  sshProbe: async (args) => ipcRenderer.invoke("ssh:probe", args),
  remoteWorkspaceConnect: async (args) => ipcRenderer.invoke("remote:connect", args),
  remoteWorkspaceDisconnect: async () => ipcRenderer.invoke("remote:disconnect"),
  remoteWorkspaceStatus: async () => ipcRenderer.invoke("remote:status"),
  remoteScanWorkspaces: async (args) => ipcRenderer.invoke("remote:scanWorkspaces", args),
  remoteMkdirAbs: async (args) => ipcRenderer.invoke("remote:mkdirAbs", args),
  remoteUploadFile: async (args) => ipcRenderer.invoke("remote:uploadFile", args),
  remoteUploadFolder: async (args) => ipcRenderer.invoke("remote:uploadFolder", args),
  remoteOpenInTerminal: async (args) => ipcRenderer.invoke("remote:openInTerminal", args),
  terminalRun: async (args) => ipcRenderer.invoke("terminal:run", args),
  terminalCreate: async (args) => ipcRenderer.invoke("terminal:create", args),
  terminalWrite: async (args) => ipcRenderer.invoke("terminal:write", args),
  terminalResize: async (args) => ipcRenderer.invoke("terminal:resize", args),
  terminalDispose: async (args) => ipcRenderer.invoke("terminal:dispose", args),
  relayPairingRefresh: async (args) => ipcRenderer.invoke("relay:pairingRefresh", args),
  modelList: async () => ipcRenderer.invoke("codex:modelList"),
  remoteModelList: async () => ipcRenderer.invoke("remoteCodex:modelList"),
  threadStart: (params) => ipcRenderer.invoke("codex:threadStart", params),
  threadList: (params) => ipcRenderer.invoke("codex:threadList", params),
  threadRead: (params) => ipcRenderer.invoke("codex:threadRead", params),
  threadResume: (params) => ipcRenderer.invoke("codex:threadResume", params),
  threadNameSet: (params) => ipcRenderer.invoke("codex:threadNameSet", params),
  turnStart: (params) => ipcRenderer.invoke("codex:turnStart", params),
  turnSteer: (params) => ipcRenderer.invoke("codex:turnSteer", params),
  turnInterrupt: (params) => ipcRenderer.invoke("codex:turnInterrupt", params),
  respond: async (id, result) => {
    await ipcRenderer.invoke("codex:respond", { id, result });
  },
  remoteThreadStart: (params) => ipcRenderer.invoke("remoteCodex:threadStart", params),
  remoteThreadList: (params) => ipcRenderer.invoke("remoteCodex:threadList", params),
  remoteThreadRead: (params) => ipcRenderer.invoke("remoteCodex:threadRead", params),
  remoteThreadResume: (params) => ipcRenderer.invoke("remoteCodex:threadResume", params),
  remoteThreadNameSet: (params) => ipcRenderer.invoke("remoteCodex:threadNameSet", params),
  remoteTurnStart: (params) => ipcRenderer.invoke("remoteCodex:turnStart", params),
  remoteTurnSteer: (params) => ipcRenderer.invoke("remoteCodex:turnSteer", params),
  remoteTurnInterrupt: (params) => ipcRenderer.invoke("remoteCodex:turnInterrupt", params),
  remoteRespond: async (id, result) => {
    await ipcRenderer.invoke("remoteCodex:respond", { id, result });
  },
  onCodexEvent: (listener) => {
    const handler = (_evt: Electron.IpcRendererEvent, ev: CodexEvent) => listener(ev);
    ipcRenderer.on("codex:event", handler);
    return () => ipcRenderer.off("codex:event", handler);
  },
  onRemoteEvent: (listener) => {
    const handler = (_evt: Electron.IpcRendererEvent, ev: CodexEvent) => listener(ev);
    ipcRenderer.on("remote:event", handler);
    return () => ipcRenderer.off("remote:event", handler);
  },
  onWorkspaceEvent: (listener) => {
    const handler = (_evt: Electron.IpcRendererEvent, ev: WorkspaceWatchEvent) => listener(ev);
    ipcRenderer.on("workspace:event", handler);
    return () => ipcRenderer.off("workspace:event", handler);
  },
  onTerminalEvent: (listener) => {
    const handler = (_evt: Electron.IpcRendererEvent, ev: TerminalEvent) => listener(ev);
    ipcRenderer.on("terminal:event", handler);
    return () => ipcRenderer.off("terminal:event", handler);
  }
};

contextBridge.exposeInMainWorld("tazhan", api);
