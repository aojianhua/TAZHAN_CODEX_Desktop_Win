export type RpcId = number | string;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "exited";

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ThemeMode = "light" | "dark";

export type AutoReplyMode = "infinite" | "times";

export type AutoReplySettings = {
  enabled: boolean;
  message: string;
  mode: AutoReplyMode;
  times: number;
};

export type ApiProviderProfile = {
  id: string;
  name: string;
  codexProvider: string;
  baseUrl: string;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
};

export type RelayDeviceAuth = {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type RelayE2eeTrustedPeer = {
  keyId: string;
  label: string;
  // base64(spki der)
  ed25519PublicKey: string;
  addedAt: number;
};

export type RelayE2eeSettings = {
  enabled: boolean;
  // If true, desktop refuses to process plaintext remote commands (only accepts e2ee packets/handshake).
  required: boolean;
  // Trust-on-first-use for peer keys. Prefer false in production.
  allowTofu: boolean;

  // Device signing identity (ed25519). Public key can be published via cloud APIs.
  deviceKeyId: string;
  // base64(spki der)
  deviceEd25519PublicKey: string;
  // base64(pkcs8 der) or "enc:<base64(electron safeStorage encrypted bytes)>"
  deviceEd25519PrivateKey: string;

  trustedPeers: RelayE2eeTrustedPeer[];
};

export type RelaySettings = {
  enabled: boolean;
  baseUrl: string;
  auth: RelayDeviceAuth | null;
  lastPairingCode: string;
  lastPairingExpiresAt: number;
  lastPairingQrPayload: string;
  allowedRoots: string[];
  e2ee: RelayE2eeSettings;
};

export type RelayPairing = {
  pairingCode: string;
  expiresAt: number;
  qrPayload: string;
};

export type RelayPairingRefreshArgs = {
  baseUrl?: string;
};

export type RelayPairingRefreshResult = {
  ok: boolean;
  pairing: RelayPairing | null;
  error: string | null;
};

export type SshDefaults = {
  host: string;
  port: number;
  username: string;
  workspaceRoot: string;
};

export type SshProbeArgs = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export type SshProbeResult = {
  ok: boolean;
  latencyMs: number | null;
  host: string;
  port: number;
  username: string;
  uname: string | null;
  codexPath: string | null;
  codexVersion: string | null;
  nodeVersion: string | null;
  npmVersion: string | null;
  error: string | null;
};

export type RemoteWorkspaceConnectArgs = {
  host: string;
  port: number;
  username: string;
  password: string;
  workspaceRoot: string;
  useLoginShell: boolean;
};

export type RemoteWorkspaceConnectResult = {
  ok: boolean;
  error: string | null;
};

export type RemoteWorkspaceStatus = {
  connected: boolean;
  host: string;
  port: number;
  username: string;
  workspaceRoot: string;
};

export type RemoteWorkspaceCandidate = {
  path: string;
  label: string;
  hasGit: boolean;
  hasPackageJson: boolean;
};

export type RemoteWorkspaceScanResult = {
  ok: boolean;
  home: string;
  candidates: RemoteWorkspaceCandidate[];
  error: string | null;
};

export type RemoteWorkspaceMkdirAbsArgs = SshProbeArgs & {
  absPath: string;
};

export type RemoteWorkspaceMkdirAbsResult = {
  ok: boolean;
  absPath: string | null;
  error: string | null;
};

export interface AppSettings {
  theme: ThemeMode;
  codexPath: string;
  defaultCwd: string;
  notifyWebhookUrl: string;
  model: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  reasoningEffort: ReasoningEffort | "";
  notifyOnComplete: boolean;
  notifyThreads: Record<string, boolean>;
  autoReply: AutoReplySettings;
  workspaceNames: Record<string, string>;
  apiProfiles: ApiProviderProfile[];
  apiActiveProfileId: string | null;
  relay: RelaySettings;
  sshDefaults: SshDefaults;
}

export type CodexEvent =
  | { type: "status"; status: ConnectionStatus; details?: string }
  | { type: "stderr"; line: string }
  | { type: "notification"; method: string; params?: JsonValue }
  | { type: "request"; id: RpcId; method: string; params?: JsonValue };

export type CodexModel = {
  id: string;
  model: string;
  upgrade: string | null;
  displayName: string;
  description: string;
  supportedReasoningEfforts: { reasoningEffort: ReasoningEffort; description: string }[];
  defaultReasoningEffort: ReasoningEffort;
  isDefault: boolean;
};

export type CodexCliInfo = {
  installed: boolean;
  resolvedCommand: string | null;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  nodeInstalled: boolean;
  nodeVersion: string | null;
  vcRedistX64Installed: boolean | null;
  vcRedistX64Version: string | null;
  error: string | null;
};

export type CodexRuntimeInstallTarget = "nodejs" | "vcRedistX64";

export type CodexRuntimeInstallResult = {
  ok: boolean;
  target: CodexRuntimeInstallTarget;
  label: string;
  version: string | null;
  installerPath: string | null;
  error: string | null;
};

export type CodexUserConfigReadResult = {
  ok: boolean;
  codexHome: string;
  configPath: string;
  authPath: string;
  model: string;
  modelProvider: string | null;
  baseUrl: string;
  apiKeyPresent: boolean;
  apiKeyMasked: string | null;
  error: string | null;
};

export type CodexUserConfigWriteArgs = {
  model: string | null;
  modelProvider: string | null;
  baseUrl: string;
  apiKey: string | null;
  clearApiKey: boolean;
};

export type CodexUserConfigWriteResult = {
  ok: boolean;
  error: string | null;
};

export type CodexProviderTestResult = {
  ok: boolean;
  latencyMs: number | null;
  status: number | null;
  modelsCount: number | null;
  suggestedBaseUrl: string | null;
  error: string | null;
};

export type WorkspaceDirEntryKind = "file" | "dir";

export type WorkspaceDirEntry = {
  name: string;
  path: string;
  kind: WorkspaceDirEntryKind;
};

export type WorkspaceListDirResult = {
  ok: boolean;
  entries: WorkspaceDirEntry[];
  error: string | null;
};

export type WorkspaceReadFileResult = {
  ok: boolean;
  content: string;
  truncated: boolean;
  error: string | null;
};

export type WorkspaceOpResult = {
  ok: boolean;
  error: string | null;
};

export type RemoteOpenInTerminalArgs = {
  cwd: string;
};

export type WorkspacePathResult = {
  ok: boolean;
  path: string | null;
  error: string | null;
};

export type WorkspaceWatchSetArgs = {
  root: string;
  dirs: string[];
};

export type WorkspaceWatchSetResult = {
  ok: boolean;
  error: string | null;
};

export type WorkspaceWatchEvent = {
  root: string;
  dir: string;
  atMs: number;
};

export type LlmRole = "system" | "user" | "assistant";

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

export type LlmChatCompleteArgs = {
  messages: LlmMessage[];
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
};

export type LlmChatCompleteResult = {
  ok: boolean;
  text: string;
  error: string | null;
};

export type TerminalScope = "local" | "remote";

export type TerminalRunArgs = {
  scope: TerminalScope;
  cwd: string;
  command: string;
  timeoutMs?: number;
};

export type TerminalRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
};

export type TerminalCreateArgs = {
  scope: TerminalScope;
  cwd: string;
  cols: number;
  rows: number;
};

export type TerminalCreateResult = {
  ok: boolean;
  terminalId: string | null;
  error: string | null;
};

export type TerminalWriteArgs = {
  terminalId: string;
  data: string;
};

export type TerminalResizeArgs = {
  terminalId: string;
  cols: number;
  rows: number;
};

export type TerminalDisposeArgs = {
  terminalId: string;
};

export type TerminalEvent =
  | { type: "data"; terminalId: string; data: string }
  | { type: "exit"; terminalId: string; exitCode: number | null; signal: string | null }
  | { type: "error"; terminalId: string; error: string };
