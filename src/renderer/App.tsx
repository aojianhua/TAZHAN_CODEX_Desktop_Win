import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  ApiProviderProfile,
  AppSettings,
  ApprovalPolicy,
  AutoReplyMode,
  CodexCliInfo,
  CodexRuntimeInstallTarget,
  CodexEvent,
  CodexModel,
  CodexProviderTestResult,
  ConnectionStatus,
  LlmMessage,
  RemoteWorkspaceCandidate,
  RemoteWorkspaceScanResult,
  RemoteWorkspaceStatus,
  ReasoningEffort,
  RelayE2eeTrustedPeer,
  RpcId,
  SshProbeResult,
  SandboxMode,
  ThemeMode
} from "../shared/types";

import { TerminalDock } from "./components/TerminalDock";
import {
  buildComposerTurnInput,
  filesToComposerImageAttachments,
  formatComposerAttachmentMeta,
  type ComposerImageAttachment
} from "./composerImages";
import { builtinSkills } from "./skills/registry";
import {
  formatInterviewTranscript,
  parseInterviewBatchQuestions,
  parseInterviewNextQuestion,
  type InterviewQa
} from "./skills/interview";
import { renderSkillTemplate } from "./skills/template";
import type {
  SkillCustomRenderProps,
  SkillInterviewManifestV1,
  SkillManifestV1,
  SkillStepV1,
  SkillWizardManifestV1
} from "./skills/types";

type ApprovalRequest = {
  id: RpcId;
  method: string;
  params: any;
  scope: "local" | "remote";
  threadId: string | null;
};

type ToolTabId = "activity" | "terminal" | "files" | "diff" | "log";

type SidebarPanelId = "threads" | "explorer";

type AutoReplyRuntime = {
  remaining: number | null;
  pendingTurnId: string | null;
};

type FilePreviewState = {
  threadId: string;
  path: string;
  mode: "view" | "edit";
  draft: string;
  saving: boolean;
  error: string | null;
};

type FileOpState =
  | { kind: "newFolder" | "newFile"; threadId: string; parentDir: string; name: string }
  | { kind: "rename"; threadId: string; path: string; newName: string }
  | { kind: "delete"; threadId: string; path: string; entryKind: "file" | "dir" };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  turnId: string;
  durationMs: number | null;
  placeholder: boolean;
};

type SendToThreadOverrides = {
  cwd?: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  reasoningEffort?: ReasoningEffort | "";
  input?: Array<{ type: string; [key: string]: unknown }>;
  previewText?: string;
};

type NavIconName =
  | "compose"
  | "search"
  | "image"
  | "apps"
  | "codex"
  | "gpt"
  | "project"
  | "panel"
  | "plus"
  | "phone"
  | "server"
  | "mic"
  | "send"
  | "share"
  | "more"
  | "sidebar"
  | "settings"
  | "copy"
  | "refresh";

type PreferencesScrollSection = "engine" | "defaults" | "api" | "connectivity";

type ThreadMeta = {
  id: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  modelProvider: string;
};

type CommandRun = {
  itemId: string;
  command: string;
  cwd: string;
  status: string;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
};

type PatchChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; movePath: string | null };

type FileUpdateChange = {
  path: string;
  kind: PatchChangeKind;
  diff: string;
};

type FileChangeItem = {
  itemId: string;
  status: string;
  changes: FileUpdateChange[];
};

type ThreadTokenUsageState = {
  totalTokens: number;
  modelContextWindow: number | null;
};

type TurnPlanStep = { step: string; status: "pending" | "inProgress" | "completed" };

type TurnPlanState = {
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
};

type TurnErrorState = {
  threadId: string;
  turnId: string | null;
  message: string;
  codexErrorInfo: string | null;
  willRetry: boolean | null;
  atMs: number;
};

type ActivitySource = {
  turnPlan: TurnPlanState | null;
  turnError: TurnErrorState | null;
  turnItemsById: Record<string, any>;
  turnItemOrder: string[];
};

type TurnActivitySnapshot = ActivitySource & {
  durationMs: number | null;
};

type ThreadConfigState = ThreadState["config"];

type ExplorerEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
};

type ExplorerState = {
  entriesByDir: Record<string, ExplorerEntry[]>;
  expandedDirs: Record<string, boolean>;
  loadingDirs: Record<string, boolean>;
  selectedEntry: { path: string; kind: "file" | "dir" } | null;
  selectedPath: string | null;
  selectedContent: string;
  selectedTruncated: boolean;
  selectedError: string | null;
  loadingFile: boolean;
};

type ExplorerContextMenuState = {
  scope: "local" | "remote";
  threadId: string;
  root: string;
  target: ExplorerEntry;
  parentDir: string;
  anchorX: number;
  anchorY: number;
  left: number;
  top: number;
};

type ThreadState = {
  meta: ThreadMeta;
  turnId: string;
  running: boolean;
  activeTurnStartedAtMs: number | null;
  lastTurnCompletedAtMs: number | null;
  lastTurnDurationMs: number | null;
  historyLoaded: boolean;
  tokenUsage: ThreadTokenUsageState | null;
  turnPlan: TurnPlanState | null;
  turnError: TurnErrorState | null;
  turnItemsById: Record<string, any>;
  turnItemOrder: string[];
  turnActivityByTurnId: Record<string, TurnActivitySnapshot>;
  turnActivityOrder: string[];
  turnActivityCollapsedByTurnId: Record<string, boolean>;
  config: {
    model: string;
    approvalPolicy: ApprovalPolicy;
    sandbox: SandboxMode;
    reasoningEffort: ReasoningEffort | "";
  };
  messages: ChatMessage[];
  commands: CommandRun[];
  fileChanges: FileChangeItem[];
  expandedFiles: Record<string, boolean>;
  explorer: ExplorerState;
  turnDiff: string;
};

function statusDotClass(status: ConnectionStatus): string {
  switch (status) {
    case "connected":
      return "dot ok";
    case "connecting":
      return "dot warn";
    case "exited":
      return "dot bad";
    case "disconnected":
    default:
      return "dot";
  }
}

function statusLabel(status: ConnectionStatus): string {
  switch (status) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "exited":
      return "已退出";
    case "disconnected":
    default:
      return "未连接";
  }
}

function stringifyShort(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pathDirname(value: string): string {
  const s = String(value);
  const a = s.lastIndexOf("/");
  const b = s.lastIndexOf("\\");
  const idx = Math.max(a, b);
  if (idx <= 0) {
    return "";
  }
  return s.slice(0, idx);
}

function pathBasename(value: string): string {
  const s = String(value);
  const a = s.lastIndexOf("/");
  const b = s.lastIndexOf("\\");
  const idx = Math.max(a, b);
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function isAbsoluteFsPath(value: string): boolean {
  const s = String(value).trim();
  if (!s) {
    return false;
  }
  if (/^[a-zA-Z]:[\\/]/.test(s)) {
    return true;
  }
  if (s.startsWith("\\\\")) {
    return true;
  }
  if (s.startsWith("/")) {
    return true;
  }
  return false;
}

function joinFsPath(root: string, maybeRelativePath: string): string {
  const p = String(maybeRelativePath ?? "").trim();
  if (!p) {
    return String(root ?? "");
  }
  if (isAbsoluteFsPath(p)) {
    return p;
  }
  const r = String(root ?? "").trim();
  if (!r) {
    return p;
  }
  const sep = r.includes("\\") ? "\\" : "/";
  return `${r.replace(/[\\/]+$/, "")}${sep}${p.replace(/^[\\/]+/, "")}`;
}

function renderMessageText(text: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let key = 0;

  function pushTextWithBold(raw: string): void {
    if (!raw) {
      return;
    }
    let pos = 0;
    for (;;) {
      const start = raw.indexOf("**", pos);
      if (start < 0) {
        if (pos < raw.length) {
          nodes.push(raw.slice(pos));
        }
        return;
      }
      const end = raw.indexOf("**", start + 2);
      if (end < 0) {
        nodes.push(raw.slice(pos));
        return;
      }
      if (start > pos) {
        nodes.push(raw.slice(pos, start));
      }
      const content = raw.slice(start + 2, end);
      if (content) {
        nodes.push(
          <span key={`b_${key++}`} className="msgStrong">
            {content}
          </span>
        );
      }
      pos = end + 2;
    }
  }

  let i = 0;
  for (;;) {
    const start = text.indexOf("`", i);
    if (start < 0) {
      pushTextWithBold(text.slice(i));
      break;
    }
    if (start > i) {
      pushTextWithBold(text.slice(i, start));
    }
    const end = text.indexOf("`", start + 1);
    if (end < 0) {
      pushTextWithBold(text.slice(start));
      break;
    }
    const code = text.slice(start + 1, end);
    nodes.push(
      <span key={`c_${key++}`} className="msgEmph">
        {code}
      </span>
    );
    i = end + 1;
  }

  return nodes;
}

function approvalPolicyLabel(value: ApprovalPolicy): string {
  switch (value) {
    case "untrusted":
      return "不信任（仅白名单命令）";
    case "on-failure":
      return "失败时询问";
    case "on-request":
      return "按需询问";
    case "never":
      return "从不询问";
  }
}

function approvalPolicyShortLabel(value: ApprovalPolicy): string {
  switch (value) {
    case "untrusted":
      return "不信任";
    case "on-failure":
      return "失败询问";
    case "on-request":
      return "按需询问";
    case "never":
      return "不询问";
  }
}

function sandboxModeLabel(value: SandboxMode): string {
  switch (value) {
    case "read-only":
      return "只读";
    case "workspace-write":
      return "工作区可写";
    case "danger-full-access":
      return "危险：完全权限";
  }
}

function sandboxModeShortLabel(value: SandboxMode): string {
  switch (value) {
    case "read-only":
      return "只读";
    case "workspace-write":
      return "可写";
    case "danger-full-access":
      return "全权限";
  }
}

function reasoningEffortLabel(value: ReasoningEffort): string {
  switch (value) {
    case "none":
      return "无";
    case "minimal":
      return "极低";
    case "low":
      return "低";
    case "medium":
      return "中";
    case "high":
      return "高";
    case "xhigh":
      return "超高";
  }
}

function patchKindLabel(kind: PatchChangeKind): string {
  switch (kind.type) {
    case "add":
      return "新增";
    case "delete":
      return "删除";
    case "update":
      return "修改";
  }
}

function patchKindClass(kind: PatchChangeKind): string {
  switch (kind.type) {
    case "add":
      return "badge ok";
    case "delete":
      return "badge bad";
    case "update":
      return "badge warn";
  }
}

function diffLineClass(line: string): string {
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "diffLine meta";
  }
  if (line.startsWith("@@")) {
    return "diffLine hunk";
  }
  if (line.startsWith("+")) {
    return "diffLine add";
  }
  if (line.startsWith("-")) {
    return "diffLine del";
  }
  return "diffLine";
}

function threadGroupLabel(tsSeconds: number): string {
  if (!tsSeconds) {
    return "更早";
  }

  const d = new Date(tsSeconds * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) {
    return "今天";
  }

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function cwdLabel(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) {
    return "未选择工作区";
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? trimmed;
}

function cwdKey(cwd: string): string {
  return cwd.trim().replace(/\\/g, "/").toLowerCase();
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) {
    return `${Math.max(1, seconds)}秒`;
  }
  if (minutes < 60) {
    return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
  }
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (!remainMinutes) {
    return `${hours}小时`;
  }
  return `${hours}小时${remainMinutes}分`;
}

function formatRelativeMinutes(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) {
    return "刚刚";
  }
  if (minutes < 60) {
    return `${minutes}分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}小时前`;
  }
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function threadStatusLine(thread: ThreadState, nowMs: number): string {
  if (thread.running) {
    const startedAtMs = thread.activeTurnStartedAtMs ?? nowMs;
    return `运行中 · ${formatElapsed(nowMs - startedAtMs)}`;
  }
  if (thread.lastTurnCompletedAtMs) {
    const completedText = formatRelativeMinutes(nowMs - thread.lastTurnCompletedAtMs);
    return `已完成 · ${completedText}`;
  }
  return "就绪";
}

function threadStatusPillLabel(thread: ThreadState, nowMs: number): string {
  if (thread.running) {
    const startedAtMs = thread.activeTurnStartedAtMs ?? nowMs;
    const minutes = Math.max(1, Math.floor((nowMs - startedAtMs) / 60000));
    return `运行${minutes}分`;
  }
  if (thread.lastTurnCompletedAtMs) {
    return `完成 ${formatRelativeMinutes(nowMs - thread.lastTurnCompletedAtMs)}`;
  }
  return "空闲";
}

function sandboxPolicyToMode(policy: any): SandboxMode {
  const ty = policy?.type;
  switch (ty) {
    case "readOnly":
      return "read-only";
    case "workspaceWrite":
      return "workspace-write";
    case "dangerFullAccess":
      return "danger-full-access";
    case "externalSandbox":
    default:
      return "workspace-write";
  }
}

function sandboxModeToPolicy(mode: SandboxMode, cwd: string): any | null {
  switch (mode) {
    case "read-only":
      return { type: "readOnly" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write": {
      const root = cwd.trim();
      if (!root) {
        return null;
      }
      return {
        type: "workspaceWrite",
        writableRoots: [root],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      };
    }
  }
}

function threadMetaFromServer(thread: any): ThreadMeta {
  return {
    id: typeof thread?.id === "string" ? thread.id : "",
    preview: typeof thread?.preview === "string" ? thread.preview : "",
    cwd: typeof thread?.cwd === "string" ? thread.cwd : "",
    createdAt: typeof thread?.createdAt === "number" ? thread.createdAt : 0,
    updatedAt: typeof thread?.updatedAt === "number" ? thread.updatedAt : 0,
    modelProvider: typeof thread?.modelProvider === "string" ? thread.modelProvider : ""
  };
}

function userInputToText(content: any[]): string {
  const parts: string[] = [];
  for (const el of content) {
    if (el?.type === "text" && typeof el?.text === "string") {
      parts.push(el.text);
      continue;
    }
    if (el?.type === "mention" && typeof el?.name === "string") {
      parts.push(`@${el.name}`);
      continue;
    }
    if (el?.type === "skill" && typeof el?.name === "string") {
      parts.push(`$${el.name}`);
      continue;
    }
    if (el?.type === "image") {
      parts.push("[图片]");
      continue;
    }
    if (el?.type === "localImage" && typeof el?.path === "string") {
      parts.push(`[本地图片] ${el.path}`);
      continue;
    }
  }
  return parts.join("");
}

async function handlePastedImageFiles(files: File[]): Promise<ComposerImageAttachment[]> {
  const imageFiles = files.filter((file) => file.type.startsWith("image/"));
  if (imageFiles.length === 0) {
    return [];
  }
  return await filesToComposerImageAttachments(imageFiles);
}

function threadToMessages(thread: any): ChatMessage[] {
  const turns = Array.isArray(thread?.turns) ? (thread.turns as any[]) : [];
  const out: ChatMessage[] = [];

  for (const turn of turns) {
    const turnId = typeof turn?.id === "string" ? turn.id : "";
    const items = Array.isArray(turn?.items) ? (turn.items as any[]) : [];
    for (const item of items) {
      const ty = item?.type;
      const id = typeof item?.id === "string" ? item.id : `item_${out.length}`;

      if (ty === "userMessage") {
        const content = Array.isArray(item?.content) ? (item.content as any[]) : [];
        const text = userInputToText(content);
        if (text.trim().length > 0) {
          out.push({ id, role: "user", text, turnId, durationMs: null, placeholder: false });
        }
        continue;
      }

      if (ty === "agentMessage") {
        const text = typeof item?.text === "string" ? item.text : "";
        if (text.trim().length > 0) {
          out.push({ id, role: "assistant", text, turnId, durationMs: null, placeholder: false });
        }
        continue;
      }
    }
  }

  return out;
}

function makeEmptyThreadState(threadId: string, config?: Partial<ThreadConfigState>): ThreadState {
  return {
    meta: {
      id: threadId,
      preview: "",
      cwd: "",
      createdAt: 0,
      updatedAt: 0,
      modelProvider: ""
    },
    turnId: "",
    running: false,
    activeTurnStartedAtMs: null,
    lastTurnCompletedAtMs: null,
    lastTurnDurationMs: null,
    historyLoaded: false,
    tokenUsage: null,
    turnPlan: null,
    turnError: null,
    turnItemsById: {},
    turnItemOrder: [],
    turnActivityByTurnId: {},
    turnActivityOrder: [],
    turnActivityCollapsedByTurnId: {},
    config: {
      model: "",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      reasoningEffort: "",
      ...(config ?? {})
    },
    messages: [],
    commands: [],
    fileChanges: [],
    expandedFiles: {},
    explorer: {
      entriesByDir: {},
      expandedDirs: {},
      loadingDirs: {},
      selectedEntry: null,
      selectedPath: null,
      selectedContent: "",
      selectedTruncated: false,
      selectedError: null,
      loadingFile: false
    },
    turnDiff: ""
  };
}

function iconPath(name: NavIconName): JSX.Element {
  switch (name) {
    case "compose":
      return (
        <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
      );
    case "search":
      return <path d="M21 21l-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z" />;
    case "image":
      return <path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM21 15l-5-5-4 4-2-2-5 5" />;
    case "apps":
      return (
        <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
      );
    case "codex":
      return <path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13 7l-2 10" />;
    case "gpt":
      return <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5" />;
    case "project":
      return <path d="M3 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />;
    case "panel":
      return <path d="M4 5h16v14H4zM9 5v14" />;
    case "plus":
      return <path d="M12 5v14M5 12h14" />;
    case "phone":
      return (
        <>
          <rect x="7" y="2" width="10" height="20" rx="2" />
          <path d="M11 18h2" />
        </>
      );
    case "server":
      return (
        <>
          <path d="M4 4h16v6H4z" />
          <path d="M4 14h16v6H4z" />
          <path d="M7 7h.01M10 7h.01M7 17h.01M10 17h.01" />
        </>
      );
    case "mic":
      return (
        <>
          <path d="M12 1a3 3 0 0 1 3 3v8a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <path d="M12 19v4" />
          <path d="M8 23h8" />
        </>
      );
    case "send":
      return <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />;
    case "share":
      return <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />;
    case "more":
      return <path d="M6 12h.01M12 12h.01M18 12h.01" />;
    case "sidebar":
      return (
        <>
          <path d="M4 5h16v14H4z" />
          <path d="M9 5v14" />
          <path d="M15 9l-3 3 3 3" />
        </>
      );
    case "settings":
      return (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </>
      );
    case "copy":
      return <path d="M9 9h11v11H9zM4 4h11v11H4z" />;
    case "refresh":
      return <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />;
  }
}

function Icon({ name }: { name: NavIconName }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconPath(name)}
    </svg>
  );
}

export function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [remoteCodexStatus, setRemoteCodexStatus] = useState<ConnectionStatus>("disconnected");
  const [codexCliInfo, setCodexCliInfo] = useState<CodexCliInfo | null>(null);
  const [codexCliBusy, setCodexCliBusy] = useState<boolean>(false);
  const [runtimeInstallBusy, setRuntimeInstallBusy] = useState<CodexRuntimeInstallTarget | null>(null);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [remoteModels, setRemoteModels] = useState<CodexModel[]>([]);
  const [toolTab, setToolTab] = useState<ToolTabId>("terminal");
  const [toolDrawerOpen, setToolDrawerOpen] = useState<boolean>(false);
  const [newThreadBusy, setNewThreadBusy] = useState<boolean>(false);
  const [sshOpen, setSshOpen] = useState<boolean>(false);
  const [sshBusy, setSshBusy] = useState<boolean>(false);
  const [sshHost, setSshHost] = useState<string>("");
  const [sshPort, setSshPort] = useState<number>(22);
  const [sshUsername, setSshUsername] = useState<string>("");
  const [sshPassword, setSshPassword] = useState<string>("");
  const [sshStep, setSshStep] = useState<"connect" | "workspace">("connect");
  const [sshWorkspaceRoot, setSshWorkspaceRoot] = useState<string>("/home/ubuntu/TAZHAN_WEB");
  const [sshUseLoginShell, setSshUseLoginShell] = useState<boolean>(true);
  const [sshResult, setSshResult] = useState<SshProbeResult | null>(null);
  const [sshError, setSshError] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteWorkspaceStatus | null>(null);
  const [remoteWorkspaceCandidates, setRemoteWorkspaceCandidates] = useState<RemoteWorkspaceCandidate[]>([]);
  const [remoteWorkspaceHome, setRemoteWorkspaceHome] = useState<string>("");
  const [remoteWorkspaceScanBusy, setRemoteWorkspaceScanBusy] = useState<boolean>(false);
  const [remoteWorkspaceScanError, setRemoteWorkspaceScanError] = useState<string | null>(null);
  const [sshNewWorkspaceParent, setSshNewWorkspaceParent] = useState<string>("");
  const [sshNewWorkspaceName, setSshNewWorkspaceName] = useState<string>("");
  const [sshNewWorkspaceBusy, setSshNewWorkspaceBusy] = useState<boolean>(false);
  const [sshNewWorkspaceError, setSshNewWorkspaceError] = useState<string | null>(null);

  const [viewScope, setViewScope] = useState<"local" | "remote">("local");

  const [newChatOpen, setNewChatOpen] = useState<boolean>(false);
  const [newChatPrevThreadId, setNewChatPrevThreadId] = useState<string | null>(null);
  const [newChatDraftMessage, setNewChatDraftMessage] = useState<string>("");

  const [prefsOpen, setPrefsOpen] = useState<boolean>(false);
  const [prefsCodexPath, setPrefsCodexPath] = useState<string>("codex");
  const [prefsWebhookUrl, setPrefsWebhookUrl] = useState<string>("");
  const [prefsRelayEnabled, setPrefsRelayEnabled] = useState<boolean>(false);
  const [prefsRelayBaseUrl, setPrefsRelayBaseUrl] = useState<string>("");
  const [prefsTheme, setPrefsTheme] = useState<ThemeMode>("light");
  const [prefsDefaultCwd, setPrefsDefaultCwd] = useState<string>("");
  const [prefsModel, setPrefsModel] = useState<string>("");
  const [prefsReasoningEffort, setPrefsReasoningEffort] = useState<ReasoningEffort | "">("");
  const [prefsApprovalPolicy, setPrefsApprovalPolicy] = useState<ApprovalPolicy>("on-request");
  const [prefsSandbox, setPrefsSandbox] = useState<SandboxMode>("workspace-write");
  const [prefsNotifyOnComplete, setPrefsNotifyOnComplete] = useState<boolean>(true);
  const [prefsSection, setPrefsSection] = useState<PreferencesScrollSection>("engine");

  const [pairOpen, setPairOpen] = useState<boolean>(false);
  const [pairBusy, setPairBusy] = useState<boolean>(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairQrDataUrl, setPairQrDataUrl] = useState<string | null>(null);

  const [relayE2eePeerLabel, setRelayE2eePeerLabel] = useState<string>("");
  const [relayE2eePeerEd25519Pub, setRelayE2eePeerEd25519Pub] = useState<string>("");
  const [relayE2eePeerBusy, setRelayE2eePeerBusy] = useState<boolean>(false);
  const [relayE2eePeerError, setRelayE2eePeerError] = useState<string | null>(null);

  const [apiOpen, setApiOpen] = useState<boolean>(false);
  const [apiBusy, setApiBusy] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiLiveCodexHome, setApiLiveCodexHome] = useState<string>("");
  const [apiLiveConfigPath, setApiLiveConfigPath] = useState<string>("");
  const [apiLiveAuthPath, setApiLiveAuthPath] = useState<string>("");
  const [apiLiveModelProvider, setApiLiveModelProvider] = useState<string | null>(null);
  const [apiLiveBaseUrl, setApiLiveBaseUrl] = useState<string>("");
  const [apiLiveKeyPresent, setApiLiveKeyPresent] = useState<boolean>(false);
  const [apiLiveKeyMasked, setApiLiveKeyMasked] = useState<string | null>(null);

  const [apiSelectedProfileId, setApiSelectedProfileId] = useState<string | null>(null);
  const [apiProfileName, setApiProfileName] = useState<string>("");
  const [apiProfileProvider, setApiProfileProvider] = useState<string>("");
  const [apiProfileBaseUrl, setApiProfileBaseUrl] = useState<string>("");
  const [apiProfileApiKey, setApiProfileApiKey] = useState<string>("");
  const [apiProfileShowKey, setApiProfileShowKey] = useState<boolean>(false);
  const [apiTestResult, setApiTestResult] = useState<CodexProviderTestResult | null>(null);
  const [apiTestBusy, setApiTestBusy] = useState<boolean>(false);

  const [skillSelectedId, setSkillSelectedId] = useState<string | null>(null);
  const [skillPanelCollapsed, setSkillPanelCollapsed] = useState<boolean>(false);
  const [skillBusyTurnId, setSkillBusyTurnId] = useState<string | null>(null);
  const [skillBusyStartedAtMs, setSkillBusyStartedAtMs] = useState<number | null>(null);
  const [skillPopoverOpen, setSkillPopoverOpen] = useState<boolean>(true);

  const [interviewSeed, setInterviewSeed] = useState<string>("");
  const [interviewOutputPath, setInterviewOutputPath] = useState<string>("docs/需求.md");
  const [interviewMaxQuestions, setInterviewMaxQuestions] = useState<number>(10);
  const [interviewQa, setInterviewQa] = useState<InterviewQa[]>([]);
  const [interviewQuestion, setInterviewQuestion] = useState<string>("");
  const [interviewWhy, setInterviewWhy] = useState<string>("");
  const [interviewAskMode, setInterviewAskMode] = useState<"followUp" | "batch">("followUp");
  const [interviewBusy, setInterviewBusy] = useState<boolean>(false);
  const [interviewError, setInterviewError] = useState<string | null>(null);
  const [interviewPrd, setInterviewPrd] = useState<string>("");
  const [interviewSavedPath, setInterviewSavedPath] = useState<string | null>(null);

  const [wizardAnswers, setWizardAnswers] = useState<Record<string, string>>({});
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [wizardSavedPath, setWizardSavedPath] = useState<string | null>(null);

  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState<boolean>(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState<boolean>(false);
  const [threadMenuOpenId, setThreadMenuOpenId] = useState<string | null>(null);
  const [renameThreadId, setRenameThreadId] = useState<string | null>(null);
  const [renameThreadName, setRenameThreadName] = useState<string>("");

  const [composerMenuOpen, setComposerMenuOpen] = useState<null | "model" | "policy" | "autoReply" | "skill">(null);
  const [newChatMenuOpen, setNewChatMenuOpen] = useState<null | "model" | "effort" | "sandbox" | "approval">(null);
  const [composerCustomModelDraft, setComposerCustomModelDraft] = useState<string>("");
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanelId>("threads");
  const [composerModelMenuStyle, setComposerModelMenuStyle] = useState<React.CSSProperties>({});
  const [composerPolicyMenuStyle, setComposerPolicyMenuStyle] = useState<React.CSSProperties>({});
  const [composerAutoReplyMenuStyle, setComposerAutoReplyMenuStyle] = useState<React.CSSProperties>({});
  const [composerSkillMenuStyle, setComposerSkillMenuStyle] = useState<React.CSSProperties>({});

  const [autoReplyEnabledDraft, setAutoReplyEnabledDraft] = useState<boolean>(false);
  const [autoReplyMessageDraft, setAutoReplyMessageDraft] = useState<string>("");
  const [autoReplyModeDraft, setAutoReplyModeDraft] = useState<AutoReplyMode>("infinite");
  const [autoReplyTimesDraft, setAutoReplyTimesDraft] = useState<number>(1);

  const [newChatCwd, setNewChatCwd] = useState<string>("");
  const [newChatModel, setNewChatModel] = useState<string>("");
  const [newChatReasoningEffort, setNewChatReasoningEffort] = useState<ReasoningEffort | "">("");
  const [newChatApprovalPolicy, setNewChatApprovalPolicy] = useState<ApprovalPolicy>("on-request");
  const [newChatSandbox, setNewChatSandbox] = useState<SandboxMode>("workspace-write");
  const [newChatNotify, setNewChatNotify] = useState<boolean>(true);
  const [newChatResumeThreadId, setNewChatResumeThreadId] = useState<string | null>(null);
  const [threadOrder, setThreadOrder] = useState<string[]>([]);
  const [threadsById, setThreadsById] = useState<Record<string, ThreadState>>({});
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [remoteThreadOrder, setRemoteThreadOrder] = useState<string[]>([]);
  const [remoteThreadsById, setRemoteThreadsById] = useState<Record<string, ThreadState>>({});
  const [remoteActiveThreadId, setRemoteActiveThreadId] = useState<string | null>(null);
  const [autoReplyRuntimeByThreadId, setAutoReplyRuntimeByThreadId] = useState<Record<string, AutoReplyRuntime>>({});
  const [remoteAutoReplyRuntimeByThreadId, setRemoteAutoReplyRuntimeByThreadId] = useState<Record<string, AutoReplyRuntime>>({});
  const [threadListCursor, setThreadListCursor] = useState<string | null>(null);
  const [remoteThreadListCursor, setRemoteThreadListCursor] = useState<string | null>(null);
  const [threadSearch, setThreadSearch] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [draftImages, setDraftImages] = useState<ComposerImageAttachment[]>([]);
  const [eventLog, setEventLog] = useState<string[]>([]);
  const [logQuery, setLogQuery] = useState<string>("");

  const [terminalDockOpen, setTerminalDockOpen] = useState<boolean>(false);
  const [clockMs, setClockMs] = useState<number>(() => Date.now());
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);
  const [fileOp, setFileOp] = useState<FileOpState | null>(null);
  const [fileOpBusy, setFileOpBusy] = useState<boolean>(false);
  const [fileOpError, setFileOpError] = useState<string | null>(null);
  const [explorerMenu, setExplorerMenu] = useState<ExplorerContextMenuState | null>(null);
  const [explorerWatchEnabled, setExplorerWatchEnabled] = useState<boolean>(false);
  const settingsRef = useRef<AppSettings | null>(null);
  const statusRef = useRef<ConnectionStatus>("disconnected");
  const newThreadBusyRef = useRef<boolean>(false);
  const activeThreadIdRef = useRef<string | null>(null);
  const sidebarPanelRef = useRef<SidebarPanelId>("threads");
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const sidebarSearchRef = useRef<HTMLInputElement | null>(null);
  const workspaceBtnRef = useRef<HTMLButtonElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const didAutoConnectRef = useRef<boolean>(false);
  const composerModelBtnRef = useRef<HTMLButtonElement | null>(null);
  const composerPolicyBtnRef = useRef<HTMLButtonElement | null>(null);
  const composerAutoReplyBtnRef = useRef<HTMLButtonElement | null>(null);
  const composerSkillBtnRef = useRef<HTMLButtonElement | null>(null);
  const composerModelMenuRef = useRef<HTMLDivElement | null>(null);
  const composerPolicyMenuRef = useRef<HTMLDivElement | null>(null);
  const composerAutoReplyMenuRef = useRef<HTMLDivElement | null>(null);
  const composerSkillMenuRef = useRef<HTMLDivElement | null>(null);
  const explorerMenuRef = useRef<HTMLDivElement | null>(null);

  function currentDefaultThreadConfig(): ThreadConfigState {
    const s = settingsRef.current;
    return {
      model: s?.model?.trim() ?? "",
      approvalPolicy: s?.approvalPolicy ?? "on-request",
      sandbox: s?.sandbox ?? "workspace-write",
      reasoningEffort: s?.reasoningEffort ?? ""
    };
  }

  function makeThreadState(threadId: string): ThreadState {
    return makeEmptyThreadState(threadId, currentDefaultThreadConfig());
  }

  useEffect(() => {
    if (!settings) {
      return;
    }

    const nextConfig = currentDefaultThreadConfig();
    const syncPendingThreadConfigs = (prev: Record<string, ThreadState>): Record<string, ThreadState> => {
      let changed = false;
      const next = { ...prev };

      for (const [threadId, thread] of Object.entries(prev)) {
        if (
          thread.historyLoaded ||
          (thread.config.model ?? "") === nextConfig.model &&
            thread.config.approvalPolicy === nextConfig.approvalPolicy &&
            thread.config.sandbox === nextConfig.sandbox &&
            (thread.config.reasoningEffort ?? "") === nextConfig.reasoningEffort
        ) {
          continue;
        }

        next[threadId] = {
          ...thread,
          config: { ...nextConfig }
        };
        changed = true;
      }
      return changed ? next : prev;
    };

    setThreadsById(syncPendingThreadConfigs);
    setRemoteThreadsById(syncPendingThreadConfigs);
  }, [settings?.approvalPolicy, settings?.model, settings?.reasoningEffort, settings?.sandbox]);

  const viewThreadsById = viewScope === "remote" ? remoteThreadsById : threadsById;
  const viewThreadOrder = viewScope === "remote" ? remoteThreadOrder : threadOrder;
  const viewActiveThreadId = viewScope === "remote" ? remoteActiveThreadId : activeThreadId;
  const viewThreadListCursor = viewScope === "remote" ? remoteThreadListCursor : threadListCursor;
  const viewModels = viewScope === "remote" ? remoteModels : models;
  const viewStatus = viewScope === "remote" ? remoteCodexStatus : status;

  const activeThread = useMemo(() => {
    if (!viewActiveThreadId) {
      return null;
    }
    return viewThreadsById[viewActiveThreadId] ?? null;
  }, [viewActiveThreadId, viewThreadsById]);

  const filteredEventLog = useMemo(() => {
    const q = logQuery.trim().toLowerCase();
    if (!q) {
      return eventLog;
    }
    const tokens = q.split(/\s+/g).filter(Boolean);
    if (tokens.length === 0) {
      return eventLog;
    }
    return eventLog.filter((line) => {
      const lower = line.toLowerCase();
      return tokens.every((t) => lower.includes(t));
    });
  }, [eventLog, logQuery]);


  const hasRunningThreads = useMemo(
    () => Object.values(threadsById).some((t) => t.running) || Object.values(remoteThreadsById).some((t) => t.running),
    [threadsById, remoteThreadsById]
  );

  const effectiveModel = useMemo((): CodexModel | null => {
    if (viewModels.length === 0) {
      return null;
    }
    const configured = settings?.model?.trim() ?? "";
    if (configured.length > 0) {
      return viewModels.find((m) => m.id === configured) ?? null;
    }
    return viewModels.find((m) => m.isDefault) ?? null;
  }, [viewModels, settings?.model]);

  const newChatEffectiveModel = useMemo((): CodexModel | null => {
    if (viewModels.length === 0) {
      return null;
    }
    const configured = newChatModel.trim();
    if (configured.length > 0) {
      return viewModels.find((m) => m.id === configured) ?? null;
    }
    return viewModels.find((m) => m.isDefault) ?? null;
  }, [viewModels, newChatModel]);

  const prefsEffectiveModel = useMemo((): CodexModel | null => {
    if (viewModels.length === 0) {
      return null;
    }
    const configured = prefsModel.trim();
    if (configured.length > 0) {
      return viewModels.find((m) => m.id === configured) ?? null;
    }
    return viewModels.find((m) => m.isDefault) ?? null;
  }, [viewModels, prefsModel]);

  const prefsModelPresetValue = useMemo((): string => {
    const configured = prefsModel.trim();
    if (!configured) {
      return "";
    }
    return models.some((m) => m.id === configured) ? configured : "__custom__";
  }, [models, prefsModel]);

  const activeSkill = useMemo((): SkillManifestV1 | null => {
    const id = (skillSelectedId ?? "").trim();
    if (!id) {
      return null;
    }
    return builtinSkills.find((s) => s.id === id) ?? null;
  }, [skillSelectedId]);

  const canSend = useMemo(() => {
    if (draft.trim().length === 0 && draftImages.length === 0) {
      return false;
    }
    if (activeSkill?.kind === "interview" && interviewBusy) {
      return false;
    }
    return true;
  }, [draft, draftImages.length, activeSkill?.kind, interviewBusy]);

  const [skillPopoverHeightPx, setSkillPopoverHeightPx] = useState<number>(0);
  const skillPopoverRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!activeSkill) {
      setSkillPopoverHeightPx(0);
      return;
    }
    const el = skillPopoverRef.current;
    if (!el) {
      return;
    }
    const node: HTMLDivElement = el;

    function update(): void {
      const h = Math.max(0, Math.round(node.getBoundingClientRect().height));
      setSkillPopoverHeightPx((prev) => (prev !== h ? h : prev));
    }

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(node);
    return () => ro.disconnect();
  }, [activeSkill?.id, skillPanelCollapsed]);

  const runningThreadCount = useMemo(() => {
    const localCount = threadOrder.reduce((count, id) => (threadsById[id]?.running ? count + 1 : count), 0);
    const remoteCount = remoteThreadOrder.reduce((count, id) => (remoteThreadsById[id]?.running ? count + 1 : count), 0);
    return localCount + remoteCount;
  }, [threadOrder, threadsById, remoteThreadOrder, remoteThreadsById]);

  const relayPairingCode = useMemo(() => (settings?.relay.lastPairingCode ?? "").trim(), [settings?.relay.lastPairingCode]);
  const relayPairingExpiresAt = useMemo(() => settings?.relay.lastPairingExpiresAt ?? 0, [settings?.relay.lastPairingExpiresAt]);
  const relayPairingQrPayload = useMemo(() => {
    const qrPayload = (settings?.relay.lastPairingQrPayload ?? "").trim();
    if (qrPayload) {
      return qrPayload;
    }
    return relayPairingCode ? `tazhan://pair?code=${relayPairingCode}` : "";
  }, [relayPairingCode, settings?.relay.lastPairingQrPayload]);

  useEffect(() => {
    void window.tazhan.getSettings().then((s) => setSettings(s));
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const theme = settings?.theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
  }, [settings?.theme]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    void window.tazhan.remoteWorkspaceStatus().then((st) => setRemoteStatus(st));
  }, [status]);

  useEffect(() => {
    newThreadBusyRef.current = newThreadBusy;
  }, [newThreadBusy]);

  const viewScopeRef = useRef<"local" | "remote">("local");
  useEffect(() => {
    viewScopeRef.current = viewScope;
  }, [viewScope]);

  useEffect(() => {
    activeThreadIdRef.current = viewActiveThreadId;
  }, [viewActiveThreadId]);

  useEffect(() => {
    sidebarPanelRef.current = sidebarPanel;
  }, [sidebarPanel]);

  const threadsByIdRef = useRef<Record<string, ThreadState>>({});
  useEffect(() => {
    threadsByIdRef.current = threadsById;
  }, [threadsById]);

  const remoteThreadsByIdRef = useRef<Record<string, ThreadState>>({});
  useEffect(() => {
    remoteThreadsByIdRef.current = remoteThreadsById;
  }, [remoteThreadsById]);

  useEffect(() => {
    if (sidebarPanel === "explorer" && !viewActiveThreadId) {
      setSidebarPanel("threads");
    }
  }, [sidebarPanel, viewActiveThreadId]);

  useEffect(() => {
    if (filePreview && filePreview.threadId !== viewActiveThreadId) {
      setFilePreview(null);
    }
  }, [filePreview?.threadId, viewActiveThreadId, viewScope]);

  useEffect(() => {
    if (fileOp && fileOp.threadId !== viewActiveThreadId) {
      setFileOp(null);
      setFileOpError(null);
      setFileOpBusy(false);
    }
  }, [fileOp?.threadId, viewActiveThreadId, viewScope]);

  useEffect(() => {
    const setRuntime =
      viewScope === "remote" ? setRemoteAutoReplyRuntimeByThreadId : setAutoReplyRuntimeByThreadId;
    setRuntime((prev) => {
      let changed = false;
      const next: Record<string, AutoReplyRuntime> = { ...prev };
      for (const [threadId, runtime] of Object.entries(prev)) {
        if (!runtime?.pendingTurnId) {
          continue;
        }
        if (viewActiveThreadId && threadId === viewActiveThreadId) {
          continue;
        }
        next[threadId] = { ...runtime, pendingTurnId: null };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [viewScope, viewActiveThreadId]);

  useEffect(() => {
    if (!newChatOpen || status !== "connected") {
      return;
    }
    void refreshThreads();
  }, [newChatOpen, status]);

  useEffect(() => {
    setExplorerMenu(null);
  }, [viewActiveThreadId, viewScope, sidebarPanel]);

  useLayoutEffect(() => {
    function updateComposerMenuPositions(): void {
      const chatPageEl = document.querySelector(".chatPage");
      const chatRect = chatPageEl instanceof HTMLElement ? chatPageEl.getBoundingClientRect() : null;
      const minLeft = (chatRect?.left ?? 0) + 8;
      const maxRight = (chatRect?.right ?? window.innerWidth) - 8;

      if (composerMenuOpen === "model") {
        const anchor = composerModelBtnRef.current;
        const menu = composerModelMenuRef.current;
        if (anchor && menu) {
          const anchorRect = anchor.getBoundingClientRect();
          const menuRect = menu.getBoundingClientRect();
          const desiredLeft = anchorRect.left;
          const left = clamp(desiredLeft, minLeft, maxRight - menuRect.width);
          let top = anchorRect.top - menuRect.height - 8;
          if (top < 8) {
            top = anchorRect.bottom + 8;
          }
          setComposerModelMenuStyle({ position: "fixed", left, top });
        }
      }

      if (composerMenuOpen === "policy") {
        const anchor = composerPolicyBtnRef.current;
        const menu = composerPolicyMenuRef.current;
        if (anchor && menu) {
          const anchorRect = anchor.getBoundingClientRect();
          const menuRect = menu.getBoundingClientRect();
          const desiredLeft = anchorRect.left;
          const left = clamp(desiredLeft, minLeft, maxRight - menuRect.width);
          let top = anchorRect.top - menuRect.height - 8;
          if (top < 8) {
            top = anchorRect.bottom + 8;
          }
          setComposerPolicyMenuStyle({ position: "fixed", left, top });
        }
      }

      if (composerMenuOpen === "autoReply") {
        const anchor = composerAutoReplyBtnRef.current;
        const menu = composerAutoReplyMenuRef.current;
        if (anchor && menu) {
          const anchorRect = anchor.getBoundingClientRect();
          const menuRect = menu.getBoundingClientRect();
          const desiredLeft = anchorRect.left;
          const left = clamp(desiredLeft, minLeft, maxRight - menuRect.width);
          let top = anchorRect.top - menuRect.height - 8;
          if (top < 8) {
            top = anchorRect.bottom + 8;
          }
          setComposerAutoReplyMenuStyle({ position: "fixed", left, top });
        }
      }

      if (composerMenuOpen === "skill") {
        const anchor = composerSkillBtnRef.current;
        const menu = composerSkillMenuRef.current;
        if (anchor && menu) {
          const anchorRect = anchor.getBoundingClientRect();
          const menuRect = menu.getBoundingClientRect();
          const desiredLeft = anchorRect.left;
          const left = clamp(desiredLeft, minLeft, maxRight - menuRect.width);
          let top = anchorRect.top - menuRect.height - 8;
          if (top < 8) {
            top = anchorRect.bottom + 8;
          }
          setComposerSkillMenuStyle({ position: "fixed", left, top });
        }
      }
    }

    updateComposerMenuPositions();
    window.addEventListener("resize", updateComposerMenuPositions);
    return () => {
      window.removeEventListener("resize", updateComposerMenuPositions);
    };
  }, [composerMenuOpen, models, sidebarOpen]);

  useLayoutEffect(() => {
    if (!explorerMenu) {
      return;
    }

    function clampExplorerMenu(): void {
      const menu = explorerMenuRef.current;
      if (!menu) {
        return;
      }

      const rect = menu.getBoundingClientRect();
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);

      setExplorerMenu((prev) => {
        if (!prev) {
          return prev;
        }
        const left = clamp(prev.anchorX, margin, maxLeft);
        const top = clamp(prev.anchorY, margin, maxTop);
        if (left === prev.left && top === prev.top) {
          return prev;
        }
        return { ...prev, left, top };
      });
    }

    clampExplorerMenu();
    window.addEventListener("resize", clampExplorerMenu);
    return () => {
      window.removeEventListener("resize", clampExplorerMenu);
    };
  }, [explorerMenu]);

  useEffect(() => {
    if (!settings || didAutoConnectRef.current) {
      return;
    }
    didAutoConnectRef.current = true;
    void refreshCodexCliInfo();
    const timer = window.setTimeout(() => {
      void connect();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [settings]);

  useEffect(() => {
    if (!settings) {
      return;
    }
    void refreshCodexCliInfo();
  }, [settings?.codexPath]);

  useEffect(() => {
    return window.tazhan.onCodexEvent((ev) => {
      handleEvent("local", ev);
    });
  }, []);

  useEffect(() => {
    return window.tazhan.onRemoteEvent((ev) => {
      handleEvent("remote", ev);
    });
  }, []);

  useEffect(() => {
    const intervalMs = hasRunningThreads ? 1000 : 15000;
    const timer = window.setInterval(() => {
      setClockMs(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [hasRunningThreads]);

  useEffect(() => {
    const threadId = viewActiveThreadId;
    if (!threadId) {
      return;
    }

    const runtimeById = viewScope === "remote" ? remoteAutoReplyRuntimeByThreadId : autoReplyRuntimeByThreadId;
    const setRuntimeById =
      viewScope === "remote" ? setRemoteAutoReplyRuntimeByThreadId : setAutoReplyRuntimeByThreadId;
    const runtime = runtimeById[threadId] ?? null;
    if (!runtime?.pendingTurnId) {
      return;
    }

    const cfg = settings?.autoReply ?? null;
    const message = cfg?.message?.trim() ?? "";
    if (!cfg?.enabled || !message) {
      setRuntimeById((prev) => {
        const current = prev[threadId];
        if (!current?.pendingTurnId) {
          return prev;
        }
        return { ...prev, [threadId]: { ...current, pendingTurnId: null } };
      });
      return;
    }

    const remainingStart = runtime.remaining ?? (cfg.mode === "times" ? Math.max(0, cfg.times) : null);
    if (cfg.mode === "times") {
      const rem = typeof remainingStart === "number" ? remainingStart : Math.max(0, cfg.times);
      if (rem <= 0) {
        setRuntimeById((prev) => {
          const current = prev[threadId];
          if (!current?.pendingTurnId) {
            return prev;
          }
          return { ...prev, [threadId]: { ...current, pendingTurnId: null, remaining: 0 } };
        });
        return;
      }

      setRuntimeById((prev) => ({
        ...prev,
        [threadId]: { remaining: rem - 1, pendingTurnId: null }
      }));
    } else {
      setRuntimeById((prev) => ({
        ...prev,
        [threadId]: { remaining: null, pendingTurnId: null }
      }));
    }

    void sendToThread(viewScope, threadId, message);
  }, [
    viewScope,
    viewActiveThreadId,
    autoReplyRuntimeByThreadId,
    remoteAutoReplyRuntimeByThreadId,
    settings?.autoReply.enabled,
    settings?.autoReply.message,
    settings?.autoReply.mode,
    settings?.autoReply.times
  ]);

  useEffect(() => {
    if (sidebarPanel !== "explorer" || !viewActiveThreadId) {
      return;
    }

    const root = viewThreadsById[viewActiveThreadId]?.meta.cwd?.trim() ?? "";
    if (!root) {
      return;
    }

    const explorer = viewThreadsById[viewActiveThreadId]?.explorer ?? null;
    if (!explorer) {
      return;
    }

    if (explorer.entriesByDir[root] || explorer.loadingDirs[root]) {
      return;
    }

    updateThread(viewScope, viewActiveThreadId, (prev) => ({
      ...prev,
      explorer: {
        ...prev.explorer,
        expandedDirs: { ...prev.explorer.expandedDirs, [root]: true }
      }
    }));
    void explorerLoadDir(viewScope, viewActiveThreadId, root);
  }, [sidebarPanel, viewScope, viewActiveThreadId, viewThreadsById]);

  const explorerWatchKeyRef = useRef<string>("");
  useEffect(() => {
    if (sidebarPanel !== "explorer" || !viewActiveThreadId) {
      explorerWatchKeyRef.current = "";
      setExplorerWatchEnabled(false);
      void window.tazhan.workspaceWatchSet({ root: "", dirs: [] });
      return;
    }

    if (viewScope === "remote") {
      explorerWatchKeyRef.current = "";
      setExplorerWatchEnabled(false);
      void window.tazhan.workspaceWatchSet({ root: "", dirs: [] });
      return;
    }

    const thread = threadsById[viewActiveThreadId] ?? null;
    const root = thread?.meta.cwd?.trim() ?? "";
    if (!thread || !root) {
      explorerWatchKeyRef.current = "";
      setExplorerWatchEnabled(false);
      void window.tazhan.workspaceWatchSet({ root: "", dirs: [] });
      return;
    }

    const expanded = thread.explorer.expandedDirs ?? {};
    const openDirs = Object.entries(expanded)
      .filter(([, open]) => Boolean(open))
      .map(([dir]) => dir)
      .filter(Boolean);
    const dirs = Array.from(new Set<string>([root, ...openDirs]));
    dirs.sort((a, b) => a.localeCompare(b));
    const key = `${root}\n${dirs.join("\n")}`;
    if (explorerWatchKeyRef.current === key) {
      return;
    }
    explorerWatchKeyRef.current = key;

    void window.tazhan.workspaceWatchSet({ root, dirs }).then((res) => setExplorerWatchEnabled(Boolean(res?.ok)));
  }, [sidebarPanel, viewScope, viewActiveThreadId, threadsById]);

  useEffect(() => {
    function normFsPath(value: string): string {
      const s = String(value ?? "").trim();
      if (!s) {
        return "";
      }
      const slash = s.replace(/\\/g, "/");
      return /^[a-zA-Z]:\//.test(slash) ? slash.toLowerCase() : slash;
    }

    const off = window.tazhan.onWorkspaceEvent((ev) => {
      if (viewScopeRef.current !== "local") {
        return;
      }
      const threadId = activeThreadIdRef.current;
      if (!threadId) {
        return;
      }
      if (sidebarPanelRef.current !== "explorer") {
        return;
      }

      const thread = threadsByIdRef.current[threadId] ?? null;
      if (!thread) {
        return;
      }
      const root = thread.meta.cwd.trim();
      if (!root) {
        return;
      }

      if (normFsPath(ev.root) !== normFsPath(root)) {
        return;
      }

      const dir = String(ev.dir ?? "").trim();
      if (!dir) {
        return;
      }

      const isRoot = normFsPath(dir) === normFsPath(root);
      const expanded = Boolean(thread.explorer.expandedDirs?.[dir]);
      const loaded = Boolean(thread.explorer.entriesByDir?.[dir]);
      if (!isRoot && !expanded && !loaded) {
        return;
      }

      void explorerLoadDir("local", threadId, dir);
    });

    return () => off();
  }, []);

  const explorerAutoRefreshIndexRef = useRef<number>(0);
  useEffect(() => {
    if (explorerWatchEnabled) {
      return;
    }
    if (sidebarPanel !== "explorer" || !viewActiveThreadId) {
      return;
    }

    const scope = viewScope;
    const threadId = viewActiveThreadId;
    let disposed = false;

    async function refreshDir(root: string, dir: string): Promise<void> {
      if (disposed) {
        return;
      }
      const thread =
        scope === "remote" ? remoteThreadsByIdRef.current[threadId] ?? null : threadsByIdRef.current[threadId] ?? null;
      const loading = Boolean(thread?.explorer.loadingDirs?.[dir]);
      if (loading) {
        return;
      }

      updateThread(scope, threadId, (prev) => ({
        ...prev,
        explorer: {
          ...prev.explorer,
          loadingDirs: { ...prev.explorer.loadingDirs, [dir]: true }
        }
      }));

      try {
        const res = await window.tazhan.workspaceListDir({ root, dir, scope });
        if (!res.ok) {
          updateThread(scope, threadId, (prev) => ({
            ...prev,
            explorer: {
              ...prev.explorer,
              loadingDirs: { ...prev.explorer.loadingDirs, [dir]: false }
            }
          }));
          return;
        }

        updateThread(scope, threadId, (prev) => ({
          ...prev,
          explorer: {
            ...prev.explorer,
            entriesByDir: { ...prev.explorer.entriesByDir, [dir]: res.entries as unknown as ExplorerEntry[] },
            loadingDirs: { ...prev.explorer.loadingDirs, [dir]: false }
          }
        }));
      } catch {
        updateThread(scope, threadId, (prev) => ({
          ...prev,
          explorer: {
            ...prev.explorer,
            loadingDirs: { ...prev.explorer.loadingDirs, [dir]: false }
          }
        }));
      }
    }

    async function tick(): Promise<void> {
      if (disposed) {
        return;
      }
      if (document.visibilityState !== "visible") {
        return;
      }

      const thread =
        scope === "remote" ? remoteThreadsByIdRef.current[threadId] ?? null : threadsByIdRef.current[threadId] ?? null;
      const root = thread?.meta.cwd?.trim() ?? "";
      if (!thread || !root) {
        return;
      }

      const expanded = thread.explorer.expandedDirs ?? {};
      const openDirs = Object.entries(expanded)
        .filter(([, open]) => Boolean(open))
        .map(([dir]) => dir)
        .filter(Boolean);

      await refreshDir(root, root);

      const others = openDirs.filter((d) => d !== root);
      if (others.length === 0) {
        return;
      }

      const idx = explorerAutoRefreshIndexRef.current % others.length;
      explorerAutoRefreshIndexRef.current = idx + 1;
      await refreshDir(root, others[idx]!);
    }

    const intervalId = window.setInterval(() => void tick(), 2000);
    const onFocus = () => void tick();
    const onVisibility = () => void tick();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    void tick();

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sidebarPanel, viewScope, viewActiveThreadId, explorerWatchEnabled]);

  useEffect(() => {
    function onMouseDown(ev: MouseEvent): void {
      const target = ev.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (
        workspaceMenuOpen &&
        !workspaceMenuRef.current?.contains(target) &&
        !workspaceBtnRef.current?.contains(target)
      ) {
        setWorkspaceMenuOpen(false);
      }

      if (
        moreMenuOpen &&
        !moreMenuRef.current?.contains(target) &&
        !moreBtnRef.current?.contains(target)
      ) {
        setMoreMenuOpen(false);
      }

      if (threadMenuOpenId) {
        if (!(target instanceof Element)) {
          setThreadMenuOpenId(null);
          return;
        }
        const inMenu = target.closest(".threadMenu");
        const inBtn = target.closest(".threadMenuBtn");
        if (!inMenu && !inBtn) {
          setThreadMenuOpenId(null);
        }
      }

      if (composerMenuOpen) {
        if (!(target instanceof Element)) {
          setComposerMenuOpen(null);
          return;
        }
        const inMenu = target.closest(".composerMenuWrap");
        if (!inMenu) {
          setComposerMenuOpen(null);
        }
      }

      if (newChatMenuOpen) {
        if (!(target instanceof Element)) {
          setNewChatMenuOpen(null);
          return;
        }
        const inMenu = target.closest(".newChatMenuWrap");
        if (!inMenu) {
          setNewChatMenuOpen(null);
        }
      }

      if (explorerMenu) {
        if (!(target instanceof Element)) {
          setExplorerMenu(null);
          return;
        }
        const inMenu = target.closest(".explorerCtxMenu");
        if (!inMenu) {
          setExplorerMenu(null);
        }
      }
    }

    function onKeyDown(ev: KeyboardEvent): void {
      if (ev.key !== "Escape") {
        return;
      }
      setWorkspaceMenuOpen(false);
      setMoreMenuOpen(false);
      setThreadMenuOpenId(null);
      setComposerMenuOpen(null);
      setNewChatMenuOpen(null);
      setExplorerMenu(null);
      closeRenameThread();
    }

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [workspaceMenuOpen, moreMenuOpen, threadMenuOpenId, composerMenuOpen, newChatMenuOpen, explorerMenu]);

  useEffect(() => {
    const el = chatBodyRef.current;
    if (!el) {
      return;
    }
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < 80) {
      chatEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [viewScope, viewActiveThreadId, activeThread?.messages]);

  function appendLog(line: string): void {
    setEventLog((prev) => {
      const next = prev.length > 799 ? prev.slice(prev.length - 799) : prev;
      return [...next, line];
    });
  }

  function ensureThreadInOrder(threadId: string, toFront: boolean): void;
  function ensureThreadInOrder(scope: "local" | "remote", threadId: string, toFront: boolean): void;
  function ensureThreadInOrder(a: "local" | "remote" | string, b: string | boolean, c?: boolean): void {
    const scope = a === "remote" || a === "local" ? a : "local";
    const threadId = scope === a ? (b as string) : (a as string);
    const toFront = scope === a ? Boolean(c) : Boolean(b);
    const setOrder = scope === "remote" ? setRemoteThreadOrder : setThreadOrder;
    setOrder((prev) => {
      const idx = prev.indexOf(threadId);
      if (idx === 0 && toFront) {
        return prev;
      }
      if (idx >= 0) {
        if (!toFront) {
          return prev;
        }
        const copy = prev.slice();
        copy.splice(idx, 1);
        copy.unshift(threadId);
        return copy;
      }
      return toFront ? [threadId, ...prev] : [...prev, threadId];
    });
  }

  function updateThread(threadId: string, fn: (prev: ThreadState) => ThreadState): void;
  function updateThread(scope: "local" | "remote", threadId: string, fn: (prev: ThreadState) => ThreadState): void;
  function updateThread(
    a: "local" | "remote" | string,
    b: string | ((prev: ThreadState) => ThreadState),
    c?: (prev: ThreadState) => ThreadState
  ): void {
    const scope = a === "remote" || a === "local" ? a : "local";
    const threadId = scope === a ? (b as string) : (a as string);
    const fn = scope === a ? (c as (prev: ThreadState) => ThreadState) : (b as (prev: ThreadState) => ThreadState);
    const setById = scope === "remote" ? setRemoteThreadsById : setThreadsById;
    setById((prev) => {
      const existing = prev[threadId] ?? makeThreadState(threadId);
      const next = fn(existing);
      return { ...prev, [threadId]: next };
    });
  }

  function upsertThreadFromServer(thread: any, toFront: boolean): void;
  function upsertThreadFromServer(scope: "local" | "remote", thread: any, toFront: boolean): void;
  function upsertThreadFromServer(a: "local" | "remote" | any, b: any, c?: boolean): void {
    const scope = a === "remote" || a === "local" ? a : "local";
    const thread = scope === a ? b : a;
    const toFront = scope === a ? Boolean(c) : Boolean(b);
    const meta = threadMetaFromServer(thread);
    if (!meta.id) {
      return;
    }
    ensureThreadInOrder(scope, meta.id, toFront);
    updateThread(scope, meta.id, (prev) => ({
      ...prev,
      meta: { ...prev.meta, ...meta },
      lastTurnCompletedAtMs:
        prev.lastTurnCompletedAtMs ?? (!prev.running && meta.updatedAt > 0 ? meta.updatedAt * 1000 : null)
    }));
  }

  function upsertCommand(scope: "local" | "remote", threadId: string, item: any, when: "started" | "completed"): void {
    const itemId = String(item?.id ?? "");
    if (!itemId) {
      return;
    }

    const next: Partial<CommandRun> = {
      itemId,
      command: typeof item?.command === "string" ? item.command : "",
      cwd: typeof item?.cwd === "string" ? item.cwd : "",
      status: typeof item?.status === "string" ? item.status : when === "started" ? "inProgress" : "",
      exitCode: typeof item?.exitCode === "number" ? item.exitCode : null,
      durationMs: typeof item?.durationMs === "number" ? item.durationMs : null
    };

    updateThread(scope, threadId, (prev) => {
      const commands = prev.commands.slice();
      const idx = commands.findIndex((c) => c.itemId === itemId);
      if (idx < 0) {
        commands.push({
          itemId,
          command: next.command ?? "",
          cwd: next.cwd ?? "",
          status: next.status ?? "",
          output: typeof item?.aggregatedOutput === "string" ? item.aggregatedOutput : "",
          exitCode: next.exitCode ?? null,
          durationMs: next.durationMs ?? null
        });
        return { ...prev, commands };
      }

      const existing = commands[idx];
      const aggregated = typeof item?.aggregatedOutput === "string" ? item.aggregatedOutput : null;
      const output =
        aggregated && aggregated.length >= existing.output.length ? aggregated : existing.output;

      commands[idx] = {
        ...existing,
        ...next,
        output
      };
      return { ...prev, commands };
    });
  }

  function appendCommandOutput(scope: "local" | "remote", threadId: string, itemId: string, delta: string): void {
    if (!itemId || !delta) {
      return;
    }

    updateThread(scope, threadId, (prev) => {
      const commands = prev.commands.slice();
      const idx = commands.findIndex((c) => c.itemId === itemId);
      if (idx < 0) {
        commands.push({
          itemId,
          command: "",
          cwd: "",
          status: "inProgress",
          output: delta,
          exitCode: null,
          durationMs: null
        });
        return { ...prev, commands };
      }

      commands[idx] = { ...commands[idx], output: commands[idx].output + delta };
      return { ...prev, commands };
    });
  }

  function upsertFileChange(scope: "local" | "remote", threadId: string, item: any): void {
    const itemId = String(item?.id ?? "");
    if (!itemId) {
      return;
    }

    const changes = (Array.isArray(item?.changes) ? item.changes : []) as FileUpdateChange[];
    const status = typeof item?.status === "string" ? item.status : "";

    updateThread(scope, threadId, (prev) => {
      const fileChanges = prev.fileChanges.slice();
      const idx = fileChanges.findIndex((c) => c.itemId === itemId);
      if (idx < 0) {
        fileChanges.push({ itemId, status, changes });
        return { ...prev, fileChanges };
      }
      fileChanges[idx] = { ...fileChanges[idx], status, changes };
      return { ...prev, fileChanges };
    });
  }

  function upsertTurnItem(scope: "local" | "remote", threadId: string, item: any): void {
    const itemId = typeof item?.id === "string" ? item.id : "";
    const ty = typeof item?.type === "string" ? item.type : "";
    if (!itemId || !ty) {
      return;
    }

    updateThread(scope, threadId, (prev) => {
      const existing = prev.turnItemsById[itemId];
      const turnItemsById = { ...prev.turnItemsById, [itemId]: existing ? { ...existing, ...item } : item };
      const turnItemOrder = prev.turnItemOrder.includes(itemId) ? prev.turnItemOrder : [...prev.turnItemOrder, itemId];
      return { ...prev, turnItemsById, turnItemOrder };
    });
  }

  function updateTurnItem(
    scope: "local" | "remote",
    threadId: string,
    itemId: string,
    fn: (item: any) => any
  ): void {
    if (!threadId || !itemId) {
      return;
    }

    updateThread(scope, threadId, (prev) => {
      const existing = prev.turnItemsById[itemId] ?? null;
      if (!existing) {
        return prev;
      }
      const turnItemsById = { ...prev.turnItemsById, [itemId]: fn(existing) };
      return { ...prev, turnItemsById };
    });
  }

  function toggleTurnActivityCollapsed(scope: "local" | "remote", threadId: string, turnId: string): void {
    if (!threadId || !turnId) {
      return;
    }

    updateThread(scope, threadId, (prev) => {
      const current = prev.turnActivityCollapsedByTurnId[turnId];
      const next = typeof current === "boolean" ? !current : false;
      return {
        ...prev,
        turnActivityCollapsedByTurnId: { ...prev.turnActivityCollapsedByTurnId, [turnId]: next }
      };
    });
  }

  function handleEvent(scope: "local" | "remote", ev: CodexEvent): void {
    if (ev.type === "status") {
      if (scope === "remote") {
        setRemoteCodexStatus(ev.status);
        void window.tazhan
          .remoteWorkspaceStatus()
          .then((st) => setRemoteStatus(st))
          .catch(() => {
          });

        if (ev.status === "connected") {
          void refreshModels("remote");
          void refreshThreads("remote");
        } else if (ev.status === "disconnected" || ev.status === "exited") {
          setRemoteActiveThreadId(null);
          setRemoteThreadsById({});
          setRemoteThreadOrder([]);
          setRemoteModels([]);
          setRemoteThreadListCursor(null);
        }
      } else {
        setStatus(ev.status);
      }
      appendLog(`[${scope}] [status] ${ev.status}${ev.details ? `: ${ev.details}` : ""}`);
      return;
    }

    if (ev.type === "stderr") {
      appendLog(`[${scope}] [stderr] ${ev.line}`);
      return;
    }

    if (ev.type === "request") {
      appendLog(`[${scope}] [request] ${ev.method} id=${String(ev.id)}`);
      const params = ev.params as any;
      const threadId = typeof params?.threadId === "string" ? params.threadId : null;
      if (String(ev.method).endsWith("/requestApproval")) {
        setPendingApproval({ id: ev.id, method: ev.method, params: ev.params, threadId, scope });
      }
      return;
    }

    if (ev.type !== "notification") {
      return;
    }

    appendLog(`[${scope}] [notify] ${ev.method} ${ev.params ? stringifyShort(ev.params) : ""}`.trim());

    const params = ev.params as any;

    switch (ev.method) {
      case "thread/started": {
        upsertThreadFromServer(scope, params?.thread, true);
        break;
      }
      case "error": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const turnId = typeof params?.turnId === "string" ? (params.turnId as string) : "";
        const willRetry = typeof params?.willRetry === "boolean" ? (params.willRetry as boolean) : null;
        const err = params?.error;
        const message = typeof err?.message === "string" ? (err.message as string) : "";
        const codexErrorInfo = typeof err?.codexErrorInfo === "string" ? (err.codexErrorInfo as string) : null;

        if (threadId) {
          const atMs = Date.now();
          updateThread(scope, threadId, (prev) => {
            const finalMessage = message.trim().length > 0 ? message.trim() : "发生未知错误";
            const retryHint = willRetry === true ? "，正在重试" : "";
            const text = `（发生错误${retryHint}：${finalMessage}）`;

            const startedAtMs = prev.activeTurnStartedAtMs ?? atMs;
            const durationMs = Math.max(0, atMs - startedAtMs);
            const stop = willRetry !== true;

            const messages = prev.messages.map((m) => {
              if (m.role !== "assistant") {
                return m;
              }
              if (!m.placeholder) {
                return m;
              }
              if (turnId && m.turnId && m.turnId !== turnId) {
                return m;
              }
              return {
                ...m,
                text,
                turnId: m.turnId || turnId,
                durationMs: stop ? durationMs : m.durationMs,
                placeholder: stop ? false : m.placeholder
              };
            });

            return {
              ...prev,
              running: stop ? false : prev.running,
              activeTurnStartedAtMs: stop ? null : prev.activeTurnStartedAtMs,
              lastTurnCompletedAtMs: stop ? atMs : prev.lastTurnCompletedAtMs,
              lastTurnDurationMs: stop ? durationMs : prev.lastTurnDurationMs,
              turnError: { threadId, turnId: turnId || prev.turnId || null, message: finalMessage, codexErrorInfo, willRetry, atMs },
              messages
            };
          });
        }
        break;
      }
      case "turn/started": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const turnId = typeof params?.turn?.id === "string" ? (params.turn.id as string) : "";
        if (threadId) {
          const nowMs = Date.now();
          ensureThreadInOrder(scope, threadId, true);
          updateThread(scope, threadId, (prev) => {
            const startedAtMs = prev.activeTurnStartedAtMs ?? nowMs;

            let hasPlaceholder = false;
            const messages = prev.messages.map((m) => {
              if (!m.placeholder) {
                return m;
              }
              hasPlaceholder = true;
              return m.turnId ? m : { ...m, turnId };
            });

            if (!hasPlaceholder) {
              messages.push({
                id: `turn_${turnId}_placeholder`,
                role: "assistant",
                text: "",
                turnId,
                durationMs: null,
                placeholder: true
              });
            }

            return {
              ...prev,
              turnId,
              running: true,
              activeTurnStartedAtMs: startedAtMs,
              turnPlan: null,
              turnError: null,
              turnItemsById: {},
              turnItemOrder: [],
              turnActivityCollapsedByTurnId: { ...prev.turnActivityCollapsedByTurnId, [turnId]: false },
              commands: [],
              fileChanges: [],
              expandedFiles: {},
              turnDiff: "",
              messages
            };
          });
        }
        break;
      }
      case "turn/plan/updated": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const turnId = typeof params?.turnId === "string" ? (params.turnId as string) : "";
        const explanation = typeof params?.explanation === "string" ? (params.explanation as string) : null;
        const rawPlan = Array.isArray(params?.plan) ? (params.plan as any[]) : [];
        const plan: TurnPlanStep[] = rawPlan
          .map((p) => ({
            step: typeof p?.step === "string" ? (p.step as string) : "",
            status: (p?.status as any) as TurnPlanStep["status"]
          }))
          .filter((p) => p.step.trim().length > 0 && (p.status === "pending" || p.status === "inProgress" || p.status === "completed"));

        if (threadId && turnId) {
          updateThread(scope, threadId, (prev) => ({ ...prev, turnPlan: { turnId, explanation, plan } }));
        }
        break;
      }
      case "turn/completed": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const turnId = typeof params?.turn?.id === "string" ? (params.turn.id as string) : "";
        const turnStatus = typeof params?.turn?.status === "string" ? (params.turn.status as string) : "";
        const turnErrorMsg = typeof params?.turn?.error?.message === "string" ? (params.turn.error.message as string) : "";
        const turnCodexErrorInfo =
          typeof params?.turn?.error?.codexErrorInfo === "string" ? (params.turn.error.codexErrorInfo as string) : null;
        if (threadId) {
          const completedAtMs = Date.now();
          updateThread(scope, threadId, (prev) => {
            const startedAtMs = prev.activeTurnStartedAtMs ?? completedAtMs;
            const durationMs = Math.max(0, completedAtMs - startedAtMs);
            const hasAssistantReply =
              turnId.length > 0
                ? prev.messages.some((m) => m.role === "assistant" && !m.placeholder && m.turnId === turnId)
                : false;
            const messages =
              turnId.length > 0
                ? prev.messages.map((m) => {
                    if (m.role !== "assistant") {
                      return m;
                    }

                    if (m.placeholder && (!m.turnId || m.turnId === turnId)) {
                      const finalText = (() => {
                        if (hasAssistantReply) {
                          return m.text;
                        }
                        const existing = m.text.trim();
                        if (existing.length > 0) {
                          return existing;
                        }
                        if (turnStatus === "failed" && turnErrorMsg.trim().length > 0) {
                          const err = turnErrorMsg.trim();
                          if (err.toLowerCase().includes("writing outside of the project")) {
                            return `（执行失败：${err}）\n提示：目标路径在当前工作区之外。请把工作区切换到目标目录，或改成写入工作区内的相对路径。`;
                          }
                          return `（执行失败：${err}）`;
                        }
                        if (turnStatus === "interrupted") {
                          return "（已中断）";
                        }
                        return "（未生成最终回复）";
                      })();
                      return {
                        ...m,
                        placeholder: false,
                        turnId: m.turnId || turnId,
                        durationMs,
                        text: finalText
                      };
                    }

                    if (m.turnId === turnId) {
                      return { ...m, durationMs };
                    }

                    return m;
                  })
                : prev.messages;

            const finalTurnError =
              turnStatus === "failed" && turnErrorMsg.trim().length > 0
                ? {
                    threadId,
                    turnId: turnId || null,
                    message: turnErrorMsg.trim(),
                    codexErrorInfo: turnCodexErrorInfo,
                    willRetry: false,
                    atMs: completedAtMs
                  }
                : prev.turnError;

            let turnActivityByTurnId = prev.turnActivityByTurnId;
            let turnActivityOrder = prev.turnActivityOrder;
            let turnActivityCollapsedByTurnId = prev.turnActivityCollapsedByTurnId;

            if (turnId.trim()) {
              const snapshot: TurnActivitySnapshot = {
                durationMs,
                turnPlan: prev.turnPlan,
                turnError: finalTurnError,
                turnItemsById: prev.turnItemsById,
                turnItemOrder: prev.turnItemOrder
              };
              turnActivityByTurnId = { ...turnActivityByTurnId, [turnId]: snapshot };
              turnActivityOrder = turnActivityOrder.includes(turnId) ? turnActivityOrder : [...turnActivityOrder, turnId];
              const shouldCollapse = turnStatus !== "failed";
              turnActivityCollapsedByTurnId = { ...turnActivityCollapsedByTurnId, [turnId]: shouldCollapse };

              const limit = 80;
              if (turnActivityOrder.length > limit) {
                const drop = turnActivityOrder.slice(0, turnActivityOrder.length - limit);
                const keep = turnActivityOrder.slice(turnActivityOrder.length - limit);
                const nextById = { ...turnActivityByTurnId };
                const nextCollapsed = { ...turnActivityCollapsedByTurnId };
                for (const oldId of drop) {
                  delete nextById[oldId];
                  delete nextCollapsed[oldId];
                }
                turnActivityByTurnId = nextById;
                turnActivityCollapsedByTurnId = nextCollapsed;
                turnActivityOrder = keep;
              }
            }

            return {
              ...prev,
              turnId,
              running: false,
              activeTurnStartedAtMs: null,
              turnError: finalTurnError,
              lastTurnCompletedAtMs: completedAtMs,
              lastTurnDurationMs: durationMs,
              turnActivityByTurnId,
              turnActivityOrder,
              turnActivityCollapsedByTurnId,
              messages
            };
          });

          const s = settingsRef.current;
          const cfg = s?.autoReply ?? null;
          const activeId = activeThreadIdRef.current;
          const message = cfg?.message?.trim() ?? "";
          if (cfg?.enabled && viewScopeRef.current === scope && activeId === threadId && turnId && message) {
            const setRuntime = scope === "remote" ? setRemoteAutoReplyRuntimeByThreadId : setAutoReplyRuntimeByThreadId;
            setRuntime((prev) => {
              const existing = prev[threadId];
              if (existing?.pendingTurnId) {
                return prev;
              }

              const remaining =
                existing?.remaining ?? (cfg.mode === "times" ? Math.max(0, cfg.times) : null);
              if (cfg.mode === "times" && (remaining ?? 0) <= 0) {
                return prev;
              }

              return { ...prev, [threadId]: { remaining, pendingTurnId: turnId } };
            });
          }
        }
        break;
      }
      case "item/started": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const item = params?.item;
        const ty = item?.type;
        if (threadId && ty === "commandExecution") {
          upsertCommand(scope, threadId, item, "started");
        }
        if (threadId && ty === "fileChange") {
          upsertFileChange(scope, threadId, item);
        }
        if (threadId && item) {
          upsertTurnItem(scope, threadId, item);
        }
        break;
      }
      case "item/completed": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const turnId = typeof params?.turnId === "string" ? (params.turnId as string) : "";
        const item = params?.item;
        const ty = item?.type;
        if (threadId && ty === "commandExecution") {
          upsertCommand(scope, threadId, item, "completed");
        }
        if (threadId && ty === "fileChange") {
          upsertFileChange(scope, threadId, item);
        }
        if (threadId && item) {
          upsertTurnItem(scope, threadId, item);
        }
        if (threadId && ty === "agentMessage") {
          const itemId = typeof item?.id === "string" ? item.id : "";
          const text = typeof item?.text === "string" ? item.text : "";
          if (itemId && text) {
            updateThread(scope, threadId, (prev) => {
              const durationMs =
                turnId && turnId === prev.turnId && !prev.running && typeof prev.lastTurnDurationMs === "number"
                  ? prev.lastTurnDurationMs
                  : null;
              const messages = prev.messages.filter((m) => !m.placeholder);
              const idx = messages.findIndex((m) => m.id === itemId);
              if (idx >= 0) {
                messages[idx] = {
                  ...messages[idx],
                  role: "assistant",
                  text,
                  turnId: messages[idx].turnId || turnId,
                  durationMs: messages[idx].durationMs ?? durationMs,
                  placeholder: false
                };
              } else {
                messages.push({ id: itemId, role: "assistant", text, turnId, durationMs, placeholder: false });
              }
              return { ...prev, messages };
            });
          }
        }
        break;
      }
      case "item/plan/delta": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const itemId = typeof params?.itemId === "string" ? (params.itemId as string) : "";
        const delta = typeof params?.delta === "string" ? (params.delta as string) : "";
        if (!threadId || !itemId || !delta) {
          break;
        }
        updateThread(scope, threadId, (prev) => {
          const existing = prev.turnItemsById[itemId] ?? { type: "plan", id: itemId, text: "" };
          const text = typeof existing?.text === "string" ? existing.text : "";
          const turnItemsById = { ...prev.turnItemsById, [itemId]: { ...existing, type: "plan", id: itemId, text: text + delta } };
          const turnItemOrder = prev.turnItemOrder.includes(itemId) ? prev.turnItemOrder : [...prev.turnItemOrder, itemId];
          return { ...prev, turnItemsById, turnItemOrder };
        });
        break;
      }
      case "item/agentMessage/delta": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const turnId = typeof params?.turnId === "string" ? (params.turnId as string) : "";
        const itemId = typeof params?.itemId === "string" ? (params.itemId as string) : "";
        const delta = typeof params?.delta === "string" ? (params.delta as string) : "";
        if (!threadId || !itemId || !delta) {
          break;
        }
        updateThread(scope, threadId, (prev) => {
          const messages = prev.messages.filter((m) => !m.placeholder);
          const idx = messages.findIndex((m) => m.id === itemId);
          if (idx >= 0) {
            messages[idx] = {
              ...messages[idx],
              role: "assistant",
              placeholder: false,
              text: messages[idx].text + delta,
              turnId: messages[idx].turnId || turnId
            };
          } else {
            messages.push({ id: itemId, role: "assistant", text: delta, turnId, durationMs: null, placeholder: false });
          }
          return { ...prev, messages };
        });
        break;
      }
      case "item/reasoning/summaryPartAdded": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const itemId = typeof params?.itemId === "string" ? (params.itemId as string) : "";
        const summaryIndex = typeof params?.summaryIndex === "number" ? (params.summaryIndex as number) : -1;
        if (!threadId || !itemId || summaryIndex < 0) {
          break;
        }
        updateThread(scope, threadId, (prev) => {
          const existing = prev.turnItemsById[itemId] ?? { type: "reasoning", id: itemId, summary: [], content: [] };
          const summary = Array.isArray(existing?.summary) ? (existing.summary as any[]).slice() : [];
          while (summary.length <= summaryIndex) {
            summary.push("");
          }
          const turnItemsById = {
            ...prev.turnItemsById,
            [itemId]: { ...existing, type: "reasoning", id: itemId, summary }
          };
          const turnItemOrder = prev.turnItemOrder.includes(itemId) ? prev.turnItemOrder : [...prev.turnItemOrder, itemId];
          return { ...prev, turnItemsById, turnItemOrder };
        });
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const itemId = typeof params?.itemId === "string" ? (params.itemId as string) : "";
        const summaryIndex = typeof params?.summaryIndex === "number" ? (params.summaryIndex as number) : -1;
        const delta = typeof params?.delta === "string" ? (params.delta as string) : "";
        if (!threadId || !itemId || summaryIndex < 0 || !delta) {
          break;
        }
        updateThread(scope, threadId, (prev) => {
          const existing = prev.turnItemsById[itemId] ?? { type: "reasoning", id: itemId, summary: [], content: [] };
          const summary = Array.isArray(existing?.summary) ? (existing.summary as any[]).slice() : [];
          while (summary.length <= summaryIndex) {
            summary.push("");
          }
          summary[summaryIndex] = String(summary[summaryIndex] ?? "") + delta;
          const turnItemsById = {
            ...prev.turnItemsById,
            [itemId]: { ...existing, type: "reasoning", id: itemId, summary }
          };
          const turnItemOrder = prev.turnItemOrder.includes(itemId) ? prev.turnItemOrder : [...prev.turnItemOrder, itemId];
          return { ...prev, turnItemsById, turnItemOrder };
        });
        break;
      }
      case "item/reasoning/textDelta": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const itemId = typeof params?.itemId === "string" ? (params.itemId as string) : "";
        const contentIndex = typeof params?.contentIndex === "number" ? (params.contentIndex as number) : -1;
        const delta = typeof params?.delta === "string" ? (params.delta as string) : "";
        if (!threadId || !itemId || contentIndex < 0 || !delta) {
          break;
        }
        updateThread(scope, threadId, (prev) => {
          const existing = prev.turnItemsById[itemId] ?? { type: "reasoning", id: itemId, summary: [], content: [] };
          const content = Array.isArray(existing?.content) ? (existing.content as any[]).slice() : [];
          while (content.length <= contentIndex) {
            content.push("");
          }
          content[contentIndex] = String(content[contentIndex] ?? "") + delta;
          const turnItemsById = {
            ...prev.turnItemsById,
            [itemId]: { ...existing, type: "reasoning", id: itemId, content }
          };
          const turnItemOrder = prev.turnItemOrder.includes(itemId) ? prev.turnItemOrder : [...prev.turnItemOrder, itemId];
          return { ...prev, turnItemsById, turnItemOrder };
        });
        break;
      }
      case "item/commandExecution/outputDelta": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const itemId = typeof params?.itemId === "string" ? (params.itemId as string) : "";
        const delta = typeof params?.delta === "string" ? (params.delta as string) : "";
        if (threadId && itemId && delta) {
          appendCommandOutput(scope, threadId, itemId, delta);
        }
        break;
      }
      case "item/fileChange/outputDelta": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const itemId = typeof params?.itemId === "string" ? (params.itemId as string) : "";
        const delta = typeof params?.delta === "string" ? (params.delta as string) : "";
        if (!threadId || !itemId || !delta) {
          break;
        }
        updateThread(scope, threadId, (prev) => {
          const existing = prev.turnItemsById[itemId] ?? null;
          if (!existing) {
            return prev;
          }
          const output = typeof existing?.output === "string" ? existing.output : "";
          const turnItemsById = { ...prev.turnItemsById, [itemId]: { ...existing, output: output + delta } };
          return { ...prev, turnItemsById };
        });
        break;
      }
      case "item/mcpToolCall/progress": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const itemId = typeof params?.itemId === "string" ? (params.itemId as string) : "";
        const message = typeof params?.message === "string" ? (params.message as string) : "";
        if (!threadId || !itemId || !message) {
          break;
        }
        updateThread(scope, threadId, (prev) => {
          const existing = prev.turnItemsById[itemId] ?? null;
          if (!existing) {
            return prev;
          }
          const prevMsgs = Array.isArray(existing?.progressMessages) ? (existing.progressMessages as any[]) : [];
          const nextMsgs = [...prevMsgs, message].slice(-20);
          const turnItemsById = { ...prev.turnItemsById, [itemId]: { ...existing, progressMessages: nextMsgs } };
          return { ...prev, turnItemsById };
        });
        break;
      }
      case "turn/diff/updated": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const diff = typeof params?.diff === "string" ? (params.diff as string) : "";
        if (threadId) {
          updateThread(scope, threadId, (prev) => ({ ...prev, turnDiff: diff }));
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        const threadId = typeof params?.threadId === "string" ? (params.threadId as string) : "";
        const usage = params?.tokenUsage;
        const totalTokens = typeof usage?.total?.totalTokens === "number" ? usage.total.totalTokens : null;
        const modelContextWindow =
          typeof usage?.modelContextWindow === "number" ? (usage.modelContextWindow as number) : null;

        if (threadId && totalTokens !== null) {
          updateThread(scope, threadId, (prev) => ({
            ...prev,
            tokenUsage: { totalTokens, modelContextWindow }
          }));
        }
        break;
      }
      default:
        break;
    }
  }

  async function saveSettingsPatch(patch: Partial<AppSettings>): Promise<void> {
    const next = await window.tazhan.setSettings(patch);
    settingsRef.current = next;
    setSettings(next);
  }

  async function connect(): Promise<void> {
    try {
      if (remoteStatus?.connected) {
        setActiveThreadId(null);
        setThreadMenuOpenId(null);
        setThreadsById({});
        setThreadOrder([]);
        setModels([]);
      }

      await window.tazhan.codexConnect();
      void refreshCodexCliInfo();
      void refreshModels();
      void refreshThreads();
    } catch (err) {
      appendLog(`[error] connect failed: ${String(err)}`);
    }
  }

  async function refreshCodexCliInfo(): Promise<void> {
    try {
      const info = await window.tazhan.codexCliInfo();
      setCodexCliInfo(info);
    } catch (err) {
      appendLog(`[warn] codex cli info failed: ${String(err)}`);
    }
  }

  async function syncCodexModelConfig(nextModel: string): Promise<void> {
    try {
      const res = await window.tazhan.codexUserConfigWrite({
        model: nextModel,
        modelProvider: null,
        baseUrl: "",
        apiKey: null,
        clearApiKey: false
      });
      if (!res.ok) {
        appendLog(`[warn] sync config.toml model failed: ${res.error ?? "unknown error"}`);
      }
    } catch (err) {
      appendLog(`[warn] sync config.toml model failed: ${String(err)}`);
    }
  }

  async function installCodexCli(): Promise<void> {
    setCodexCliBusy(true);
    try {
      const res = await window.tazhan.codexCliInstall();
      if (!res.ok) {
        appendLog(`[error] codex install failed: ${res.error ?? "unknown error"}`);
      }
    } catch (err) {
      appendLog(`[error] codex install failed: ${String(err)}`);
    } finally {
      setCodexCliBusy(false);
    }

    void refreshCodexCliInfo();
  }

  async function installRuntime(target: CodexRuntimeInstallTarget): Promise<void> {
    setRuntimeInstallBusy(target);
    try {
      const res = await window.tazhan.codexRuntimeInstall(target);
      if (!res.ok) {
        appendLog(`[error] ${res.label} install failed: ${res.error ?? "unknown error"}`);
      } else {
        appendLog(`[info] ${res.label}${res.version ? ` ${res.version}` : ""} installed`);
      }
    } catch (err) {
      appendLog(`[error] runtime install failed: ${String(err)}`);
    } finally {
      setRuntimeInstallBusy(null);
    }

    void refreshCodexCliInfo();
  }


  function openNewChatSetup(initialMessage: string): void {
    setWorkspaceMenuOpen(false);
    setMoreMenuOpen(false);
    setThreadMenuOpenId(null);
    setPrefsOpen(false);
    setComposerMenuOpen(null);
    setNewChatMenuOpen(null);
    setNewChatPrevThreadId(activeThreadId);
    setActiveThreadId(null);
    setNewChatDraftMessage(initialMessage);
    setNewChatResumeThreadId(null);
    const s = settings;
    if (s) {
      setNewChatCwd(s.defaultCwd);
      setNewChatModel(s.model);
      setNewChatReasoningEffort(s.reasoningEffort);
      setNewChatApprovalPolicy(s.approvalPolicy);
      setNewChatSandbox(s.sandbox);
      setNewChatNotify(s.notifyOnComplete);
    }
    setNewChatOpen(true);
  }

  function openPreferences(initialSection: PreferencesScrollSection = "engine"): void {
    setWorkspaceMenuOpen(false);
    setMoreMenuOpen(false);
    setThreadMenuOpenId(null);

    const s = settings;
    if (s) {
      setPrefsCodexPath(s.codexPath);
      setPrefsWebhookUrl(s.notifyWebhookUrl);
      setPrefsRelayEnabled(Boolean(s.relay?.enabled));
      setPrefsRelayBaseUrl(s.relay?.baseUrl ?? "");
      setPrefsTheme(s.theme ?? "light");
      setPrefsDefaultCwd(s.defaultCwd);
      setPrefsModel(s.model);
      setPrefsReasoningEffort(s.reasoningEffort);
      setPrefsApprovalPolicy(s.approvalPolicy);
      setPrefsSandbox(s.sandbox);
      setPrefsNotifyOnComplete(s.notifyOnComplete);
    }
    void refreshCodexCliInfo();
    void window.tazhan.codexUserConfigRead().then((res) => {
      setPrefsModel(res.model.trim() || (settingsRef.current?.model ?? "").trim());
    });
    showPreferencesSection(initialSection);
    setPrefsOpen(true);
  }

  function closePreferences(): void {
    setPrefsOpen(false);
  }

  function openRelayPairing(): void {
    setWorkspaceMenuOpen(false);
    setMoreMenuOpen(false);
    setThreadMenuOpenId(null);
    setPrefsOpen(false);
    setComposerMenuOpen(null);
    setNewChatMenuOpen(null);

    setPairError(null);
    setPairBusy(false);
    setPairQrDataUrl(null);

    setRelayE2eePeerLabel("");
    setRelayE2eePeerEd25519Pub("");
    setRelayE2eePeerBusy(false);
    setRelayE2eePeerError(null);

    setPairOpen(true);

    const s = settingsRef.current;
    const existingExpiresAt = s?.relay?.lastPairingExpiresAt ?? 0;
    const existingQrPayload = (s?.relay?.lastPairingQrPayload ?? "").trim();
    const now = Math.floor(Date.now() / 1000);

    const hasSecret = /[?&](pairingSecret|secret)=/i.test(existingQrPayload);
    if (existingQrPayload && existingExpiresAt > now && hasSecret) {
      void ensurePairQr(existingQrPayload);
      return;
    }

    void refreshRelayPairingCode();
  }

  function closeRelayPairing(): void {
    setPairOpen(false);
    setPairBusy(false);
    setPairError(null);
    setPairQrDataUrl(null);
    setRelayE2eePeerBusy(false);
    setRelayE2eePeerError(null);
  }

  async function ensurePairQr(payload: string): Promise<void> {
    const value = payload.trim();
    if (!value) {
      setPairQrDataUrl(null);
      return;
    }
    try {
      const { toDataURL } = await import("qrcode");
      const dataUrl = await toDataURL(value, {
        width: 232,
        margin: 1,
        color: { dark: "#0B1220", light: "#FFFFFF" }
      });
      setPairQrDataUrl(dataUrl);
    } catch {
      setPairQrDataUrl(null);
    }
  }

  async function refreshRelayPairingCode(): Promise<void> {
    setPairBusy(true);
    setPairError(null);
    try {
      const res = await window.tazhan.relayPairingRefresh();
      if (!res.ok || !res.pairing) {
        throw new Error(res.error ?? "生成配对码失败");
      }
      void ensurePairQr(res.pairing.qrPayload || `tazhan://pair?code=${res.pairing.pairingCode}`);
      const next = await window.tazhan.getSettings();
      setSettings(next);
    } catch (err) {
      setPairError(String(err));
    } finally {
      setPairBusy(false);
    }
  }

  function normalizeB64Key(value: string): string {
    return value.trim().replaceAll(/\s+/g, "");
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 1) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  }

  function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function base64urlFromBytes(bytes: Uint8Array): string {
    return bytesToBase64(bytes).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  }

  async function keyIdForEd25519PublicKey(ed25519PublicKeyDerB64: string): Promise<string> {
    const cryptoObj = (globalThis as any).crypto as { subtle?: { digest: (alg: string, data: Uint8Array) => Promise<ArrayBuffer> } } | undefined;
    if (!cryptoObj?.subtle) {
      throw new Error("crypto.subtle is not available; cannot compute keyId");
    }

    const der = base64ToBytes(ed25519PublicKeyDerB64);
    const hash = await cryptoObj.subtle.digest("SHA-256", der);
    const bytes = new Uint8Array(hash);
    return `k_${base64urlFromBytes(bytes).slice(0, 16)}`;
  }

  async function addRelayE2eeTrustedPeer(): Promise<void> {
    setRelayE2eePeerBusy(true);
    setRelayE2eePeerError(null);
    try {
      const pub = normalizeB64Key(relayE2eePeerEd25519Pub);
      if (!pub) {
        throw new Error("missing ed25519 public key (base64 spki-der)");
      }

      const keyId = await keyIdForEd25519PublicKey(pub);
      const label = relayE2eePeerLabel.trim() || "peer";
      const peer: RelayE2eeTrustedPeer = { keyId, label, ed25519PublicKey: pub, addedAt: Math.floor(Date.now() / 1000) };

      const cur = settingsRef.current;
      const existing = cur?.relay?.e2ee?.trustedPeers ?? [];
      if (existing.some((p) => p.keyId === keyId)) {
        throw new Error(`peer already exists: ${keyId}`);
      }

      await saveSettingsPatch({ relay: { e2ee: { trustedPeers: [...existing, peer] } as any } as any });
      setRelayE2eePeerLabel("");
      setRelayE2eePeerEd25519Pub("");
    } catch (err) {
      setRelayE2eePeerError(String(err));
    } finally {
      setRelayE2eePeerBusy(false);
    }
  }

  async function removeRelayE2eeTrustedPeer(keyId: string): Promise<void> {
    const kid = keyId.trim();
    if (!kid) {
      return;
    }

    setRelayE2eePeerBusy(true);
    setRelayE2eePeerError(null);
    try {
      const cur = settingsRef.current;
      const existing = cur?.relay?.e2ee?.trustedPeers ?? [];
      await saveSettingsPatch({ relay: { e2ee: { trustedPeers: existing.filter((p) => p.keyId !== kid) } as any } as any });
    } catch (err) {
      setRelayE2eePeerError(String(err));
    } finally {
      setRelayE2eePeerBusy(false);
    }
  }

  function closeSkills(): void {
    setSkillSelectedId(null);
    setSkillPanelCollapsed(false);
    setSkillBusyTurnId(null);
    setSkillBusyStartedAtMs(null);
    setSkillPopoverOpen(true);
    setInterviewSeed("");
    setInterviewError(null);
    setInterviewBusy(false);
    setInterviewQa([]);
    setInterviewQuestion("");
    setInterviewWhy("");
    setInterviewPrd("");
    setInterviewSavedPath(null);

    setWizardAnswers({});
    setWizardError(null);
    setWizardSavedPath(null);
  }

  function skillStepDefaultValue(step: SkillStepV1): string {
    if (step.type === "markdown") {
      return "";
    }
    if (typeof step.default === "string") {
      return step.default;
    }
    if (step.type === "select") {
      const first = step.options?.[0]?.value ?? "";
      if (step.required && first) {
        return first;
      }
    }
    return "";
  }

  function buildWizardDefaultAnswers(skill: SkillWizardManifestV1): Record<string, string> {
    const defaults: Record<string, string> = {};
    for (const step of skill.steps) {
      if (step.type === "markdown") {
        continue;
      }
      defaults[step.id] = skillStepDefaultValue(step);
    }

    const outputId = skill.result.outputPathAnswerId?.trim() ?? "";
    const outputDefault = skill.result.defaultOutputPath?.trim() ?? "";
    if (outputId && outputDefault && !defaults[outputId]?.trim()) {
      defaults[outputId] = outputDefault;
    }

    return defaults;
  }

  function selectSkill(skill: SkillManifestV1): void {
    setInterviewError(null);
    setInterviewBusy(false);
    setInterviewSavedPath(null);
    setWizardError(null);
    setWizardSavedPath(null);

    setSkillSelectedId(skill.id);
    setSkillPanelCollapsed(false);
    setSkillPopoverOpen(true);

    if (skill.kind === "interview") {
      setInterviewSeed("");
      setInterviewQa([]);
      setInterviewQuestion("");
      setInterviewWhy("");
      setInterviewAskMode("followUp");
      setInterviewPrd("");
      setInterviewSavedPath(null);

      setInterviewOutputPath(skill.defaultOutputPath);
      setInterviewMaxQuestions(skill.maxQuestions);
    }

    if (skill.kind === "wizard") {
      setWizardAnswers(buildWizardDefaultAnswers(skill));
    }
  }

  function activeInterviewSkill(): SkillInterviewManifestV1 | null {
    const found = activeSkill;
    if (!found || found.kind !== "interview") {
      return null;
    }
    return found;
  }

  function wizardAnswer(id: string): string {
    return String(wizardAnswers[id] ?? "");
  }

  function wizardRequiredMissing(skill: SkillWizardManifestV1): string[] {
    const missing: string[] = [];
    for (const step of skill.steps) {
      if (step.type === "markdown" || !step.required) {
        continue;
      }
      const v = wizardAnswer(step.id).trim();
      if (!v) {
        missing.push(step.label);
      }
    }
    return missing;
  }

  function wizardRenderOutput(skill: SkillWizardManifestV1): string {
    return renderSkillTemplate(skill.result.template, wizardAnswers).trimEnd();
  }

  async function wizardSaveToFile(skill: SkillWizardManifestV1): Promise<void> {
    setWizardError(null);
    setWizardSavedPath(null);

    if (!viewActiveThreadId) {
      setWizardError("请先选择一个会话（工作区）后保存");
      return;
    }

    const thread = viewThreadsById[viewActiveThreadId] ?? null;
    const root = thread?.meta.cwd?.trim() ?? "";
    if (!root) {
      setWizardError("当前会话未配置工作区目录");
      return;
    }

    const outputId = (skill.result.outputPathAnswerId ?? "").trim();
    const rel = (outputId ? wizardAnswer(outputId) : "").trim() || (skill.result.defaultOutputPath ?? "").trim();
    if (!rel) {
      setWizardError("缺少保存路径");
      return;
    }

    const abs = joinFsPath(root, rel);
    const content = wizardRenderOutput(skill);
    try {
      const res = await window.tazhan.workspaceWriteFile({ scope: viewScope, root, path: abs, content });
      if (!res.ok) {
        setWizardError(res.error ?? "保存失败");
        return;
      }
      setWizardSavedPath(abs);
    } catch (err) {
      setWizardError(String(err));
    }
  }

  async function wizardSendOutput(skill: SkillWizardManifestV1): Promise<void> {
    setWizardError(null);
    const text = wizardRenderOutput(skill).trim();
    if (!text) {
      setWizardError("输出为空");
      return;
    }
    if (!viewActiveThreadId) {
      openNewChatSetup(text);
      return;
    }
    await sendToThread(viewScope, viewActiveThreadId, text);
  }

  function nextClientId(prefix: string): string {
    const rand = Math.random().toString(16).slice(2);
    return `client_${prefix}_${Date.now()}_${rand}`;
  }

  function preserveClientMessages(prev: ChatMessage[], serverMessages: ChatMessage[]): ChatMessage[] {
    const client = prev.filter((m) => m.id.startsWith("client_"));
    if (client.length === 0) {
      return serverMessages;
    }
    const seen = new Set(serverMessages.map((m) => m.id));
    const merged = serverMessages.slice();
    for (const m of client) {
      if (!seen.has(m.id)) {
        merged.push(m);
      }
    }
    return merged;
  }

  function setSkillActivity(threadId: string, turnId: string, snapshot: TurnActivitySnapshot | null): void;
  function setSkillActivity(scope: "local" | "remote", threadId: string, turnId: string, snapshot: TurnActivitySnapshot | null): void;
  function setSkillActivity(
    a: "local" | "remote" | string,
    b: string,
    c: string | TurnActivitySnapshot | null,
    d?: TurnActivitySnapshot | null
  ): void {
    const scope = a === "remote" || a === "local" ? a : "local";
    const threadId = scope === a ? b : (a as string);
    const turnId = scope === a ? (c as string) : b;
    const snapshot = scope === a ? (d ?? null) : (c as TurnActivitySnapshot | null);
    updateThread(scope, threadId, (prev) => {
      if (!turnId.trim()) {
        return prev;
      }
      if (!snapshot) {
        const { [turnId]: _, ...rest } = prev.turnActivityByTurnId;
        const order = prev.turnActivityOrder.filter((id) => id !== turnId);
        const collapsed = { ...prev.turnActivityCollapsedByTurnId };
        delete collapsed[turnId];
        return { ...prev, turnActivityByTurnId: rest, turnActivityOrder: order, turnActivityCollapsedByTurnId: collapsed };
      }
      const byId = { ...prev.turnActivityByTurnId, [turnId]: snapshot };
      const order = prev.turnActivityOrder.includes(turnId) ? prev.turnActivityOrder : [...prev.turnActivityOrder, turnId];
      const collapsed = { ...prev.turnActivityCollapsedByTurnId, [turnId]: false };
      return { ...prev, turnActivityByTurnId: byId, turnActivityOrder: order, turnActivityCollapsedByTurnId: collapsed };
    });
  }

  function appendClientMessage(threadId: string, msg: ChatMessage): void;
  function appendClientMessage(scope: "local" | "remote", threadId: string, msg: ChatMessage): void;
  function appendClientMessage(a: "local" | "remote" | string, b: string | ChatMessage, c?: ChatMessage): void {
    const scope = a === "remote" || a === "local" ? a : "local";
    const threadId = scope === a ? (b as string) : (a as string);
    const msg = scope === a ? (c as ChatMessage) : (b as ChatMessage);
    updateThread(scope, threadId, (prev) => ({ ...prev, messages: [...prev.messages, msg] }));
  }

  function finalizeClientAssistantMessage(threadId: string, msgId: string, patch: Partial<ChatMessage>): void;
  function finalizeClientAssistantMessage(scope: "local" | "remote", threadId: string, msgId: string, patch: Partial<ChatMessage>): void;
  function finalizeClientAssistantMessage(
    a: "local" | "remote" | string,
    b: string,
    c: string | Partial<ChatMessage>,
    d?: Partial<ChatMessage>
  ): void {
    const scope = a === "remote" || a === "local" ? a : "local";
    const threadId = scope === a ? b : (a as string);
    const msgId = scope === a ? (c as string) : b;
    const patch = scope === a ? (d ?? {}) : (c as Partial<ChatMessage>);
    updateThread(scope, threadId, (prev) => ({
      ...prev,
      messages: prev.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m))
    }));
  }

  async function requestNextInterviewQuestion(
    threadId: string,
    root: string,
    seed: string,
    nextQa: InterviewQa[],
    forceDone: boolean
  ): Promise<void> {
    const skill = activeInterviewSkill();
    if (!skill) {
      setInterviewError("技能未选择或不支持");
      return;
    }

    if (typeof (window as any)?.tazhan?.llmChatComplete !== "function") {
      setInterviewError("技能模块已更新，但应用尚未重启（preload 未刷新）。请重启 Electron 后再试。");
      return;
    }

    const workspaceRoot = root.trim();
    if (!workspaceRoot) {
      setInterviewError("请先打开一个工作区会话");
      return;
    }

    const seedText = seed.trim();
    if (!seedText) {
      setInterviewError("请在输入框输入产品想法");
      return;
    }

    const chosenModel = (() => {
      const configured = (threadsById[threadId]?.config.model ?? "").trim();
      if (configured) {
        return configured;
      }
      return (settingsRef.current?.model ?? "").trim();
    })();

    const maxQuestions = clamp(Math.floor(interviewMaxQuestions || skill.maxQuestions), 1, 30);
    const asked = nextQa.length;
    const remaining = Math.max(0, maxQuestions - asked);
    const mode = interviewAskMode;
    const shouldFinish = mode === "batch" ? forceDone || asked > 0 : forceDone || asked >= maxQuestions;

    const startedAtMs = Date.now();
    const turnId = nextClientId("skill_interview_turn");
    const placeholderId = nextClientId("skill_interview_assistant");

    appendClientMessage(viewScope, threadId, {
      id: placeholderId,
      role: "assistant",
      text: "",
      turnId,
      durationMs: null,
      placeholder: true
    });
    setSkillBusyTurnId(turnId);
    setSkillBusyStartedAtMs(startedAtMs);
    const planText = (() => {
      if (mode === "batch" && asked === 0 && !forceDone) {
        return "生成问题列表…";
      }
      if (mode === "batch") {
        return "生成 PRD…";
      }
      return shouldFinish ? "生成 PRD…" : "生成下一个问题…";
    })();

    setSkillActivity(viewScope, threadId, turnId, {
      turnPlan: { turnId, explanation: planText, plan: [] },
      turnError: null,
      turnItemsById: {},
      turnItemOrder: [],
      durationMs: null
    });

    setInterviewBusy(true);
    setInterviewError(null);
    try {
      if (!shouldFinish) {
        if (mode === "batch") {
          const prompt =
            typeof skill.batchQuestionPrompt === "string" && skill.batchQuestionPrompt.trim().length > 0
              ? skill.batchQuestionPrompt
              : `You are a senior product manager. Ask exactly N clarifying questions in Chinese. Output JSON: {\"questions\": string[], \"why\": string}.`;
          const userContent = `N=${maxQuestions}\n产品想法：${seedText}`;
          const messages: LlmMessage[] = [
            { role: "system", content: prompt },
            { role: "user", content: userContent }
          ];
          const res = await window.tazhan.llmChatComplete({
            messages,
            model: chosenModel || undefined,
            temperature: 0.2,
            maxOutputTokens: 520
          });
          if (!res.ok) {
            const msg = res.error ?? "请求失败";
            setInterviewError(msg);
            finalizeClientAssistantMessage(threadId, placeholderId, {
              placeholder: false,
              text: `（采访失败：${msg}）`,
              durationMs: Math.max(0, Date.now() - startedAtMs)
            });
            return;
          }

          const parsed = parseInterviewBatchQuestions(res.text);
          if (!parsed.ok) {
            const msg = `${parsed.error}\n\n原始输出：\n${res.text}`;
            setInterviewError(msg);
            finalizeClientAssistantMessage(threadId, placeholderId, {
              placeholder: false,
              text: `（采访解析失败：${parsed.error}）`,
              durationMs: Math.max(0, Date.now() - startedAtMs)
            });
            return;
          }

          const list = parsed.value.questions.slice(0, maxQuestions);
          const questionBlob = list.map((q, idx) => `${idx + 1}) ${q}`).join("\n").trim();
          if (!questionBlob) {
            setInterviewError("输出为空");
            finalizeClientAssistantMessage(threadId, placeholderId, {
              placeholder: false,
              text: "（采访解析失败：输出为空）",
              durationMs: Math.max(0, Date.now() - startedAtMs)
            });
            return;
          }

          setInterviewWhy(parsed.value.why.trim());
          setInterviewQuestion(questionBlob);
          finalizeClientAssistantMessage(threadId, placeholderId, {
            placeholder: false,
            text: questionBlob,
            durationMs: Math.max(0, Date.now() - startedAtMs)
          });
          return;
        }

        const transcript = formatInterviewTranscript(seedText, nextQa);
        const userContent = `最大问题数：${maxQuestions}\n已提问：${asked}\n剩余：${remaining}\n\n${transcript}`;
        const messages: LlmMessage[] = [
          { role: "system", content: skill.questionPrompt },
          { role: "user", content: userContent }
        ];
        const res = await window.tazhan.llmChatComplete({
          messages,
          model: chosenModel || undefined,
          temperature: 0.2,
          maxOutputTokens: 260
        });
        if (!res.ok) {
          const msg = res.error ?? "请求失败";
          setInterviewError(msg);
          finalizeClientAssistantMessage(threadId, placeholderId, {
            placeholder: false,
            text: `（采访失败：${msg}）`,
            durationMs: Math.max(0, Date.now() - startedAtMs)
          });
          return;
        }

        const parsed = parseInterviewNextQuestion(res.text);
        if (!parsed.ok) {
          const msg = `${parsed.error}\n\n原始输出：\n${res.text}`;
          setInterviewError(msg);
          finalizeClientAssistantMessage(threadId, placeholderId, {
            placeholder: false,
            text: `（采访解析失败：${parsed.error}）`,
            durationMs: Math.max(0, Date.now() - startedAtMs)
          });
          return;
        }

        setInterviewWhy(parsed.value.why.trim());
        if (!parsed.value.done) {
          setInterviewQuestion(parsed.value.question.trim());
          finalizeClientAssistantMessage(threadId, placeholderId, {
            placeholder: false,
            text: parsed.value.question.trim(),
            durationMs: Math.max(0, Date.now() - startedAtMs)
          });
          return;
        }
      }

      const transcript = formatInterviewTranscript(seedText, nextQa);
      const prdRes = await window.tazhan.llmChatComplete({
        messages: [
          { role: "system", content: skill.prdPrompt },
          { role: "user", content: transcript }
        ],
        model: chosenModel || undefined,
        temperature: 0.2,
        maxOutputTokens: 2200
      });
      if (!prdRes.ok) {
        const msg = prdRes.error ?? "生成 PRD 失败";
        setInterviewError(msg);
        finalizeClientAssistantMessage(threadId, placeholderId, {
          placeholder: false,
          text: `（PRD 生成失败：${msg}）`,
          durationMs: Math.max(0, Date.now() - startedAtMs)
        });
        return;
      }
      setInterviewQuestion("");
      const prd = prdRes.text.trim();
      setInterviewPrd(prd);
      finalizeClientAssistantMessage(threadId, placeholderId, {
        placeholder: false,
        text: prd,
        durationMs: Math.max(0, Date.now() - startedAtMs)
      });

      const rel = (interviewOutputPath.trim() || skill.defaultOutputPath).trim();
      if (rel) {
        const abs = joinFsPath(workspaceRoot, rel);
        try {
          const res = await window.tazhan.workspaceWriteFile({ scope: "local", root: workspaceRoot, path: abs, content: prd });
          if (res.ok) {
            setInterviewSavedPath(abs);
          } else {
            setInterviewError(res.error ?? "自动保存失败");
          }
        } catch (err) {
          setInterviewError(`自动保存失败：${String(err)}`);
        }
      }
    } catch (err) {
      const msg = String(err);
      setInterviewError(msg);
      finalizeClientAssistantMessage(threadId, placeholderId, {
        placeholder: false,
        text: `（采访异常：${msg}）`,
        durationMs: Math.max(0, Date.now() - startedAtMs)
      });
    } finally {
      setInterviewBusy(false);
      setSkillBusyTurnId(null);
      setSkillBusyStartedAtMs(null);
      setSkillActivity(threadId, turnId, null);
    }
  }

  async function startInterview(threadId: string, root: string, seed: string): Promise<void> {
    const seedText = seed.trim();
    if (!seedText) {
      setInterviewError("请在输入框输入产品想法");
      return;
    }
    setInterviewSeed(seedText);
    setInterviewQa([]);
    setInterviewQuestion("");
    setInterviewWhy("");
    setInterviewPrd("");
    setInterviewSavedPath(null);
    await requestNextInterviewQuestion(threadId, root, seedText, [], false);
  }

  async function submitInterviewAnswerFromComposer(
    threadId: string,
    root: string,
    seed: string,
    answer: string
  ): Promise<void> {
    const q = interviewQuestion.trim();
    const a = answer.trim();
    if (!q) {
      return;
    }
    if (!a) {
      setInterviewError("请先输入回答");
      return;
    }

    appendClientMessage(threadId, {
      id: nextClientId("skill_interview_user"),
      role: "user",
      text: a,
      turnId: "",
      durationMs: null,
      placeholder: false
    });

    const nextQa = [...interviewQa, { q, a }];
    setInterviewQa(nextQa);
    setInterviewQuestion("");
    await requestNextInterviewQuestion(threadId, root, seed, nextQa, false);
  }

  async function refreshApiSettings(): Promise<void> {
    setApiBusy(true);
    setApiError(null);
    try {
      const res = await window.tazhan.codexUserConfigRead();
      setApiLiveCodexHome(res.codexHome);
      setApiLiveConfigPath(res.configPath);
      setApiLiveAuthPath(res.authPath);
      setApiLiveModelProvider(res.modelProvider);
      setApiLiveBaseUrl(res.baseUrl);
      setApiLiveKeyPresent(res.apiKeyPresent);
      setApiLiveKeyMasked(res.apiKeyMasked);

      const s = settingsRef.current;
      if (s && (s.apiProfiles ?? []).length === 0) {
        const baseUrl = res.baseUrl.trim();
        const providerRaw = (res.modelProvider ?? "").trim();
        const provider = /^[a-zA-Z0-9_-]+$/.test(providerRaw) ? providerRaw : "";
        if (baseUrl || provider) {
          const created = makeNewApiProfile();
          const now = Date.now();
          const seeded: ApiProviderProfile = {
            id: created.id,
            name: provider ? `当前（${provider}）` : "当前提供商",
            codexProvider: provider || created.codexProvider,
            baseUrl,
            apiKey: "",
            createdAt: now,
            updatedAt: now
          };

          await saveSettingsPatch({ apiProfiles: [seeded], apiActiveProfileId: seeded.id });
          selectApiProfile(seeded.id);
        }
      }

      if (!res.ok) {
        setApiError(res.error || "读取 Codex 配置失败");
      }
    } catch (err) {
      setApiError(String(err));
    } finally {
      setApiBusy(false);
    }
  }

  function selectApiProfile(profileId: string | null): void {
    const s = settingsRef.current;
    const list = s?.apiProfiles ?? [];
    const selected = profileId ? list.find((p) => p.id === profileId) ?? null : null;
    setApiSelectedProfileId(profileId);
    setApiProfileName(selected?.name ?? "");
    setApiProfileProvider(selected?.codexProvider ?? "");
    setApiProfileBaseUrl(selected?.baseUrl ?? "");
    setApiProfileApiKey(selected?.apiKey ?? "");
    setApiProfileShowKey(false);
    setApiTestResult(null);
  }

  function makeNewApiProfile(): ApiProviderProfile {
    const now = Date.now();
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `p_${now}_${Math.random().toString(16).slice(2)}`;
    const provider = `p_${id.replaceAll("-", "").slice(0, 8)}`;
    return { id, name: "新提供商", codexProvider: provider, baseUrl: "", apiKey: "", createdAt: now, updatedAt: now };
  }

  function openApiSettings(): void {
    openPreferences("api");
  }

  function openSshConnect(): void {
    setWorkspaceMenuOpen(false);
    setMoreMenuOpen(false);
    setThreadMenuOpenId(null);
    setPrefsOpen(false);
    setComposerMenuOpen(null);
    setNewChatMenuOpen(null);

    const s = settingsRef.current;
    const d = s?.sshDefaults ?? { host: "", port: 22, username: "", workspaceRoot: "" };
    setSshHost(d.host ?? "");
    setSshPort(typeof d.port === "number" && d.port > 0 ? d.port : 22);
    setSshUsername(d.username ?? "");
    setSshWorkspaceRoot(d.workspaceRoot?.trim().length ? d.workspaceRoot : "/home/ubuntu/TAZHAN_WEB");
    setSshUseLoginShell(true);
    setSshPassword("");
    setSshStep("connect");
    setSshResult(null);
    setSshError(null);
    setRemoteWorkspaceCandidates([]);
    setRemoteWorkspaceHome("");
    setRemoteWorkspaceScanBusy(false);
    setRemoteWorkspaceScanError(null);
    setSshNewWorkspaceParent("");
    setSshNewWorkspaceName("");
    setSshNewWorkspaceBusy(false);
    setSshNewWorkspaceError(null);
    void window.tazhan.remoteWorkspaceStatus().then((st) => setRemoteStatus(st));
    setSshOpen(true);
  }

  function closeSshConnect(): void {
    setSshOpen(false);
    setSshBusy(false);
    setSshPassword("");
    setSshStep("connect");
    setSshError(null);
    setRemoteWorkspaceScanBusy(false);
    setRemoteWorkspaceScanError(null);
    setSshNewWorkspaceBusy(false);
    setSshNewWorkspaceError(null);
  }

  async function probeSsh(): Promise<void> {
    const host = sshHost.trim();
    const port = Math.max(1, Math.floor(Number(sshPort) || 22));
    const username = sshUsername.trim();
    const password = sshPassword;

    if (!host || !username) {
      setSshError("请填写 Host 和用户名");
      return;
    }
    if (!password) {
      setSshError("请输入密码");
      return;
    }

    setSshBusy(true);
    setSshError(null);
    setSshResult(null);
    try {
      const res = await window.tazhan.sshProbe({ host, port, username, password });
      setSshResult(res);
      if (!res.ok) {
        setSshError(res.error ?? "连接失败");
        return;
      }
      await saveSettingsPatch({ sshDefaults: { host, port, username, workspaceRoot: sshWorkspaceRoot.trim() } });
      setSshStep("workspace");
      setRemoteWorkspaceCandidates([]);
      setRemoteWorkspaceHome("");
      setRemoteWorkspaceScanError(null);
      setSshNewWorkspaceParent("");
      setSshNewWorkspaceName("");
      setSshNewWorkspaceError(null);
      void scanRemoteWorkspaces();
    } catch (err) {
      setSshError(String(err));
    } finally {
      setSshBusy(false);
    }
  }

  async function scanRemoteWorkspaces(): Promise<void> {
    const host = sshHost.trim();
    const port = Math.max(1, Math.floor(Number(sshPort) || 22));
    const username = sshUsername.trim();
    const password = sshPassword;

    if (!host || !username) {
      setRemoteWorkspaceScanError("请填写 Host 和用户名");
      return;
    }
    if (!password) {
      setRemoteWorkspaceScanError("请输入密码");
      return;
    }

    setRemoteWorkspaceScanBusy(true);
    setRemoteWorkspaceScanError(null);
    try {
      const res: RemoteWorkspaceScanResult = await window.tazhan.remoteScanWorkspaces({ host, port, username, password });
      if (!res.ok) {
        setRemoteWorkspaceCandidates([]);
        setRemoteWorkspaceHome("");
        setRemoteWorkspaceScanError(res.error ?? "扫描失败");
        return;
      }
      const home = (res.home ?? "").trim();
      setRemoteWorkspaceHome(home);
      if (home) {
        setSshNewWorkspaceParent((prev) => (prev.trim() ? prev : home));
      }
      setRemoteWorkspaceCandidates(res.candidates ?? []);
    } catch (err) {
      setRemoteWorkspaceCandidates([]);
      setRemoteWorkspaceHome("");
      setRemoteWorkspaceScanError(String(err));
    } finally {
      setRemoteWorkspaceScanBusy(false);
    }
  }

  async function createRemoteWorkspaceFolder(): Promise<void> {
    const host = sshHost.trim();
    const port = Math.max(1, Math.floor(Number(sshPort) || 22));
    const username = sshUsername.trim();
    const password = sshPassword;
    const parentRaw = sshNewWorkspaceParent.trim() || remoteWorkspaceHome.trim();
    const nameRaw = sshNewWorkspaceName.trim();

    if (!host || !username) {
      setSshNewWorkspaceError("请先完成连接信息并点击连接");
      return;
    }
    if (!password) {
      setSshNewWorkspaceError("请输入密码");
      return;
    }
    if (!parentRaw || !parentRaw.startsWith("/")) {
      setSshNewWorkspaceError("父目录必须是绝对路径（以 / 开头）");
      return;
    }
    if (!nameRaw) {
      setSshNewWorkspaceError("请输入文件夹名称");
      return;
    }
    if (nameRaw === "." || nameRaw === ".." || nameRaw.includes("/") || nameRaw.includes("\\") || nameRaw.includes("\0")) {
      setSshNewWorkspaceError("文件夹名称不合法");
      return;
    }

    const parent = parentRaw === "/" ? "/" : parentRaw.replace(/\/+$/, "");
    const absPath = parent === "/" ? `/${nameRaw}` : `${parent}/${nameRaw}`;

    setSshNewWorkspaceBusy(true);
    setSshNewWorkspaceError(null);
    try {
      const res = await window.tazhan.remoteMkdirAbs({ host, port, username, password, absPath });
      if (!res.ok || !res.absPath) {
        setSshNewWorkspaceError(res.error ?? "创建失败");
        return;
      }
      setSshWorkspaceRoot(res.absPath);
      setSshNewWorkspaceName("");
      void scanRemoteWorkspaces();
    } catch (err) {
      setSshNewWorkspaceError(String(err));
    } finally {
      setSshNewWorkspaceBusy(false);
    }
  }

  function backToSshConnectInfo(): void {
    setSshStep("connect");
    setSshError(null);
    setRemoteWorkspaceCandidates([]);
    setRemoteWorkspaceHome("");
    setRemoteWorkspaceScanBusy(false);
    setRemoteWorkspaceScanError(null);
    setSshNewWorkspaceBusy(false);
    setSshNewWorkspaceError(null);
  }

  async function connectRemoteWorkspace(): Promise<void> {
    const host = sshHost.trim();
    const port = Math.max(1, Math.floor(Number(sshPort) || 22));
    const username = sshUsername.trim();
    const password = sshPassword;
    const workspaceRoot = sshWorkspaceRoot.trim();

    if (!host || !username) {
      setSshError("请填写 Host 和用户名");
      return;
    }
    if (!workspaceRoot) {
      setSshError("请填写工作区目录");
      return;
    }
    if (!password) {
      setSshError("请输入密码");
      return;
    }

    setSshBusy(true);
    setSshError(null);
    try {
      const res = await window.tazhan.remoteWorkspaceConnect({ host, port, username, password, workspaceRoot, useLoginShell: sshUseLoginShell });
      if (!res.ok) {
        setSshError(res.error ?? "连接失败");
        return;
      }

      await saveSettingsPatch({ sshDefaults: { host, port, username, workspaceRoot } });
      const st = await window.tazhan.remoteWorkspaceStatus();
      setRemoteStatus(st);

      setRemoteActiveThreadId(null);
      setRemoteThreadsById({});
      setRemoteThreadOrder([]);
      setRemoteModels([]);
      setRemoteThreadListCursor(null);

      setThreadMenuOpenId(null);

      const s = settingsRef.current;
      await startThreadInCwd("remote", {
        cwd: workspaceRoot,
        model: s?.model ?? "",
        approvalPolicy: s?.approvalPolicy ?? "on-request",
        sandbox: s?.sandbox ?? "workspace-write",
        reasoningEffort: s?.reasoningEffort ?? "",
        notify: s?.notifyOnComplete ?? true
      });
      await refreshModels("remote");
      await refreshThreads("remote");
      setViewScope("remote");

      setSshPassword("");
      setSshOpen(false);
    } catch (err) {
      setSshError(String(err));
    } finally {
      setSshBusy(false);
    }
  }

  async function disconnectRemoteWorkspace(): Promise<void> {
    setSshBusy(true);
    setSshError(null);
    try {
      const res = await window.tazhan.remoteWorkspaceDisconnect();
      if (!res.ok) {
        setSshError(res.error ?? "断开失败");
        return;
      }
      const st = await window.tazhan.remoteWorkspaceStatus();
      setRemoteStatus(st);
      setThreadMenuOpenId(null);
      setRemoteCodexStatus("disconnected");
      setRemoteActiveThreadId(null);
      setRemoteThreadsById({});
      setRemoteThreadOrder([]);
      setRemoteModels([]);
      setRemoteThreadListCursor(null);
    } catch (err) {
      setSshError(String(err));
    } finally {
      setSshBusy(false);
    }
  }

  function closeApiSettings(): void {
    setApiOpen(false);
    setApiError(null);
    setApiTestResult(null);
  }

  async function saveApiProfileDraft(nextActive: boolean): Promise<void> {
    const s = settingsRef.current;
    if (!s) {
      return;
    }

    const id = apiSelectedProfileId;
    const generated = id ? null : makeNewApiProfile();
    const now = Date.now();
    const next: ApiProviderProfile = {
      id: id ?? generated!.id,
      name: apiProfileName.trim() || "未命名",
      codexProvider: apiProfileProvider.trim() || generated!.codexProvider,
      baseUrl: apiProfileBaseUrl.trim(),
      apiKey: apiProfileApiKey,
      createdAt: id ? (s.apiProfiles.find((p) => p.id === id)?.createdAt ?? now) : now,
      updatedAt: now
    };

    const list = s.apiProfiles ?? [];
    const exists = id ? list.some((p) => p.id === id) : false;
    const nextList = exists ? list.map((p) => (p.id === id ? next : p)) : [next, ...list];
    const activeId = nextActive ? next.id : s.apiActiveProfileId;
    await saveSettingsPatch({ apiProfiles: nextList, apiActiveProfileId: activeId ?? null });
    selectApiProfile(next.id);
  }

  async function applyApiProfileDraft(): Promise<void> {
    setApiBusy(true);
    setApiError(null);
    try {
      const provider = apiProfileProvider.trim();
      const baseUrl = apiProfileBaseUrl.trim();
      const apiKey = apiProfileApiKey.trim();

      if (!provider) {
        setApiError("Provider 标识不能为空");
        return;
      }
      if (!baseUrl) {
        setApiError("Base URL 不能为空");
        return;
      }

      await saveApiProfileDraft(true);

      const res = await window.tazhan.codexUserConfigWrite({
        model: null,
        modelProvider: provider,
        baseUrl,
        apiKey: apiKey ? apiKey : null,
        clearApiKey: false
      });

      if (!res.ok) {
        setApiError(res.error || "保存失败");
        return;
      }

      if (status === "connected") {
        try {
          await window.tazhan.codexDisconnect();
        } catch {
        }
        void connect();
      }

      void refreshApiSettings();
    } catch (err) {
      setApiError(String(err));
    } finally {
      setApiBusy(false);
    }
  }

  function cancelNewChatSetup(): void {
    setNewChatOpen(false);
    setActiveThreadId(newChatPrevThreadId);
    setNewChatPrevThreadId(null);
    setNewChatDraftMessage("");
    setNewChatResumeThreadId(null);
  }

  function choosePrefsModel(nextModelId: string): void {
    const modelId = nextModelId.trim();
    const selected =
      modelId.length > 0
        ? models.find((m) => m.id === modelId) ?? null
        : models.find((m) => m.isDefault) ?? null;

    let nextEffort = prefsReasoningEffort;
    if (
      nextEffort &&
      selected &&
      !selected.supportedReasoningEfforts.some((opt) => opt.reasoningEffort === nextEffort)
    ) {
      nextEffort = "";
    }

    setPrefsModel(modelId);
    setPrefsReasoningEffort(nextEffort);
  }

  function choosePrefsModelPreset(nextValue: string): void {
    if (nextValue === "__custom__") {
      const configured = prefsModel.trim();
      if (!configured || models.some((m) => m.id === configured)) {
        setPrefsModel("");
      }
      return;
    }

    choosePrefsModel(nextValue);
  }

  function prepareApiSettingsSection(): void {
    setApiError(null);
    setApiTestResult(null);

    const s = settingsRef.current;
    const list = s?.apiProfiles ?? [];
    const activeId = s?.apiActiveProfileId ?? null;
    const initialId = activeId && list.some((p) => p.id === activeId) ? activeId : list[0]?.id ?? null;
    selectApiProfile(initialId);
    void refreshApiSettings();
  }

  function showPreferencesSection(section: PreferencesScrollSection): void {
    setPrefsSection(section);
    if (section === "api") {
      prepareApiSettingsSection();
    }
  }

  async function pickDefaultWorkspace(): Promise<void> {
    const picked = await window.tazhan.pickWorkspace();
    if (picked) {
      setPrefsDefaultCwd(picked);
    }
  }

  async function confirmPreferences(): Promise<void> {
    const nextCodexPath = prefsCodexPath.trim() || "codex";
    const prevCodexPath = settings?.codexPath ?? "";
    const prevModel = settings?.model ?? "";
    const prevRelay = settings?.relay ?? null;
    const nextRelayBaseUrl = prefsRelayBaseUrl.trim();
    const nextModel = prefsModel.trim();

    const patch: Partial<AppSettings> = {
      theme: prefsTheme,
      codexPath: nextCodexPath,
      defaultCwd: prefsDefaultCwd.trim(),
      notifyWebhookUrl: prefsWebhookUrl.trim(),
      relay: prevRelay
        ? { ...prevRelay, enabled: prefsRelayEnabled, baseUrl: nextRelayBaseUrl }
        : {
            enabled: prefsRelayEnabled,
            baseUrl: nextRelayBaseUrl,
            auth: null,
            lastPairingCode: "",
            lastPairingExpiresAt: 0,
            lastPairingQrPayload: "",
            allowedRoots: [],
            e2ee: {
              enabled: false,
              required: false,
              allowTofu: false,
              deviceKeyId: "",
              deviceEd25519PublicKey: "",
              deviceEd25519PrivateKey: "",
              trustedPeers: []
            }
          },
      model: nextModel,
      approvalPolicy: prefsApprovalPolicy,
      sandbox: prefsSandbox,
      reasoningEffort: prefsReasoningEffort,
      notifyOnComplete: prefsNotifyOnComplete
    };

    await saveSettingsPatch(patch);

    await syncCodexModelConfig(nextModel);

    if (status === "connected" && (nextCodexPath.trim() !== prevCodexPath.trim() || nextModel !== prevModel.trim())) {
      try {
        await window.tazhan.codexDisconnect();
      } catch {
      }
    }

    void connect();
    setPrefsOpen(false);
  }

  async function testApiProfileDraft(): Promise<void> {
    setApiTestBusy(true);
    setApiTestResult(null);
    try {
      const res = await window.tazhan.codexProviderTest({
        baseUrl: apiProfileBaseUrl.trim(),
        apiKey: apiProfileApiKey.trim()
      });
      setApiTestResult(res);
    } catch (err) {
      setApiTestResult({
        ok: false,
        latencyMs: null,
        status: null,
        modelsCount: null,
        suggestedBaseUrl: null,
        error: String(err)
      });
    } finally {
      setApiTestBusy(false);
    }
  }

  async function refreshModels(scope: "local" | "remote" = "local"): Promise<void> {
    try {
      if (scope === "remote") {
        const list = await window.tazhan.remoteModelList();
        setRemoteModels(list);
      } else {
        const list = await window.tazhan.modelList();
        setModels(list);
      }
    } catch (err) {
      appendLog(`[warn] model list failed: ${String(err)}`);
    }
  }

  async function refreshThreads(scope: "local" | "remote" = "local"): Promise<void> {
    try {
      const listCall = scope === "remote" ? window.tazhan.remoteThreadList : window.tazhan.threadList;
      const resp = await listCall({
        cursor: null,
        limit: 50,
        sortKey: "updated_at",
        modelProviders: [],
        archived: false
      });

      const data = Array.isArray((resp as any)?.data) ? ((resp as any).data as any[]) : [];
      const nextCursor = (resp as any)?.nextCursor;
      const cursorValue = typeof nextCursor === "string" ? nextCursor : null;
      if (scope === "remote") {
        setRemoteThreadListCursor(cursorValue);
      } else {
        setThreadListCursor(cursorValue);
      }

      const metas = data.map(threadMetaFromServer).filter((m) => m.id.length > 0);
      const setOrder = scope === "remote" ? setRemoteThreadOrder : setThreadOrder;
      const setById = scope === "remote" ? setRemoteThreadsById : setThreadsById;

      setOrder((prev) => {
        const returned = metas.map((m) => m.id);
        const seen = new Set(returned);
        const carry = prev.filter((id) => !seen.has(id));
        return [...returned, ...carry];
      });
      setById((prev) => {
        const next = { ...prev };
        for (const meta of metas) {
          const existing = next[meta.id] ?? makeThreadState(meta.id);
          next[meta.id] = {
            ...existing,
            meta: { ...existing.meta, ...meta },
            lastTurnCompletedAtMs:
              existing.lastTurnCompletedAtMs ?? (!existing.running && meta.updatedAt > 0 ? meta.updatedAt * 1000 : null)
          };
        }
        return next;
      });
    } catch (err) {
      appendLog(`[warn] thread list failed: ${String(err)}`);
    }
  }

  async function loadMoreThreads(scope: "local" | "remote" = "local"): Promise<void> {
    const cursor = scope === "remote" ? remoteThreadListCursor : threadListCursor;
    if (!cursor) {
      return;
    }

    try {
      const listCall = scope === "remote" ? window.tazhan.remoteThreadList : window.tazhan.threadList;
      const resp = await listCall({
        cursor,
        limit: 50,
        sortKey: "updated_at",
        modelProviders: [],
        archived: false
      });

      const data = Array.isArray((resp as any)?.data) ? ((resp as any).data as any[]) : [];
      const nextCursor = (resp as any)?.nextCursor;
      const cursorValue = typeof nextCursor === "string" ? nextCursor : null;
      if (scope === "remote") {
        setRemoteThreadListCursor(cursorValue);
      } else {
        setThreadListCursor(cursorValue);
      }

      const metas = data.map(threadMetaFromServer).filter((m) => m.id.length > 0);
      const setOrder = scope === "remote" ? setRemoteThreadOrder : setThreadOrder;
      const setById = scope === "remote" ? setRemoteThreadsById : setThreadsById;
      setOrder((prev) => {
        const seen = new Set(prev);
        const append = metas.map((m) => m.id).filter((id) => !seen.has(id));
        return [...prev, ...append];
      });
      setById((prev) => {
        const next = { ...prev };
        for (const meta of metas) {
          const existing = next[meta.id] ?? makeThreadState(meta.id);
          next[meta.id] = { ...existing, meta: { ...existing.meta, ...meta } };
        }
        return next;
      });
    } catch (err) {
      appendLog(`[warn] load more failed: ${String(err)}`);
    }
  }

  async function pickWorkspace(): Promise<void> {
    const picked = await window.tazhan.pickWorkspace();
    if (picked) {
      setNewChatCwd(picked);
    }
  }

  function chooseModel(nextModelId: string): void {
    const modelId = nextModelId.trim();
    const selected =
      modelId.length > 0
        ? models.find((m) => m.id === modelId) ?? null
        : models.find((m) => m.isDefault) ?? null;

    let nextEffort = newChatReasoningEffort;
    if (
      nextEffort &&
      selected &&
      !selected.supportedReasoningEfforts.some((opt) => opt.reasoningEffort === nextEffort)
    ) {
      nextEffort = "";
    }

    setNewChatModel(modelId);
    setNewChatReasoningEffort(nextEffort);
  }

  function threadNotifyEnabled(threadId: string): boolean {
    if (!settings) {
      return true;
    }
    const override = settings.notifyThreads[threadId];
    if (typeof override === "boolean") {
      return override;
    }
    return settings.notifyOnComplete;
  }

  async function toggleThreadNotify(threadId: string): Promise<void> {
    if (!settings) {
      return;
    }
    const enabled = threadNotifyEnabled(threadId);
    await saveSettingsPatch({ notifyThreads: { [threadId]: !enabled } });
  }

  function openRenameThread(threadId: string): void {
    const thread = threadsById[threadId] ?? null;
    const cwd = thread?.meta.cwd?.trim() ?? "";
    const key = cwd.length > 0 ? cwdKey(cwd) : "";
    const title =
      cwd.length > 0
        ? (settings?.workspaceNames[key]?.trim() ?? "") || cwdLabel(cwd)
        : (thread?.meta.preview?.trim() ?? "");
    setRenameThreadId(threadId);
    setRenameThreadName(title);
  }

  function closeRenameThread(): void {
    setRenameThreadId(null);
    setRenameThreadName("");
  }

  async function confirmRenameThread(): Promise<void> {
    const threadId = renameThreadId;
    if (!threadId) {
      return;
    }

    const name = renameThreadName.trim();
    if (!name) {
      appendLog("[warn] 名称不能为空");
      return;
    }

    try {
      const cwd = threadsById[threadId]?.meta.cwd?.trim() ?? "";
      if (cwd.length > 0) {
        await saveSettingsPatch({ workspaceNames: { [cwdKey(cwd)]: name } });
      } else {
        await window.tazhan.threadNameSet({ threadId, name });
        updateThread(threadId, (prev) => ({
          ...prev,
          meta: { ...prev.meta, preview: name }
        }));
      }
      void refreshThreads();
      closeRenameThread();
    } catch (err) {
      appendLog(`[warn] 重命名失败: ${String(err)}`);
    }
  }

  async function confirmNewChat(): Promise<void> {
    const cwd = newChatCwd.trim();
    if (!cwd) {
      appendLog("[warn] 请先选择工作目录");
      return;
    }

    const model = newChatModel.trim();
    const settingsPatch: Partial<AppSettings> = {
      defaultCwd: cwd,
      model,
      approvalPolicy: newChatApprovalPolicy,
      sandbox: newChatSandbox,
      reasoningEffort: newChatReasoningEffort
    };
    await saveSettingsPatch(settingsPatch);

    try {
      await window.tazhan.codexConnect();
      void refreshModels();
      void refreshThreads();
    } catch (err) {
      appendLog(`[error] connect failed: ${String(err)}`);
      return;
    }

    try {
      const threadParams: any = {
        cwd,
        approvalPolicy: newChatApprovalPolicy,
        sandbox: newChatSandbox
      };
      if (model.length > 0) {
        threadParams.model = model;
      }

      const result = await window.tazhan.threadStart(threadParams);
      const thread = (result as any)?.thread;
      const id = typeof thread?.id === "string" ? thread.id : "";
      if (!id) {
        appendLog("[error] thread/start: missing thread.id");
        return;
      }

      upsertThreadFromServer(thread, true);
      setActiveThreadId(id);
      updateThread(id, (prev) => ({
        ...prev,
        historyLoaded: true,
        config: {
          model,
          approvalPolicy: newChatApprovalPolicy,
          sandbox: newChatSandbox,
          reasoningEffort: newChatReasoningEffort
        }
      }));

      await saveSettingsPatch({ notifyThreads: { [id]: newChatNotify } });
      setNewChatOpen(false);
      setNewChatPrevThreadId(null);
      setNewChatDraftMessage("");

      const first = newChatDraftMessage.trim();
      if (first) {
        setDraft("");
        setDraftImages([]);
        await sendToThread(id, first, {
          cwd,
          model,
          approvalPolicy: newChatApprovalPolicy,
          sandbox: newChatSandbox,
          reasoningEffort: newChatReasoningEffort
        });
      }
    } catch (err) {
      appendLog(`[error] thread/start failed: ${String(err)}`);
    }
  }

  async function resumeFromNewChat(threadId: string): Promise<void> {
    const first = newChatDraftMessage.trim();
    setNewChatDraftMessage("");
    setNewChatResumeThreadId(null);

    const cwd = newChatCwd.trim();
    const model = newChatModel.trim();
    await openThread(threadId, {
      cwd,
      model,
      approvalPolicy: newChatApprovalPolicy,
      sandbox: newChatSandbox,
      reasoningEffort: newChatReasoningEffort
    });

    if (first) {
      setDraft("");
      setDraftImages([]);
      await sendToThread(threadId, first, {
        cwd,
        model,
        approvalPolicy: newChatApprovalPolicy,
        sandbox: newChatSandbox,
        reasoningEffort: newChatReasoningEffort
      });
    }
  }

  async function loadThreadHistory(threadId: string): Promise<void>;
  async function loadThreadHistory(scope: "local" | "remote", threadId: string): Promise<void>;
  async function loadThreadHistory(a: "local" | "remote" | string, b?: string): Promise<void> {
    const scope = a === "remote" || a === "local" ? a : "local";
    const threadId = scope === a ? (b ?? "") : (a as string);
    if (!threadId) {
      return;
    }
    try {
      const readCall = scope === "remote" ? window.tazhan.remoteThreadRead : window.tazhan.threadRead;
      const resp = await readCall({ threadId, includeTurns: true });
      const thread = (resp as any)?.thread;
      if (!thread) {
        return;
      }

      const meta = threadMetaFromServer(thread);
      const serverMessages = threadToMessages(thread);
      updateThread(scope, threadId, (prev) => ({
        ...prev,
        meta: { ...prev.meta, ...meta },
        messages: preserveClientMessages(prev.messages, serverMessages),
        historyLoaded: true,
        lastTurnCompletedAtMs:
          prev.lastTurnCompletedAtMs ?? (meta.updatedAt > 0 ? meta.updatedAt * 1000 : prev.lastTurnCompletedAtMs)
      }));
    } catch (err) {
      appendLog(`[warn] thread/read failed: ${String(err)}`);
    }
  }

  async function openThread(
    threadId: string,
    overrides?: {
      cwd?: string;
      model?: string;
      approvalPolicy?: ApprovalPolicy;
      sandbox?: SandboxMode;
      reasoningEffort?: ReasoningEffort | "";
    }
  ): Promise<void>;
  async function openThread(
    scope: "local" | "remote",
    threadId: string,
    overrides?: {
      cwd?: string;
      model?: string;
      approvalPolicy?: ApprovalPolicy;
      sandbox?: SandboxMode;
      reasoningEffort?: ReasoningEffort | "";
    }
  ): Promise<void>;
  async function openThread(
    a: "local" | "remote" | string,
    b?: string | { cwd?: string; model?: string; approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode; reasoningEffort?: ReasoningEffort | "" },
    c?: { cwd?: string; model?: string; approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode; reasoningEffort?: ReasoningEffort | "" }
  ): Promise<void> {
    const scope = a === "remote" || a === "local" ? a : "local";
    const threadId = scope === a ? (b as string) : (a as string);
    const overrides = scope === a ? c : (b as any);

    setNewChatOpen(false);
    setNewChatPrevThreadId(null);
    if (scope === "remote") {
      setRemoteActiveThreadId(threadId);
    } else {
      setActiveThreadId(threadId);
    }
    ensureThreadInOrder(scope, threadId, true);

    try {
      const byId = scope === "remote" ? remoteThreadsById : threadsById;
      const existingThread = byId[threadId] ?? null;
      const s = settingsRef.current;
      const desiredModel = (overrides?.model ?? existingThread?.config.model ?? s?.model ?? "").trim();
      const desiredCwd = (overrides?.cwd ?? existingThread?.meta.cwd ?? s?.defaultCwd ?? "").trim();
      const desiredApprovalPolicy =
        overrides?.approvalPolicy ?? existingThread?.config.approvalPolicy ?? s?.approvalPolicy ?? "on-request";
      const desiredSandbox = overrides?.sandbox ?? existingThread?.config.sandbox ?? s?.sandbox ?? "workspace-write";

      const resumeParams: any = { threadId, approvalPolicy: desiredApprovalPolicy, sandbox: desiredSandbox };
      if (desiredModel) {
        resumeParams.model = desiredModel;
      }
      if (desiredCwd) {
        resumeParams.cwd = desiredCwd;
      }

      const resumeCall = scope === "remote" ? window.tazhan.remoteThreadResume : window.tazhan.threadResume;
      const resp = await resumeCall(resumeParams);
      const resumedThread = (resp as any)?.thread;
      if (resumedThread) {
        upsertThreadFromServer(scope, resumedThread, true);
      }

      const model = typeof (resp as any)?.model === "string" ? (resp as any).model : "";
      const approvalPolicy = (resp as any)?.approvalPolicy as ApprovalPolicy | undefined;
      const rawSandbox = (resp as any)?.sandbox;
      const sandbox = rawSandbox ? sandboxPolicyToMode(rawSandbox) : null;
      const reasoningEffort = (resp as any)?.reasoningEffort as ReasoningEffort | null | undefined;

      updateThread(scope, threadId, (prev) => ({
        ...prev,
        config: {
          model: desiredModel || model || prev.config.model,
          approvalPolicy: desiredApprovalPolicy ?? approvalPolicy ?? prev.config.approvalPolicy,
          sandbox: desiredSandbox ?? sandbox ?? prev.config.sandbox,
          reasoningEffort:
            overrides?.reasoningEffort ?? (typeof reasoningEffort === "string" ? reasoningEffort : null) ?? prev.config.reasoningEffort
        }
      }));
    } catch (err) {
      appendLog(`[warn] thread/resume failed: ${String(err)}`);
    }

    const refById = scope === "remote" ? remoteThreadsByIdRef.current : threadsByIdRef.current;
    const loaded = refById[threadId]?.historyLoaded ?? false;
    if (!loaded) {
      await loadThreadHistory(scope, threadId);
    }
  }

  async function sendToThread(threadId: string, text: string, overrides?: SendToThreadOverrides): Promise<void>;
  async function sendToThread(
    scope: "local" | "remote",
    threadId: string,
    text: string,
    overrides?: SendToThreadOverrides
  ): Promise<void>;
  async function sendToThread(
    a: "local" | "remote" | string,
    b: string,
    c?: string | SendToThreadOverrides,
    d?: SendToThreadOverrides
  ): Promise<void> {
    const scope = a === "remote" || a === "local" ? a : "local";
    const threadId = scope === a ? b : (a as string);
    const text = typeof (scope === a ? c : b) === "string" ? ((scope === a ? c : b) as string) : "";
    const overrides = (scope === a ? d : c) as SendToThreadOverrides | undefined;
    const input = Array.isArray(overrides?.input) && overrides.input.length > 0 ? overrides.input : [{ type: "text", text }];
    const previewText =
      typeof overrides?.previewText === "string" && overrides.previewText.trim().length > 0
        ? overrides.previewText
        : userInputToText(input as any[]);
    ensureThreadInOrder(scope, threadId, true);

    const userMsgId = `local_user_${Date.now()}`;
    const placeholderId = `local_assistant_placeholder_${userMsgId}`;
    const startedAtMs = Date.now();
    updateThread(scope, threadId, (prev) => {
      const previewSource = previewText.trim().length > 0 ? previewText : text;
      const preview = prev.meta.preview.trim().length > 0 ? prev.meta.preview : previewSource.split("\n")[0] ?? "";
      const messages = prev.messages.filter((m) => !m.placeholder);
      messages.push({ id: userMsgId, role: "user", text: previewSource, turnId: "", durationMs: null, placeholder: false });
      messages.push({ id: placeholderId, role: "assistant", text: "", turnId: "", durationMs: null, placeholder: true });
      return {
        ...prev,
        meta: { ...prev.meta, preview },
        running: true,
        activeTurnStartedAtMs: startedAtMs,
        turnId: "",
        turnPlan: null,
        turnError: null,
        turnItemsById: {},
        turnItemOrder: [],
        commands: [],
        fileChanges: [],
        expandedFiles: {},
        turnDiff: "",
        messages
      };
    });

    try {
      const byId = scope === "remote" ? remoteThreadsById : threadsById;
      const thread = byId[threadId] ?? null;
      const model = (overrides?.model ?? thread?.config.model ?? settings?.model ?? "").trim();
      const approvalPolicy =
        overrides?.approvalPolicy ?? thread?.config.approvalPolicy ?? settings?.approvalPolicy ?? "on-request";
      const sandbox = overrides?.sandbox ?? thread?.config.sandbox ?? settings?.sandbox ?? "workspace-write";
      const effort =
        overrides?.reasoningEffort ?? thread?.config.reasoningEffort ?? settings?.reasoningEffort ?? "";
      const cwd = overrides?.cwd ?? (thread?.meta.cwd.trim() || settings?.defaultCwd || "");

      const turnParams: any = {
        threadId,
        input,
        cwd,
        approvalPolicy
      };
      const sandboxPolicy = sandboxModeToPolicy(sandbox, cwd);
      if (sandboxPolicy) {
        turnParams.sandboxPolicy = sandboxPolicy;
      }
      if (model.length > 0) {
        turnParams.model = model;
      }
      if (effort) {
        turnParams.effort = effort;
      }

      if (scope === "remote") {
        await window.tazhan.remoteTurnStart(turnParams);
      } else {
        await window.tazhan.turnStart(turnParams);
      }
    } catch (err) {
      appendLog(`[error] turn/start failed: ${String(err)}`);
      const atMs = Date.now();
      updateThread(scope, threadId, (prev) => {
        const startedAtMs = prev.activeTurnStartedAtMs ?? atMs;
        const durationMs = Math.max(0, atMs - startedAtMs);
        const text = `（发送失败：${String(err)}）`;
        const messages = prev.messages.map((m) => {
          if (m.role !== "assistant" || !m.placeholder) {
            return m;
          }
          return { ...m, placeholder: false, text: m.text.trim().length ? m.text : text, durationMs };
        });
        return {
          ...prev,
          running: false,
          activeTurnStartedAtMs: null,
          lastTurnCompletedAtMs: atMs,
          lastTurnDurationMs: durationMs,
          turnError: {
            threadId,
            turnId: prev.turnId || null,
            message: String(err),
            codexErrorInfo: null,
            willRetry: false,
            atMs
          },
          messages
        };
      });
    }
  }

  async function interruptTurn(threadId: string): Promise<void> {
    const t = threadsByIdRef.current[threadId] ?? null;
    if (!t || !t.running) {
      return;
    }

    const turnId = (t.turnId ?? "").trim();
    if (!turnId) {
      appendLog(`[warn] turn/interrupt: missing active turnId for thread ${threadId}`);
      return;
    }

    try {
      await window.tazhan.turnInterrupt({ threadId, turnId });
    } catch (err) {
      appendLog(`[warn] turn/interrupt failed: ${String(err)}`);
    }
  }

  function removeDraftImage(imageId: string): void {
    setDraftImages((prev) => prev.filter((image) => image.id !== imageId));
  }

  async function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const clipboardFiles = Array.from(event.clipboardData?.files ?? []);
    const clipboardItemFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const files = clipboardFiles.length > 0 ? clipboardFiles : clipboardItemFiles;
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    try {
      const nextImages = await handlePastedImageFiles(files);
      if (nextImages.length === 0) {
        return;
      }
      setDraftImages((prev) => [...prev, ...nextImages]);
    } catch (err) {
      appendLog(`[warn] image paste failed: ${String(err)}`);
    }
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    const images = draftImages;
    if (!text && images.length === 0) {
      return;
    }

    if (!viewActiveThreadId) {
      if (images.length > 0) {
        appendLog("[warn] 请先创建或打开会话，再发送粘贴的图片");
        return;
      }
      setDraft("");
      openNewChatSetup(text);
      return;
    }

    if (activeSkill?.kind === "interview" && interviewBusy) {
      setInterviewError("采访模式正在生成内容，请稍候。");
      return;
    }

    if (activeSkill?.kind === "interview" && images.length > 0) {
      setInterviewError("采访模式暂不支持粘贴图片。");
      return;
    }

    const threadId = viewActiveThreadId;
    const input = buildComposerTurnInput(text, images) as Array<{ type: string; [key: string]: unknown }>;
    const previewText = userInputToText(input as any[]);
    setDraft("");
    setDraftImages([]);
    if (activeSkill?.kind === "interview" && !interviewBusy) {
      if (viewScope !== "local") {
        setInterviewError("采访模式目前仅支持本地会话。");
        return;
      }

      const threadRoot = (threadsById[threadId]?.meta.cwd?.trim() || settingsRef.current?.defaultCwd || "").trim();
      const seed = interviewSeed.trim();

      if (interviewQuestion.trim().length > 0) {
        await submitInterviewAnswerFromComposer(threadId, threadRoot, seed, text);
        return;
      }

      if (!interviewPrd.trim() && !seed) {
        appendClientMessage(threadId, {
          id: nextClientId("skill_interview_seed"),
          role: "user",
          text,
          turnId: "",
          durationMs: null,
          placeholder: false
        });
        await startInterview(threadId, threadRoot, text);
        return;
      }
    }

    await sendToThread(viewScope, threadId, text, { input, previewText });
  }


  type StartThreadInCwdArgs = {
    cwd: string;
    model?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    reasoningEffort?: ReasoningEffort | "";
    notify?: boolean;
    firstMessage?: string;
  };

  async function startThreadInCwd(args: StartThreadInCwdArgs): Promise<void>;
  async function startThreadInCwd(scope: "local" | "remote", args: StartThreadInCwdArgs): Promise<void>;
  async function startThreadInCwd(a: "local" | "remote" | StartThreadInCwdArgs, b?: StartThreadInCwdArgs): Promise<void> {
    const scope = a === "remote" || a === "local" ? a : "local";
    const args = scope === a ? (b as StartThreadInCwdArgs) : (a as StartThreadInCwdArgs);
    const s = settingsRef.current;
    if (!s) {
      appendLog("[warn] 设置未加载，请稍后重试");
      return;
    }

    const cwd = args.cwd.trim();
    if (!cwd) {
      appendLog("[warn] 请先选择工作目录");
      return;
    }

    const model = (args.model ?? s.model ?? "").trim();
    const approvalPolicy = args.approvalPolicy ?? s.approvalPolicy ?? "on-request";
    const sandbox = args.sandbox ?? s.sandbox ?? "workspace-write";
    const reasoningEffort = args.reasoningEffort ?? s.reasoningEffort ?? "";
    const notify = typeof args.notify === "boolean" ? args.notify : s.notifyOnComplete;
    const first = (args.firstMessage ?? "").trim();

    if (scope === "local") {
      if (statusRef.current !== "connected") {
        try {
          await window.tazhan.codexConnect();
        } catch (err) {
          appendLog(`[error] connect failed: ${String(err)}`);
          return;
        }
      }
    } else {
      try {
        const st = await window.tazhan.remoteWorkspaceStatus();
        if (!st?.connected) {
          appendLog("[warn] 远端未连接，请先连接服务器");
          return;
        }
      } catch (err) {
        appendLog(`[warn] 远端状态获取失败：${String(err)}`);
        return;
      }
    }

    try {
      const threadParams: any = { cwd, approvalPolicy, sandbox };
      if (model.length > 0) {
        threadParams.model = model;
      }

      const startCall = scope === "remote" ? window.tazhan.remoteThreadStart : window.tazhan.threadStart;
      const result = await startCall(threadParams);
      const thread = (result as any)?.thread;
      const id = typeof thread?.id === "string" ? thread.id : "";
      if (!id) {
        appendLog("[error] thread/start: missing thread.id");
        return;
      }

      upsertThreadFromServer(scope, thread, true);
      if (scope === "remote") {
        setRemoteActiveThreadId(id);
      } else {
        setActiveThreadId(id);
      }
      updateThread(scope, id, (prev) => ({
        ...prev,
        historyLoaded: true,
        config: { model, approvalPolicy, sandbox, reasoningEffort }
      }));
      void saveSettingsPatch({ notifyThreads: { [id]: notify } });
      if (scope === "local") {
        void refreshCodexCliInfo();
      }
      void refreshModels(scope);
      void refreshThreads(scope);

      if (first) {
        setDraft("");
        setDraftImages([]);
        await sendToThread(scope, id, first, { cwd, model, approvalPolicy, sandbox, reasoningEffort });
      }
    } catch (err) {
      appendLog(`[error] thread/start failed: ${String(err)}`);
    }
  }

  async function withNewThreadBusy(fn: () => Promise<void>): Promise<void> {
    if (newThreadBusyRef.current) {
      appendLog("[info] 正在新建会话，请稍候…");
      return;
    }

    setNewThreadBusy(true);
    try {
      await fn();
    } finally {
      setNewThreadBusy(false);
    }
  }

  async function startNewChatFast(): Promise<void> {
    setDraft("");
    setDraftImages([]);

    const s = settingsRef.current;
    const scope = viewScopeRef.current;
    const currentId = activeThreadIdRef.current;
    const byId = scope === "remote" ? remoteThreadsByIdRef.current : threadsByIdRef.current;
    const currentThread = currentId ? byId[currentId] ?? null : null;

    await withNewThreadBusy(async () => {
      let cwd = (
        (currentThread?.meta.cwd?.trim() || "") ||
        (scope === "remote" ? (remoteStatus?.connected ? remoteStatus.workspaceRoot : "") : "") ||
        (s?.defaultCwd?.trim() || "")
      ).trim();
      if (!cwd) {
        if (scope === "remote") {
          appendLog("[warn] 远端缺少工作区目录，请先连接服务器并选择工作区");
          return;
        }

        const picked = await window.tazhan.pickWorkspace();
        if (!picked) {
          return;
        }
        cwd = picked.trim();
        await saveSettingsPatch({ defaultCwd: cwd });
      }

      await startThreadInCwd(scope, {
        cwd,
        model: currentThread?.config.model ?? s?.model ?? "",
        approvalPolicy: currentThread?.config.approvalPolicy ?? s?.approvalPolicy ?? "on-request",
        sandbox: currentThread?.config.sandbox ?? s?.sandbox ?? "workspace-write",
        reasoningEffort: currentThread?.config.reasoningEffort ?? s?.reasoningEffort ?? "",
        notify: s?.notifyOnComplete ?? true
      });
    });
  }

  async function startNewWorkspace(): Promise<void> {
    setDraft("");
    setDraftImages([]);
    await withNewThreadBusy(async () => {
      const picked = await window.tazhan.pickWorkspace();
      if (!picked) {
        return;
      }

      const cwd = picked.trim();
      if (!cwd) {
        return;
      }

      const s = settingsRef.current;
      await saveSettingsPatch({ defaultCwd: cwd });
      setViewScope("local");
      setSidebarPanel("threads");
      await startThreadInCwd("local", {
        cwd,
        model: s?.model ?? "",
        approvalPolicy: s?.approvalPolicy ?? "on-request",
        sandbox: s?.sandbox ?? "workspace-write",
        reasoningEffort: s?.reasoningEffort ?? "",
        notify: s?.notifyOnComplete ?? true
      });
    });
  }

  function startNewChat(): void {
    void startNewChatFast();
  }

  async function quickStartThread(firstMessage: string): Promise<void> {
    const s = settings;
    if (!s) {
      appendLog("[warn] 设置未加载，请稍后重试");
      return;
    }

    const cwd = s.defaultCwd.trim();
    if (!cwd) {
      openNewChatSetup(firstMessage);
      return;
    }

    const model = s.model.trim();
    const approvalPolicy = s.approvalPolicy;
    const sandbox = s.sandbox;
    const reasoningEffort = s.reasoningEffort;

    try {
      await window.tazhan.codexConnect();
      void refreshModels();
      void refreshThreads();
    } catch (err) {
      appendLog(`[error] connect failed: ${String(err)}`);
      return;
    }

    try {
      const threadParams: any = { cwd, approvalPolicy, sandbox };
      if (model.length > 0) {
        threadParams.model = model;
      }

      const result = await window.tazhan.threadStart(threadParams);
      const thread = (result as any)?.thread;
      const id = typeof thread?.id === "string" ? thread.id : "";
      if (!id) {
        appendLog("[error] thread/start: missing thread.id");
        return;
      }

      upsertThreadFromServer(thread, true);
      setActiveThreadId(id);
      updateThread(id, (prev) => ({
        ...prev,
        historyLoaded: true,
        config: {
          model,
          approvalPolicy,
          sandbox,
          reasoningEffort
        }
      }));

      await sendToThread(id, firstMessage, {
        cwd,
        model,
        approvalPolicy,
        sandbox,
        reasoningEffort
      });
    } catch (err) {
      appendLog(`[error] quick start failed: ${String(err)}`);
    }
  }

  async function respondApproval(decision: string): Promise<void> {
    if (!pendingApproval) {
      return;
    }
    appendLog(`[approval] ${pendingApproval.method} -> ${decision}`);
    if (pendingApproval.scope === "remote") {
      await window.tazhan.remoteRespond(pendingApproval.id, { decision });
    } else {
      await window.tazhan.respond(pendingApproval.id, { decision });
    }
    setPendingApproval(null);
  }

  function toggleFile(key: string): void {
    if (!viewActiveThreadId) {
      return;
    }
    updateThread(viewScope, viewActiveThreadId, (prev) => ({
      ...prev,
      expandedFiles: { ...prev.expandedFiles, [key]: !prev.expandedFiles[key] }
    }));
  }

  async function explorerLoadDir(scope: "local" | "remote", threadId: string, dirPath: string): Promise<void> {
    const byId = scope === "remote" ? remoteThreadsByIdRef.current : threadsByIdRef.current;
    const root = byId[threadId]?.meta.cwd?.trim() ?? "";
    if (!root) {
      return;
    }

    updateThread(scope, threadId, (prev) => ({
      ...prev,
      explorer: {
        ...prev.explorer,
        loadingDirs: { ...prev.explorer.loadingDirs, [dirPath]: true },
        selectedError: null
      }
    }));

    try {
      const res = await window.tazhan.workspaceListDir({ root, dir: dirPath, scope });
      if (!res.ok) {
        updateThread(scope, threadId, (prev) => ({
          ...prev,
          explorer: {
            ...prev.explorer,
            loadingDirs: { ...prev.explorer.loadingDirs, [dirPath]: false },
            selectedError: res.error ?? "listDir failed"
          }
        }));
        return;
      }

      updateThread(scope, threadId, (prev) => ({
        ...prev,
        explorer: {
          ...prev.explorer,
          entriesByDir: { ...prev.explorer.entriesByDir, [dirPath]: res.entries as unknown as ExplorerEntry[] },
          loadingDirs: { ...prev.explorer.loadingDirs, [dirPath]: false },
          selectedError: null
        }
      }));
    } catch (err) {
      updateThread(scope, threadId, (prev) => ({
        ...prev,
        explorer: {
          ...prev.explorer,
          loadingDirs: { ...prev.explorer.loadingDirs, [dirPath]: false },
          selectedError: String(err)
        }
      }));
    }
  }

  function explorerToggleDir(scope: "local" | "remote", threadId: string, dirPath: string): void {
    const byId = scope === "remote" ? remoteThreadsById : threadsById;
    const thread = byId[threadId] ?? null;
    const currentExpanded = Boolean(thread?.explorer.expandedDirs[dirPath]);
    const nextExpanded = !currentExpanded;

    updateThread(scope, threadId, (prev) => ({
      ...prev,
      explorer: {
        ...prev.explorer,
        selectedEntry: { path: dirPath, kind: "dir" },
        expandedDirs: { ...prev.explorer.expandedDirs, [dirPath]: nextExpanded }
      }
    }));

    if (!nextExpanded) {
      return;
    }

    const loaded = Boolean(thread?.explorer.entriesByDir[dirPath]);
    const loading = Boolean(thread?.explorer.loadingDirs[dirPath]);
    if (!loaded && !loading) {
      void explorerLoadDir(scope, threadId, dirPath);
    }
  }

  async function explorerSelectFile(threadId: string, filePath: string): Promise<void>;
  async function explorerSelectFile(scope: "local" | "remote", threadId: string, filePath: string): Promise<void>;
  async function explorerSelectFile(a: "local" | "remote" | string, b: string, c?: string): Promise<void> {
    const scope = a === "remote" || a === "local" ? a : "local";
    const threadId = scope === a ? b : (a as string);
    const filePath = scope === a ? (c ?? "") : b;
    const byId = scope === "remote" ? remoteThreadsByIdRef.current : threadsByIdRef.current;
    const root = byId[threadId]?.meta.cwd?.trim() ?? "";
    if (!root) {
      return;
    }

    updateThread(scope, threadId, (prev) => ({
      ...prev,
      explorer: {
        ...prev.explorer,
        selectedEntry: { path: filePath, kind: "file" },
        selectedPath: filePath,
        selectedContent: "",
        selectedTruncated: false,
        selectedError: null,
        loadingFile: true
      }
    }));

    try {
      const res = await window.tazhan.workspaceReadFile({ root, path: filePath, scope });
      if (!res.ok) {
        updateThread(scope, threadId, (prev) => ({
          ...prev,
          explorer: {
            ...prev.explorer,
            selectedError: res.error ?? "readFile failed",
            loadingFile: false
          }
        }));
        return;
      }

      updateThread(scope, threadId, (prev) => ({
        ...prev,
        explorer: {
          ...prev.explorer,
          selectedContent: res.content ?? "",
          selectedTruncated: Boolean(res.truncated),
          selectedError: null,
          loadingFile: false
        }
      }));

      setFilePreview((prev) => {
        if (!prev || prev.threadId !== threadId || prev.path !== filePath) {
          return prev;
        }
        if (prev.mode !== "edit") {
          return prev;
        }
        if (res.truncated) {
          return { ...prev, mode: "view", draft: "", saving: false, error: "文件已截断，禁止直接编辑" };
        }
        if (prev.draft.length > 0) {
          return prev;
        }
        return { ...prev, draft: res.content ?? "", error: null };
      });
    } catch (err) {
      updateThread(scope, threadId, (prev) => ({
        ...prev,
        explorer: {
          ...prev.explorer,
          selectedError: String(err),
          loadingFile: false
        }
      }));
    }
  }

  function refreshExplorer(threadId: string, extraDirs?: string[]): void {
    const scope = remoteThreadsByIdRef.current[threadId] ? "remote" : "local";
    const byId = scope === "remote" ? remoteThreadsByIdRef.current : threadsByIdRef.current;
    const thread = byId[threadId] ?? null;
    const root = thread?.meta.cwd?.trim() ?? "";
    if (!thread || !root) {
      return;
    }

    const expanded = thread.explorer.expandedDirs ?? {};
    const dirs = Object.entries(expanded)
      .filter(([, open]) => Boolean(open))
      .map(([dir]) => dir);
    const all = Array.from(new Set<string>([root, ...dirs, ...(extraDirs ?? [])])).sort((a, b) => a.length - b.length);

    updateThread(scope, threadId, (prev) => ({
      ...prev,
      explorer: {
        ...prev.explorer,
        expandedDirs: { ...prev.explorer.expandedDirs, [root]: true },
        entriesByDir: {},
        loadingDirs: {},
        selectedError: null
      }
    }));

    for (const dir of all) {
      void explorerLoadDir(scope, threadId, dir);
    }
  }

  function openExplorerContextMenu(
    ev: React.MouseEvent,
    threadId: string,
    root: string,
    entry: ExplorerEntry
  ): void {
    ev.preventDefault();
    ev.stopPropagation();

    const scope = remoteThreadsByIdRef.current[threadId] ? "remote" : "local";
    updateThread(scope, threadId, (prev) => ({
      ...prev,
      explorer: {
        ...prev.explorer,
        selectedEntry: { path: entry.path, kind: entry.kind },
        selectedPath: entry.kind === "file" ? entry.path : prev.explorer.selectedPath
      }
    }));

    const parentDir = entry.kind === "dir" ? entry.path : pathDirname(entry.path) || root;
    const anchorX = ev.clientX + 2;
    const anchorY = ev.clientY + 2;
    setExplorerMenu({
      scope,
      threadId,
      root,
      target: entry,
      parentDir,
      anchorX,
      anchorY,
      left: anchorX,
      top: anchorY
    });
  }

  function closeFileOp(): void {
    setFileOp(null);
    setFileOpError(null);
    setFileOpBusy(false);
  }

  async function confirmFileOp(): Promise<void> {
    const op = fileOp;
    if (!op) {
      return;
    }

    const scope = remoteThreadsByIdRef.current[op.threadId] ? "remote" : "local";
    const byId = scope === "remote" ? remoteThreadsByIdRef.current : threadsByIdRef.current;
    const thread = byId[op.threadId] ?? null;
    const root = thread?.meta.cwd?.trim() ?? "";
    if (!thread || !root) {
      setFileOpError("缺少工作区目录");
      return;
    }

    setFileOpBusy(true);
    setFileOpError(null);

    try {
      if (op.kind === "newFolder") {
        const name = op.name.trim();
        if (!name) {
          setFileOpError("名称不能为空");
          return;
        }

        const res = await window.tazhan.workspaceMkdir({ scope, root, parentDir: op.parentDir, name });
        if (!res.ok || !res.path) {
          setFileOpError(res.error ?? "创建文件夹失败");
          return;
        }

        updateThread(scope, op.threadId, (prev) => ({
          ...prev,
          explorer: {
            ...prev.explorer,
            expandedDirs: { ...prev.explorer.expandedDirs, [op.parentDir]: true },
            selectedEntry: { path: res.path!, kind: "dir" }
          }
        }));
        refreshExplorer(op.threadId, [op.parentDir]);
        closeFileOp();
        return;
      }

      if (op.kind === "newFile") {
        const name = op.name.trim();
        if (!name) {
          setFileOpError("名称不能为空");
          return;
        }

        const res = await window.tazhan.workspaceCreateFile({ scope, root, parentDir: op.parentDir, name });
        if (!res.ok || !res.path) {
          setFileOpError(res.error ?? "创建文件失败");
          return;
        }

        const filePath = res.path!;
        updateThread(scope, op.threadId, (prev) => ({
          ...prev,
          explorer: {
            ...prev.explorer,
            expandedDirs: { ...prev.explorer.expandedDirs, [op.parentDir]: true },
            selectedEntry: { path: filePath, kind: "file" },
            selectedPath: filePath,
            selectedContent: "",
            selectedTruncated: false,
            selectedError: null,
            loadingFile: false
          }
        }));
        setFilePreview({ threadId: op.threadId, path: filePath, mode: "edit", draft: "", saving: false, error: null });
        refreshExplorer(op.threadId, [op.parentDir]);
        closeFileOp();
        return;
      }

      if (op.kind === "rename") {
        const newName = op.newName.trim();
        if (!newName) {
          setFileOpError("名称不能为空");
          return;
        }

        const fromPath = op.path;
        const res = await window.tazhan.workspaceRename({ scope, root, path: fromPath, newName });
        if (!res.ok || !res.path) {
          setFileOpError(res.error ?? "重命名失败");
          return;
        }

        const toPath = res.path!;
        updateThread(scope, op.threadId, (prev) => {
          const expandedDirs: Record<string, boolean> = {};
          for (const [dir, open] of Object.entries(prev.explorer.expandedDirs)) {
            if (!open) {
              continue;
            }
            if (dir === fromPath) {
              expandedDirs[toPath] = true;
              continue;
            }
            if (
              dir.startsWith(fromPath) &&
              (dir[fromPath.length] === "/" || dir[fromPath.length] === "\\")
            ) {
              expandedDirs[`${toPath}${dir.slice(fromPath.length)}`] = true;
              continue;
            }
            expandedDirs[dir] = true;
          }

          const selectedEntry = prev.explorer.selectedEntry;
          const nextSelectedEntry =
            selectedEntry && selectedEntry.path === fromPath
              ? { ...selectedEntry, path: toPath }
              : selectedEntry;

          const selectedPath = prev.explorer.selectedPath === fromPath ? toPath : prev.explorer.selectedPath;

          return {
            ...prev,
            explorer: {
              ...prev.explorer,
              expandedDirs,
              selectedEntry: nextSelectedEntry,
              selectedPath
            }
          };
        });

        setFilePreview((prev) => {
          if (!prev || prev.threadId !== op.threadId || prev.path !== fromPath) {
            return prev;
          }
          return { ...prev, path: toPath };
        });

        refreshExplorer(op.threadId, [pathDirname(toPath) || root, toPath]);
        closeFileOp();
        return;
      }

      if (op.kind === "delete") {
        const targetPath = op.path;
        const res = await window.tazhan.workspaceDelete({ scope, root, path: targetPath });
        if (!res.ok) {
          setFileOpError(res.error ?? "删除失败");
          return;
        }

        setFilePreview((prev) => {
          if (!prev || prev.threadId !== op.threadId) {
            return prev;
          }
          if (prev.path === targetPath) {
            return null;
          }
          if (op.entryKind === "dir" && prev.path.startsWith(targetPath) && (prev.path[targetPath.length] === "/" || prev.path[targetPath.length] === "\\")) {
            return null;
          }
          return prev;
        });

        updateThread(scope, op.threadId, (prev) => ({
          ...prev,
          explorer: {
            ...prev.explorer,
            selectedEntry:
              prev.explorer.selectedEntry && prev.explorer.selectedEntry.path === targetPath ? null : prev.explorer.selectedEntry,
            selectedPath: prev.explorer.selectedPath === targetPath ? null : prev.explorer.selectedPath,
            selectedContent: prev.explorer.selectedPath === targetPath ? "" : prev.explorer.selectedContent,
            selectedTruncated: prev.explorer.selectedPath === targetPath ? false : prev.explorer.selectedTruncated,
            selectedError: null
          }
        }));

        refreshExplorer(op.threadId, [pathDirname(targetPath) || root]);
        closeFileOp();
      }
    } catch (err) {
      setFileOpError(String(err));
    } finally {
      setFileOpBusy(false);
    }
  }

  function startEditingFilePreview(): void {
    setFilePreview((prev) => {
      if (!prev) {
        return prev;
      }
      const scope = remoteThreadsByIdRef.current[prev.threadId] ? "remote" : "local";
      const byId = scope === "remote" ? remoteThreadsByIdRef.current : threadsByIdRef.current;
      const thread = byId[prev.threadId] ?? null;
      const explorer = thread?.explorer ?? null;
      if (!thread || !explorer) {
        return prev;
      }
      if (explorer.loadingFile || explorer.selectedError || explorer.selectedTruncated) {
        return prev;
      }
      return { ...prev, mode: "edit", draft: explorer.selectedContent, error: null };
    });
  }

  function stopEditingFilePreview(): void {
    setFilePreview((prev) => {
      if (!prev) {
        return prev;
      }
      return { ...prev, mode: "view", draft: "", saving: false, error: null };
    });
  }

  async function saveFilePreview(): Promise<void> {
    const fp = filePreview;
    if (!fp) {
      return;
    }

    const scope = remoteThreadsByIdRef.current[fp.threadId] ? "remote" : "local";
    const byId = scope === "remote" ? remoteThreadsByIdRef.current : threadsByIdRef.current;
    const thread = byId[fp.threadId] ?? null;
    const root = thread?.meta.cwd?.trim() ?? "";
    if (!thread || !root) {
      setFilePreview((prev) => (prev ? { ...prev, error: "缺少工作区目录" } : prev));
      return;
    }
    if (thread.explorer.selectedTruncated) {
      setFilePreview((prev) => (prev ? { ...prev, error: "文件已截断，禁止直接编辑保存" } : prev));
      return;
    }

    setFilePreview((prev) => (prev ? { ...prev, saving: true, error: null } : prev));
    try {
      const res = await window.tazhan.workspaceWriteFile({ scope, root, path: fp.path, content: fp.draft });
      if (!res.ok) {
        setFilePreview((prev) => (prev ? { ...prev, saving: false, error: res.error ?? "保存失败" } : prev));
        return;
      }

      updateThread(scope, fp.threadId, (prev) => ({
        ...prev,
        explorer: {
          ...prev.explorer,
          selectedEntry: prev.explorer.selectedEntry ?? { path: fp.path, kind: "file" },
          selectedPath: fp.path,
          selectedContent: fp.draft,
          selectedTruncated: false,
          selectedError: null,
          loadingFile: false
        }
      }));

      setFilePreview((prev) => (prev ? { ...prev, mode: "view", saving: false, error: null } : prev));
      refreshExplorer(fp.threadId, [pathDirname(fp.path) || root]);
    } catch (err) {
      setFilePreview((prev) => (prev ? { ...prev, saving: false, error: String(err) } : prev));
    }
  }

  function renderCommandStatus(value: string, exitCode: number | null): JSX.Element {
    const normalized = String(value);
    if (normalized === "completed") {
      return <span className="badge ok">{exitCode === 0 ? "已完成" : `已完成(${exitCode ?? "?"})`}</span>;
    }
    if (normalized === "failed") {
      return <span className="badge bad">{`失败(${exitCode ?? "?"})`}</span>;
    }
    if (normalized === "declined") {
      return <span className="badge warn">已拒绝</span>;
    }
    return <span className="badge">执行中</span>;
  }

  function renderTerminalPanel(thread: ThreadState | null): JSX.Element {
    const commands = thread?.commands ?? [];
    if (commands.length === 0) {
      return <div className="empty">暂无终端输出</div>;
    }

    return (
      <div className="stack">
        {commands.map((c) => (
          <div key={c.itemId} className="cmdBlock">
            <div className="cmdHeader">
              {renderCommandStatus(c.status, c.exitCode)}
              <span className="cmdText">{c.command || "(command)"}</span>
            </div>
            <div className="cmdMeta">{c.cwd ? `cwd: ${c.cwd}` : ""}</div>
            <div className="termBox mono">{c.output || "（等待输出...）"}</div>
          </div>
        ))}
      </div>
    );
  }

  function renderFilePanel(thread: ThreadState | null): JSX.Element {
    const fileChanges = thread?.fileChanges ?? [];
    const expandedFiles = thread?.expandedFiles ?? {};
    if (fileChanges.length === 0) {
      return <div className="empty">暂无文件变更</div>;
    }

    return (
      <div className="stack">
        {fileChanges.map((fc) => (
          <div key={fc.itemId} className="fileBlock">
            <div className="fileHeader">
              <span className="badge">{fc.status || "inProgress"}</span>
              <span className="muted">{`item: ${fc.itemId}`}</span>
            </div>
            {fc.changes.map((ch) => {
              const key = `${fc.itemId}:${ch.path}`;
              const open = !!expandedFiles[key];
              return (
                <div key={key} className="fileRow">
                  <div className={patchKindClass(ch.kind)}>{patchKindLabel(ch.kind)}</div>
                  <div className="filePath">{ch.path}</div>
                  <button className="btn tiny" onClick={() => toggleFile(key)}>
                    {open ? "收起" : "展开"}
                  </button>
                  {open ? (
                    <div className="diffBox mono">
                      {ch.diff.split("\n").map((line, idx) => (
                        <div key={idx} className={diffLineClass(line)}>
                          {line.length === 0 ? " " : line}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  function renderUnifiedDiffPanel(thread: ThreadState | null): JSX.Element {
    const diff = thread?.turnDiff ?? "";
    if (!diff) {
      return <div className="empty">暂无统一 diff</div>;
    }
    return (
      <div className="diffBox mono">
        {diff.split("\n").map((line, idx) => (
          <div key={idx} className={diffLineClass(line)}>
            {line.length === 0 ? " " : line}
          </div>
        ))}
      </div>
    );
  }

  function activityItemTitle(item: any): string {
    const ty = String(item?.type ?? "");
    switch (ty) {
      case "commandExecution":
        return typeof item?.command === "string" && item.command.trim() ? item.command : "命令";
      case "fileChange": {
        const changes = Array.isArray(item?.changes) ? (item.changes as any[]) : [];
        if (changes.length === 0) {
          return "文件变更";
        }
        if (changes.length === 1) {
          const p = typeof changes[0]?.path === "string" ? changes[0].path : "";
          return p || "文件变更";
        }
        return `文件变更（${changes.length}）`;
      }
      case "mcpToolCall": {
        const server = typeof item?.server === "string" ? item.server : "";
        const tool = typeof item?.tool === "string" ? item.tool : "";
        return server && tool ? `${server} · ${tool}` : server || tool || "MCP 工具";
      }
      case "collabAgentToolCall": {
        const tool = typeof item?.tool === "string" ? item.tool : "";
        return tool ? `协作：${tool}` : "协作工具";
      }
      case "webSearch": {
        const q = typeof item?.query === "string" ? item.query : "";
        return q ? `搜索：${q}` : "搜索";
      }
      case "reasoning":
        return "思考摘要";
      case "plan":
        return "计划";
      case "imageView": {
        const p = typeof item?.path === "string" ? item.path : "";
        return p ? `查看图片：${p}` : "查看图片";
      }
      case "enteredReviewMode":
        return "进入 Review 模式";
      case "exitedReviewMode":
        return "退出 Review 模式";
      case "contextCompaction":
        return "上下文压缩";
      default:
        return ty || "事件";
    }
  }

  function activityItemStatusLabel(item: any): string {
    const status = String(item?.status ?? "");
    if (!status) {
      return "";
    }
    switch (status) {
      case "inProgress":
        return "进行中";
      case "completed":
        return "完成";
      case "failed":
        return "失败";
      case "declined":
        return "已拒绝";
      default:
        return status;
    }
  }

  function renderActivityPanel(activity: ActivitySource | null): JSX.Element {
    if (!activity) {
      return <div className="empty">暂无数据</div>;
    }

    const plan = activity.turnPlan;
    const error = activity.turnError;

    const items = activity.turnItemOrder
      .map((id) => activity.turnItemsById[id])
      .filter((it) => Boolean(it))
      .filter((it) => {
        const ty = String((it as any)?.type ?? "");
        return ty !== "userMessage" && ty !== "agentMessage";
      });

    return (
      <div className="activityRoot">
        {error ? (
          <div className="activityErrorBox">
            <div className="activityErrorTitle">错误</div>
            <div className="activityErrorText">{error.message}</div>
            {error.willRetry === true ? <div className="hint">将自动重试…</div> : null}
          </div>
        ) : null}

        {plan ? (
          <div className="activityPlanBox">
            <div className="activityPlanTitle">计划</div>
            {plan.explanation ? <div className="hint">{plan.explanation}</div> : null}
            {plan.plan.length ? (
              <div className="activityPlanList">
                {plan.plan.map((p, idx) => (
                  <div key={idx} className={`activityPlanStep status_${p.status}`}>
                    <span className="activityPlanStatus">{p.status}</span>
                    <span className="activityPlanText">{p.step}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted">暂无步骤</div>
            )}
          </div>
        ) : null}

        {items.length ? (
          <div className="activityList">
            {items.map((item) => {
              const itemId = typeof (item as any)?.id === "string" ? (item as any).id : "";
              const ty = String((item as any)?.type ?? "");
              const status = activityItemStatusLabel(item);
              const title = activityItemTitle(item);
              const detail =
                ty === "reasoning"
                  ? Array.isArray((item as any)?.summary)
                    ? ((item as any).summary as any[]).filter((s) => typeof s === "string").join("\n")
                    : ""
                  : ty === "plan"
                    ? typeof (item as any)?.text === "string"
                      ? String((item as any).text)
                      : ""
                    : ty === "mcpToolCall"
                      ? Array.isArray((item as any)?.progressMessages)
                        ? ((item as any).progressMessages as any[]).slice(-3).join("\n")
                        : ""
                      : ty === "fileChange"
                        ? typeof (item as any)?.output === "string"
                          ? String((item as any).output).trim()
                          : ""
                        : "";

              return (
                <div key={itemId || title} className="activityItem">
                  <div className="activityItemTop">
                    <div className="activityItemTitle">{title}</div>
                    {status ? <span className={`activityItemStatus status_${String((item as any)?.status ?? "")}`}>{status}</span> : null}
                  </div>
                  {detail.trim() ? <pre className="activityItemDetail">{detail}</pre> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty">暂无过程信息</div>
        )}
      </div>
    );
  }

  function activityVisibleItems(activity: ActivitySource): any[] {
    return activity.turnItemOrder
      .map((id) => activity.turnItemsById[id])
      .filter((it) => Boolean(it))
      .filter((it) => {
        const ty = String((it as any)?.type ?? "");
        return ty !== "userMessage" && ty !== "agentMessage";
      });
  }

  function planStatusLabel(value: TurnPlanStep["status"]): string {
    switch (value) {
      case "pending":
        return "待办";
      case "inProgress":
        return "进行中";
      case "completed":
        return "已完成";
    }
  }

  function renderTurnProcessInline(activity: ActivitySource, isActiveTurn: boolean): JSX.Element {
    const plan = activity.turnPlan;
    const error = activity.turnError;
    const items = activityVisibleItems(activity);

    type Row = { key: string; kind: "error" | "normal"; text: string; detail: string };
    const rows: Row[] = [];

    if (error?.message?.trim()) {
      rows.push({ key: "error", kind: "error", text: `错误：${error.message.trim()}`, detail: "" });
    }

    if (plan) {
      const expl = plan.explanation?.trim() ?? "";
      if (expl) {
        rows.push({ key: "plan_expl", kind: "normal", text: expl, detail: "" });
      }

      for (let i = 0; i < plan.plan.length; i++) {
        const p = plan.plan[i];
        const step = p.step?.trim() ?? "";
        if (!step) {
          continue;
        }
        rows.push({
          key: `plan_${i}`,
          kind: "normal",
          text: step,
          detail: planStatusLabel(p.status)
        });
      }
    }

    for (const item of items) {
      const ty = String((item as any)?.type ?? "");

      if (ty === "reasoning") {
        const summary = Array.isArray((item as any)?.summary)
          ? ((item as any).summary as any[]).filter((s) => typeof s === "string").join("\n").trim()
          : "";
        if (summary) {
          rows.push({ key: `reasoning_${String((item as any)?.id ?? "")}`, kind: "normal", text: summary, detail: "" });
        }
        continue;
      }

      const status = activityItemStatusLabel(item);
      const title = activityItemTitle(item);
      const detail =
        ty === "mcpToolCall"
          ? Array.isArray((item as any)?.progressMessages)
            ? ((item as any).progressMessages as any[]).slice(-3).join("\n").trim()
            : ""
          : "";
      rows.push({
        key: `item_${String((item as any)?.id ?? title)}`,
        kind: "normal",
        text: status ? `${title}（${status}）` : title,
        detail
      });
    }

    if (rows.length === 0) {
      return <div className="turnProcessEmpty">{isActiveTurn ? "正在生成过程信息…" : "暂无过程信息"}</div>;
    }

    return (
      <ul className="turnProcessList">
        {rows.map((r) => (
          <li key={r.key} className={r.kind === "error" ? "turnProcessItem error" : "turnProcessItem"}>
            <div className="turnProcessItemText">{renderMessageText(r.text)}</div>
            {r.detail ? <div className="turnProcessItemDetail">{r.detail}</div> : null}
          </li>
        ))}
      </ul>
    );
  }

  function renderToolPanel(): JSX.Element {
    if (!activeThread) {
      return <div className="empty">请选择一个会话</div>;
    }

    switch (toolTab) {
      case "activity":
        return renderActivityPanel(activeThread);
      case "terminal":
        return renderTerminalPanel(activeThread);
      case "files":
        return renderFilePanel(activeThread);
      case "diff":
        return renderUnifiedDiffPanel(activeThread);
      case "log":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--panel)",
                paddingBottom: 10,
                borderBottom: "1px solid var(--border)"
              }}
            >
              <div className="row" style={{ alignItems: "center" }}>
                <input
                  value={logQuery}
                  onChange={(e) => setLogQuery(e.target.value)}
                  placeholder="过滤日志（空格分词，全部命中才显示）"
                  style={{ flex: 1, width: "auto", minWidth: 0 }}
                />
                <button className="btn tiny" onClick={() => setLogQuery("[relay]")} type="button">
                  Relay
                </button>
                <button className="btn tiny" onClick={() => setLogQuery("error")} type="button">
                  Error
                </button>
                <button className="btn tiny" onClick={() => setLogQuery("")} disabled={!logQuery.trim()} type="button">
                  清空
                </button>
              </div>
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                {filteredEventLog.length}/{eventLog.length}
              </div>
            </div>

            <div className="mono">{filteredEventLog.join("\n")}</div>
          </div>
        );
    }
  }

  function renderThreadList(): JSX.Element {
    const order = viewThreadOrder;
    const byId = viewThreadsById;
    const activeId = viewActiveThreadId;
    const scope = viewScope;
    const cursor = viewThreadListCursor;

    const orderOrActive = order.length > 0 ? order : activeId ? [activeId] : [];
    if (orderOrActive.length === 0) {
      return <div className="empty">暂无会话（连接后可加载历史）</div>;
    }

    const query = threadSearch.trim().toLowerCase();
    const filteredIds = query
      ? orderOrActive.filter((id) => {
          const thread = byId[id] ?? makeThreadState(id);
          const cwd = thread.meta.cwd.trim();
          const alias = cwd.length > 0 ? (settings?.workspaceNames[cwdKey(cwd)]?.trim() ?? "") : "";
          const title = alias.length > 0 ? alias : cwd.length > 0 ? cwd : thread.meta.preview.trim().length > 0 ? thread.meta.preview : "新建对话";
          return (
            title.toLowerCase().includes(query) ||
            alias.toLowerCase().includes(query) ||
            thread.meta.preview.toLowerCase().includes(query) ||
            thread.meta.cwd.toLowerCase().includes(query) ||
            thread.meta.id.toLowerCase().includes(query)
          );
        })
      : orderOrActive;

    const ids = query
      ? filteredIds
      : (() => {
          const byKey = new Map<string, string>();
          for (const id of filteredIds) {
            const thread = byId[id] ?? makeThreadState(id);
            const cwd = thread.meta.cwd.trim();
            const key = cwd.length > 0 ? `cwd:${cwdKey(cwd)}` : `id:${thread.meta.id.trim().toLowerCase()}`;
            if (!byKey.has(key)) {
              byKey.set(key, id);
            }
          }

          if (activeId) {
            const activeThread = byId[activeId] ?? makeThreadState(activeId);
            const cwd = activeThread.meta.cwd.trim();
            const key = cwd.length > 0 ? `cwd:${cwdKey(cwd)}` : `id:${activeThread.meta.id.trim().toLowerCase()}`;
            byKey.set(key, activeId);
          }

          return Array.from(byKey.values());
        })();

    if (ids.length === 0) {
      return <div className="empty">没有匹配的会话</div>;
    }

    const nowMs = clockMs;
    const rows: JSX.Element[] = [];

    function pushThreadRow(id: string): void {
      const thread = byId[id] ?? makeThreadState(id);

      const cwd = thread.meta.cwd.trim();
      const alias = cwd.length > 0 ? (settings?.workspaceNames[cwdKey(cwd)]?.trim() ?? "") : "";
      const previewRaw = thread.meta.preview.trim();
      const preview = previewRaw === "New chat" ? "" : previewRaw;
      const title = alias.length > 0 ? alias : cwd.length > 0 ? cwd : preview.length > 0 ? preview : "新建对话";
      const active = activeId === id;
      const notify = threadNotifyEnabled(id);
      const statusLine = threadStatusLine(thread, nowMs);

      rows.push(
        <div
          key={id}
          className={active ? "threadRow active" : "threadRow"}
          role="button"
          tabIndex={0}
          onClick={() => void openThread(scope, id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void openThread(scope, id);
            }
          }}
        >
          <div className="threadRowMain">
            <div className="threadRowTitle">
              {thread.running ? <span className="runDot" aria-label="running" /> : null}
              <span className="threadRowTitleText">{title}</span>
            </div>
            {alias.length > 0 && cwd.length > 0 ? (
              <div className="threadRowSub">{cwd}</div>
            ) : preview.length > 0 && preview !== title ? (
              <div className="threadRowSub">{preview}</div>
            ) : null}
            <div className="threadRowSub threadRowStatus">{statusLine}</div>
          </div>
          <div className="threadRowRight">
            {thread.running ? <span className="pillRun">{threadStatusPillLabel(thread, nowMs)}</span> : null}
            <button
              className={notify ? "threadMenuBtn on" : "threadMenuBtn"}
              onClick={(e) => {
                e.stopPropagation();
                setThreadMenuOpenId((prev) => (prev === id ? null : id));
              }}
              title="更多"
              type="button"
            >
              <Icon name="more" />
            </button>

            {threadMenuOpenId === id ? (
              <div className="threadMenu" onClick={(e) => e.stopPropagation()}>
                <button
                  className="threadMenuItem"
                  onClick={() => {
                    setThreadMenuOpenId(null);
                    openRenameThread(id);
                  }}
                  type="button"
                >
                  重命名项目
                </button>
                <button
                  className="threadMenuItem"
                  onClick={async () => {
                    setThreadMenuOpenId(null);
                    const cwd = byId[id]?.meta.cwd?.trim() ?? "";
                    if (!cwd) {
                      return;
                    }
                    if (scope === "remote") {
                      const res = await window.tazhan.remoteOpenInTerminal({ cwd });
                      if (!res.ok) {
                        appendLog(`[warn] 打开云端终端失败: ${res.error ?? "unknown error"}`);
                      }
                      return;
                    }

                    const res = await window.tazhan.openInTerminal(cwd);
                    if (!res.ok) {
                      appendLog(`[warn] 打开终端失败: ${res.error ?? "unknown error"}`);
                    }
                  }}
                  type="button"
                  disabled={!(byId[id]?.meta.cwd?.trim() ?? "") || (scope === "remote" && !remoteStatus?.connected)}
                >
                  在终端打开项目
                </button>
                {scope !== "remote" ? (
                  <button
                    className="threadMenuItem"
                    onClick={async () => {
                      setThreadMenuOpenId(null);
                      const cwd = byId[id]?.meta.cwd?.trim() ?? "";
                      if (!cwd) {
                        return;
                      }
                      const res = await window.tazhan.openInExplorer(cwd);
                      if (!res.ok) {
                        appendLog(`[warn] 打开资源管理器失败: ${res.error ?? "unknown error"}`);
                      }
                    }}
                    type="button"
                    disabled={!(byId[id]?.meta.cwd?.trim() ?? "")}
                  >
                    在资源管理器中打开项目
                  </button>
                ) : null}
                <button
                  className="threadMenuItem"
                  onClick={() => {
                    setThreadMenuOpenId(null);
                    void toggleThreadNotify(id);
                  }}
                  type="button"
                >
                  {notify ? "关闭回合完成提醒" : "开启回合完成提醒"}
                </button>
                <button
                  className="threadMenuItem"
                  onClick={async () => {
                    setThreadMenuOpenId(null);
                    try {
                      await navigator.clipboard.writeText(id);
                    } catch {
                    }
                  }}
                  type="button"
                >
                  复制会话 ID
                </button>
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    const runningIds = ids.filter((id) => byId[id]?.running);
    if (runningIds.length > 0) {
      rows.push(
        <div key="group_running" className="threadGroup runningGroup">
          运行中（{runningIds.length}）
        </div>
      );
      for (const id of runningIds) {
        pushThreadRow(id);
      }
    }

    const idleIds = ids.filter((id) => !byId[id]?.running);
    let lastGroup = "";
    for (const id of idleIds) {
      const thread = byId[id] ?? null;
      if (!thread) {
        continue;
      }

      const ts = thread.meta.updatedAt || thread.meta.createdAt;
      const group = threadGroupLabel(ts);
      if (group !== lastGroup) {
        rows.push(
          <div key={`group_${group}_${id}`} className="threadGroup">
            {group}
          </div>
        );
        lastGroup = group;
      }
      pushThreadRow(id);
    }

    return (
      <div className="threadList">
        {rows}

        {cursor ? (
          <button className="btn" onClick={() => void loadMoreThreads(scope)}>
            加载更多
          </button>
        ) : null}
      </div>
    );
  }

  function renderSidebarExplorer(): JSX.Element {
    if (!viewActiveThreadId) {
      return <div className="empty">请选择一个会话后查看文件</div>;
    }

    const thread = viewThreadsById[viewActiveThreadId] ?? null;
    if (!thread) {
      return <div className="empty">请选择一个会话后查看文件</div>;
    }

    const threadId = thread.meta.id;
    const root = thread.meta.cwd.trim();
    if (!root) {
      return <div className="empty">当前会话未配置工作区目录</div>;
    }

    const explorer = thread.explorer;
    const rootName = (() => {
      const normalized = root.replaceAll("\\", "/");
      const parts = normalized.split("/").filter(Boolean);
      return parts[parts.length - 1] ?? root;
    })();
    const rootEntry: ExplorerEntry = { name: rootName, path: root, kind: "dir" };

    function renderDir(dirPath: string, depth: number): JSX.Element[] {
      const items = explorer.entriesByDir[dirPath] ?? null;
      const rows: JSX.Element[] = [];

      if (!items) {
        if (explorer.loadingDirs[dirPath]) {
          rows.push(
            <div key={`${dirPath}:loading`} className="explorerLoadingRow" style={{ paddingLeft: 10 + depth * 14 }}>
              加载中…
            </div>
          );
        }
        return rows;
      }

      for (const it of items) {
        const indent = 10 + depth * 14;
        const isDir = it.kind === "dir";
        const expanded = Boolean(explorer.expandedDirs[it.path]);
        const selected = !isDir && explorer.selectedPath === it.path;
        const loading = Boolean(explorer.loadingDirs[it.path]);
        const loaded = isDir && Boolean(explorer.entriesByDir[it.path]);

        rows.push(
          <React.Fragment key={it.path}>
            <button
              className={selected ? "explorerRow active" : "explorerRow"}
              style={{ paddingLeft: indent }}
              onClick={() => {
                if (isDir) {
                  explorerToggleDir(viewScope, threadId, it.path);
                } else {
                  setFilePreview({ threadId, path: it.path, mode: "view", draft: "", saving: false, error: null });
                  void explorerSelectFile(viewScope, threadId, it.path);
                }
              }}
              onContextMenu={(e) => openExplorerContextMenu(e, threadId, root, it)}
              type="button"
              title={it.path}
            >
              <span className="explorerChevron" aria-hidden="true">
                {isDir ? (expanded ? "▾" : "▸") : ""}
              </span>
              <span className={isDir ? "explorerIcon folder" : "explorerIcon file"} aria-hidden="true" />
              <span className="explorerName">{it.name}</span>
              {isDir && loading && !loaded ? <span className="explorerLoading">加载中…</span> : null}
            </button>
            {isDir && expanded ? renderDir(it.path, depth + 1) : null}
          </React.Fragment>
        );
      }

      return rows;
    }

    const rootExpanded = Boolean(explorer.expandedDirs[root]);
    const rootLoading = Boolean(explorer.loadingDirs[root]);
    const rootLoaded = Boolean(explorer.entriesByDir[root]);

    return (
      <div
        className="sidebarExplorer"
        onContextMenu={(e) => {
          if (!(e.target instanceof Element)) {
            return;
          }
          if (e.target.closest(".explorerRow")) {
            return;
          }
          openExplorerContextMenu(e, threadId, root, rootEntry);
        }}
      >
        <button
          className="explorerRow root"
          onClick={() => explorerToggleDir(viewScope, threadId, root)}
          onContextMenu={(e) => openExplorerContextMenu(e, threadId, root, rootEntry)}
          type="button"
          title={root}
        >
          <span className="explorerChevron" aria-hidden="true">
            {rootExpanded ? "▾" : "▸"}
          </span>
          <span className="explorerIcon folder" aria-hidden="true" />
          <span className="explorerName">{rootName}</span>
          {rootLoading && !rootLoaded ? <span className="explorerLoading">加载中…</span> : null}
        </button>
        {rootExpanded ? renderDir(root, 1) : null}
      </div>
    );
  }

  function renderChatPanel(): JSX.Element {
    const thread = activeThread;

    if (newChatOpen) {
      const title = cwdLabel(newChatCwd);
      const modelLabel = (() => {
        const configured = newChatModel.trim();
        if (configured.length > 0) {
          const m = models.find((x) => x.id === configured) ?? null;
          if (m) {
            return m.displayName?.trim().length ? `${m.displayName}（${m.id}）` : m.id;
          }
          return configured;
        }
        return newChatEffectiveModel ? `自动（${newChatEffectiveModel.id}）` : "自动（连接后获取）";
      })();

      const effortLabel = (() => {
        const configured = newChatReasoningEffort;
        if (!configured) {
          return newChatEffectiveModel ? `默认（${reasoningEffortLabel(newChatEffectiveModel.defaultReasoningEffort)}）` : "默认";
        }
        return `${reasoningEffortLabel(configured)}（${configured}）`;
      })();

      const normalizedCwd = newChatCwd.trim().toLowerCase();
      const nowMs = clockMs;
      const resumeThreads =
        normalizedCwd.length > 0
          ? threadOrder
              .map((id) => threadsById[id])
              .filter((t): t is ThreadState => Boolean(t))
              .filter((t) => t.meta.cwd.trim().toLowerCase() === normalizedCwd)
              .slice(0, 6)
          : [];

      if (newChatResumeThreadId && !resumeThreads.some((t) => t.meta.id === newChatResumeThreadId)) {
        setNewChatResumeThreadId(null);
      }

      return (
        <div className="modalOverlay" onClick={() => cancelNewChatSetup()}>
          <div className="modal newChatModal" onClick={(e) => e.stopPropagation()}>
            <div className="newChatCard">
            <div className="newChatHeader">
              <div className="newChatTitle">{title}</div>
              <div className="sidebarStatus">
                <span className={statusDotClass(status)} />
                <span className="muted">{statusLabel(status)}</span>
              </div>
            </div>

            <div className="newChatBody">
              <div className="newChatGrid">
                <div className={resumeThreads.length > 0 ? "newChatConfigGrid" : "newChatConfigGrid oneCol"}>
                  <div className="stack">
                    <div className="field">
                      <div className="label">工作目录（cwd）</div>
                      <div className="row">
                        <input
                          value={newChatCwd}
                          placeholder="请选择一个文件夹..."
                          onChange={(e) => setNewChatCwd(e.target.value)}
                        />
                        <button className="btn" onClick={() => void pickWorkspace()} type="button">
                          选择
                        </button>
                      </div>
                    </div>

                    <div className="newChatOptionsGrid">
                      <div className="field">
                        <div className="label">模型</div>
                        <div className="menuWrap newChatMenuWrap">
                          <button
                            className="pickerBtn"
                            type="button"
                            onClick={() => setNewChatMenuOpen((v) => (v === "model" ? null : "model"))}
                            title={modelLabel}
                          >
                            <span className="pickerText">{modelLabel}</span>
                            <span className="chev" aria-hidden="true">
                              ▾
                            </span>
                          </button>

                          {newChatMenuOpen === "model" ? (
                            <div className="popMenu">
                              <div className="popMenuSection">模型</div>
                              <button
                                className={newChatModel.trim().length === 0 ? "popMenuItem active" : "popMenuItem"}
                                onClick={() => {
                                  chooseModel("");
                                  setNewChatMenuOpen(null);
                                }}
                                type="button"
                              >
                                自动（Codex 默认）
                              </button>
                              {models.map((m) => {
                                const label = m.displayName?.trim().length ? `${m.displayName}（${m.id}）` : m.id;
                                const active = newChatModel.trim() === m.id;
                                return (
                                  <button
                                    key={m.id}
                                    className={active ? "popMenuItem active" : "popMenuItem"}
                                    onClick={() => {
                                      chooseModel(m.id);
                                      setNewChatMenuOpen(null);
                                    }}
                                    type="button"
                                  >
                                    {label}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="field">
                        <div className="label">思考强度</div>
                        <div className="menuWrap newChatMenuWrap">
                          <button
                            className="pickerBtn"
                            type="button"
                            onClick={() => setNewChatMenuOpen((v) => (v === "effort" ? null : "effort"))}
                            title={effortLabel}
                          >
                            <span className="pickerText">{effortLabel}</span>
                            <span className="chev" aria-hidden="true">
                              ▾
                            </span>
                          </button>

                          {newChatMenuOpen === "effort" ? (
                            <div className="popMenu">
                              <div className="popMenuSection">思考强度</div>
                              <button
                                className={!newChatReasoningEffort ? "popMenuItem active" : "popMenuItem"}
                                onClick={() => {
                                  setNewChatReasoningEffort("");
                                  setNewChatMenuOpen(null);
                                }}
                                type="button"
                              >
                                默认
                              </button>
                              {(newChatEffectiveModel?.supportedReasoningEfforts?.length
                                ? newChatEffectiveModel.supportedReasoningEfforts.map((opt) => opt.reasoningEffort)
                                : genericEfforts
                              ).map((effort) => {
                                const active = newChatReasoningEffort === effort;
                                return (
                                  <button
                                    key={effort}
                                    className={active ? "popMenuItem active" : "popMenuItem"}
                                    onClick={() => {
                                      setNewChatReasoningEffort(effort);
                                      setNewChatMenuOpen(null);
                                    }}
                                    type="button"
                                  >
                                    {`${reasoningEffortLabel(effort)}（${effort}）`}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="field">
                        <div className="label">沙箱/权限</div>
                        <div className="menuWrap newChatMenuWrap">
                          <button
                            className="pickerBtn"
                            type="button"
                            onClick={() => setNewChatMenuOpen((v) => (v === "sandbox" ? null : "sandbox"))}
                            title={sandboxModeLabel(newChatSandbox)}
                          >
                            <span className="pickerText">{sandboxModeShortLabel(newChatSandbox)}</span>
                            <span className="chev" aria-hidden="true">
                              ▾
                            </span>
                          </button>

                          {newChatMenuOpen === "sandbox" ? (
                            <div className="popMenu">
                              <div className="popMenuSection">沙箱/权限</div>
                              {sandboxes.map((s) => {
                                const active = newChatSandbox === s;
                                return (
                                  <button
                                    key={s}
                                    className={active ? "popMenuItem active" : "popMenuItem"}
                                    onClick={() => {
                                      setNewChatSandbox(s);
                                      setNewChatMenuOpen(null);
                                    }}
                                    type="button"
                                  >
                                    {sandboxModeLabel(s)}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="field">
                        <div className="label">审批策略</div>
                        <div className="menuWrap newChatMenuWrap">
                          <button
                            className="pickerBtn"
                            type="button"
                            onClick={() => setNewChatMenuOpen((v) => (v === "approval" ? null : "approval"))}
                            title={approvalPolicyLabel(newChatApprovalPolicy)}
                          >
                            <span className="pickerText">{approvalPolicyShortLabel(newChatApprovalPolicy)}</span>
                            <span className="chev" aria-hidden="true">
                              ▾
                            </span>
                          </button>

                          {newChatMenuOpen === "approval" ? (
                            <div className="popMenu">
                              <div className="popMenuSection">审批策略</div>
                              {approvalPolicies.map((p) => {
                                const active = newChatApprovalPolicy === p;
                                return (
                                  <button
                                    key={p}
                                    className={active ? "popMenuItem active" : "popMenuItem"}
                                    onClick={() => {
                                      setNewChatApprovalPolicy(p);
                                      setNewChatMenuOpen(null);
                                    }}
                                    type="button"
                                  >
                                    {approvalPolicyLabel(p)}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="field">
                      <div className="label">回合完成提醒</div>
                      <button
                        className={newChatNotify ? "btn primary" : "btn"}
                        onClick={() => setNewChatNotify((v) => !v)}
                        type="button"
                      >
                        {newChatNotify ? "开启" : "关闭"}
                      </button>
                      <div className="hint">可在会话列表里对单个会话再切换</div>
                    </div>
                  </div>

                  {resumeThreads.length > 0 ? (
                    <div className="resumeBox">
                      <div className="resumeTitle">{`恢复历史（${resumeThreads.length}）`}</div>
                      <div className="resumeList">
                        {resumeThreads.map((t) => {
                          const preview = t.meta.preview.trim() === "New chat" ? "" : t.meta.preview.trim();
                          const sub = preview.length > 0 ? preview : threadStatusLine(t, nowMs);
                          const active = newChatResumeThreadId === t.meta.id;
                          return (
                            <button
                              key={t.meta.id}
                              className={active ? "resumeRow active" : "resumeRow"}
                              onClick={() => setNewChatResumeThreadId(t.meta.id)}
                              type="button"
                              title={t.meta.id}
                            >
                              <div className="resumeRowTitle">{t.meta.id}</div>
                              <div className="resumeRowSub">{sub}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="field">
                  <div className="label">首条消息（可选）</div>
                  <textarea
                    className="newChatFirstMessage"
                    value={newChatDraftMessage}
                    placeholder="描述你要做的任务..."
                    onChange={(e) => setNewChatDraftMessage(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="newChatFooter">
              <button className="btn" onClick={() => cancelNewChatSetup()}>
                返回
              </button>
              <button className="btn" onClick={() => void connect()} disabled={status === "connected"}>
                {status === "connected" ? "已连接" : "连接"}
              </button>
              <button
                className="btn primary"
                onClick={() => (newChatResumeThreadId ? void resumeFromNewChat(newChatResumeThreadId) : void confirmNewChat())}
                disabled={!newChatCwd.trim() || status !== "connected"}
                title={status !== "connected" ? "请先连接 Codex" : ""}
              >
                {newChatResumeThreadId ? "恢复" : "开始"}
              </button>
            </div>
          </div>
        </div>
      </div>
      );
    }

    if (!thread) {
      return (
        <div className="chatIdle">
          <div className="chatIdleTitle">没有活动会话</div>
          <div className="chatIdleSub">点击左侧“新建对话”，配置工作区后开始。</div>
        </div>
      );
    }

    const activeModelId = (thread.config.model ?? settings?.model ?? "").trim();
    const activeModel =
      activeModelId.length > 0 ? viewModels.find((m) => m.id === activeModelId) ?? null : effectiveModel ?? null;
    const activeModelLabel = activeModel
      ? activeModel.displayName?.trim().length > 0
        ? activeModel.displayName
        : activeModel.id
      : "模型（连接后自动获取）";
    const activeEffort = (thread?.config.reasoningEffort ?? settings?.reasoningEffort ?? "") as ReasoningEffort | "";
    const workspaceTitle = (() => {
      const cwd = thread.meta.cwd.trim();
      if (!cwd) {
        return "未选择工作区";
      }
      const alias = settings?.workspaceNames[cwdKey(cwd)]?.trim() ?? "";
      return alias.length > 0 ? alias : cwdLabel(cwd);
    })();

    const contextLeft = (() => {
      const usage = thread.tokenUsage;
      const used = usage?.totalTokens ?? null;
      const contextWindow = usage?.modelContextWindow ?? null;
      if (used === null || contextWindow === null || contextWindow <= 0) {
        return null;
      }
      const left = Math.max(0, contextWindow - used);
      const pct = Math.round((left / contextWindow) * 100);
      return {
        pct: Math.max(0, Math.min(100, pct)),
        used,
        window: contextWindow
      };
    })();

    const composerModelLabel = (() => {
      if (activeModel) {
        return activeModel.displayName?.trim().length ? activeModel.displayName : activeModel.id;
      }
      if (activeModelId.length > 0) {
        return activeModelId;
      }
      return "自动";
    })();
    const composerEffortLabel = activeEffort ? reasoningEffortLabel(activeEffort) : "默认";
    const composerModelPickerLabel = `${composerModelLabel} · ${composerEffortLabel}`;
    const composerPolicyPickerLabel = `${sandboxModeShortLabel(thread.config.sandbox)} · ${approvalPolicyShortLabel(
      thread.config.approvalPolicy
    )}`;

    const autoReplyCfg = settings?.autoReply ?? { enabled: false, message: "", mode: "infinite", times: 1 };
    const autoReplyTimes = clamp(Math.floor(autoReplyCfg.times || 1), 1, 999);
    const autoReplyRuntime =
      viewActiveThreadId
        ? viewScope === "remote"
          ? (remoteAutoReplyRuntimeByThreadId[viewActiveThreadId] ?? null)
          : (autoReplyRuntimeByThreadId[viewActiveThreadId] ?? null)
        : null;
    const autoReplyRemaining =
      autoReplyCfg.mode === "times"
        ? typeof autoReplyRuntime?.remaining === "number"
          ? autoReplyRuntime.remaining
          : autoReplyTimes
        : null;
    const composerAutoReplyPickerLabel = (() => {
      if (!autoReplyCfg.enabled) {
        return "自动回复：关";
      }
      if (autoReplyCfg.mode === "infinite") {
        return "自动回复：∞";
      }
      return `自动回复：${autoReplyRemaining ?? 0}/${autoReplyTimes}`;
    })();

    const composerSkillPickerLabel = (() => {
      if (!activeSkill) {
        return "技能 · 无";
      }
      if (activeSkill.kind === "interview") {
        const asked = interviewQa.length;
        const maxQ = clamp(Math.floor(interviewMaxQuestions || activeSkill.maxQuestions), 1, 30);
        return `技能 · ${activeSkill.title} · 开 · ${asked}/${maxQ}`;
      }
      return `技能 · ${activeSkill.title} · 开`;
    })();

    function openComposerAutoReplyMenu(): void {
      setAutoReplyEnabledDraft(autoReplyCfg.enabled);
      setAutoReplyMessageDraft(autoReplyCfg.message);
      setAutoReplyModeDraft(autoReplyCfg.mode);
      setAutoReplyTimesDraft(autoReplyTimes);
      setComposerMenuOpen((v) => (v === "autoReply" ? null : "autoReply"));
      setWorkspaceMenuOpen(false);
      setMoreMenuOpen(false);
    }

    async function applyAutoReplyDraft(): Promise<void> {
      const nextTimes = clamp(Math.floor(autoReplyTimesDraft || 1), 1, 999);
      await saveSettingsPatch({
        autoReply: {
          enabled: autoReplyEnabledDraft,
          message: autoReplyMessageDraft,
          mode: autoReplyModeDraft,
          times: nextTimes
        }
      });

      if (viewActiveThreadId) {
        const setRuntime = viewScope === "remote" ? setRemoteAutoReplyRuntimeByThreadId : setAutoReplyRuntimeByThreadId;
        setRuntime((prev) => ({
          ...prev,
          [viewActiveThreadId]: {
            remaining: autoReplyEnabledDraft && autoReplyModeDraft === "times" ? nextTimes : null,
            pendingTurnId: null
          }
        }));
      }

      setComposerMenuOpen(null);
    }

    function resetAutoReplyForActiveThread(): void {
      if (!viewActiveThreadId) {
        return;
      }
      const nextTimes = clamp(Math.floor(autoReplyTimesDraft || 1), 1, 999);
      const setRuntime = viewScope === "remote" ? setRemoteAutoReplyRuntimeByThreadId : setAutoReplyRuntimeByThreadId;
      setRuntime((prev) => ({
        ...prev,
        [viewActiveThreadId]: {
          remaining: autoReplyModeDraft === "times" ? nextTimes : null,
          pendingTurnId: null
        }
      }));
    }

    function applyActiveModel(nextModelId: string): void {
      const modelId = nextModelId.trim();
      const selected =
        modelId.length > 0
          ? viewModels.find((m) => m.id === modelId) ?? null
          : viewModels.find((m) => m.isDefault) ?? null;

      let nextEffort = activeEffort;
      if (
        nextEffort &&
        selected &&
        selected.supportedReasoningEfforts.length > 0 &&
        !selected.supportedReasoningEfforts.some((opt) => opt.reasoningEffort === nextEffort)
      ) {
        nextEffort = "";
      }

      if (viewActiveThreadId) {
        updateThread(viewScope, viewActiveThreadId, (prev) => ({
          ...prev,
          config: { ...prev.config, model: modelId, reasoningEffort: nextEffort }
        }));
      }

      void saveSettingsPatch({ model: modelId, reasoningEffort: nextEffort });
      void syncCodexModelConfig(modelId);
      setWorkspaceMenuOpen(false);
    }

    function applyActiveEffort(nextEffort: ReasoningEffort | ""): void {
      if (
        nextEffort &&
        activeModel?.supportedReasoningEfforts?.length &&
        !activeModel.supportedReasoningEfforts.some((opt) => opt.reasoningEffort === nextEffort)
      ) {
        return;
      }

      if (viewActiveThreadId) {
        updateThread(viewScope, viewActiveThreadId, (prev) => ({
          ...prev,
          config: { ...prev.config, reasoningEffort: nextEffort }
        }));
      }

      void saveSettingsPatch({ reasoningEffort: nextEffort });
      setWorkspaceMenuOpen(false);
    }

    function applyActiveSandbox(nextSandbox: SandboxMode): void {
      if (viewActiveThreadId) {
        updateThread(viewScope, viewActiveThreadId, (prev) => ({
          ...prev,
          config: { ...prev.config, sandbox: nextSandbox }
        }));
      }

      void saveSettingsPatch({ sandbox: nextSandbox });
    }

    function applyActiveApprovalPolicy(nextApprovalPolicy: ApprovalPolicy): void {
      if (viewActiveThreadId) {
        updateThread(viewScope, viewActiveThreadId, (prev) => ({
          ...prev,
          config: { ...prev.config, approvalPolicy: nextApprovalPolicy }
        }));
      }

      void saveSettingsPatch({ approvalPolicy: nextApprovalPolicy });
    }

    const lastAssistantMessageIdByTurnId = new Map<string, string>();
    for (const m of thread.messages) {
      if (m.role === "assistant" && m.turnId.trim()) {
        lastAssistantMessageIdByTurnId.set(m.turnId, m.id);
      }
    }

    return (
      <div className="chatWrap">
        <div className="chatTopBar">
          <div className="chatTopBarLeft">
            <button
              className="topIconBtn"
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
              aria-label="Toggle sidebar"
              type="button"
            >
              <Icon name="sidebar" />
            </button>
            <div className="chatTitleWrap">
              <div className="menuWrap">
                <button
                  ref={workspaceBtnRef}
                  className="modelBtn"
                  type="button"
                  onClick={() => {
                    setWorkspaceMenuOpen((v) => !v);
                    setMoreMenuOpen(false);
                  }}
                  title={thread.meta.cwd || ""}
                >
                  {workspaceTitle}
                  <span className="chev" aria-hidden="true">
                    ▾
                  </span>
                </button>

                {workspaceMenuOpen ? (
                  <div ref={workspaceMenuRef} className="popMenu">
                    <button
                      className="popMenuItem"
                      onClick={() => {
                        setWorkspaceMenuOpen(false);
                        const cwd = thread.meta.cwd.trim();
                        if (!cwd) {
                          startNewChat();
                          return;
                        }
                        void withNewThreadBusy(async () => {
                          await startThreadInCwd(viewScope, {
                            cwd,
                            model: thread.config.model,
                            approvalPolicy: thread.config.approvalPolicy,
                            sandbox: thread.config.sandbox,
                            reasoningEffort: thread.config.reasoningEffort,
                            notify: threadNotifyEnabled(thread.meta.id)
                          });
                        });
                      }}
                      type="button"
                      disabled={newThreadBusy}
                    >
                      {newThreadBusy ? "新建会话（创建中…）" : "新建会话"}
                    </button>
                    <div className="popMenuDivider" />
                    <div className="popMenuSection">历史会话</div>
                    {thread.meta.cwd.trim().length === 0 ? (
                      <button className="popMenuItem" type="button" disabled>
                        当前会话未设置工作目录
                      </button>
                    ) : (
                      viewThreadOrder
                        .map((id) => viewThreadsById[id])
                        .filter((t): t is ThreadState => Boolean(t))
                        .filter((t) => t.meta.cwd.trim().toLowerCase() === thread.meta.cwd.trim().toLowerCase())
                        .slice(0, 12)
                        .map((t) => {
                          const previewRaw = t.meta.preview.trim();
                          const preview = previewRaw === "New chat" ? "" : previewRaw;
                          const sub = preview.length > 0 ? preview : threadStatusLine(t, clockMs);
                          const active = t.meta.id === thread.meta.id;
                          return (
                              <button
                                key={t.meta.id}
                                className={active ? "popMenuItem active twoLine" : "popMenuItem twoLine"}
                                onClick={() => {
                                  setWorkspaceMenuOpen(false);
                                  void openThread(viewScope, t.meta.id);
                                }}
                                type="button"
                                title={t.meta.id}
                              >
                              <div className="menuItemTitle">{t.meta.id}</div>
                              <div className="menuItemSub">{sub}</div>
                            </button>
                          );
                        })
                    )}
                  </div>
                ) : null}
              </div>

              {viewActiveThreadId ? (
                <span className="chatThreadId" title={viewActiveThreadId}>
                  {viewActiveThreadId}
                </span>
              ) : null}
            </div>
          </div>
          <div className="chatTopBarRight">
            {contextLeft ? (
              <span
                className="chatContextLeft"
                title={`上下文剩余 ${contextLeft.pct}%（${contextLeft.used}/${contextLeft.window} tokens）`}
              >
                {`上下文剩余 ${contextLeft.pct}%`}
              </span>
            ) : null}
            {newThreadBusy ? <span className="chatBusy">正在新建会话…</span> : null}
            <div className="menuWrap">
              <button
                ref={moreBtnRef}
                className="topIconBtn"
                onClick={() => {
                  setMoreMenuOpen((v) => !v);
                  setWorkspaceMenuOpen(false);
                }}
                title="更多"
                aria-label="More"
                type="button"
              >
                <Icon name="more" />
              </button>

              {moreMenuOpen ? (
                <div ref={moreMenuRef} className="popMenu right">
                  <button
                    className="popMenuItem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      setToolDrawerOpen(true);
                    }}
                    type="button"
                  >
                    工具面板
                  </button>
                  <button className="popMenuItem" onClick={() => openRelayPairing()} type="button">
                    连接手机
                  </button>
                  <button className="popMenuItem" onClick={() => openPreferences()} type="button">
                    偏好设置
                  </button>
                  <button className="popMenuItem" onClick={() => openApiSettings()} type="button">
                    API 设置
                  </button>
                  <button
                    className="popMenuItem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      startNewChat();
                    }}
                    type="button"
                    disabled={newThreadBusy}
                  >
                    {newThreadBusy ? "新建会话（创建中…）" : "新建会话"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="chatBody" ref={chatBodyRef}>
          <div
            className="chatBodyInner"
            style={skillPopoverHeightPx > 0 ? { paddingBottom: skillPopoverHeightPx + 22 } : undefined}
          >

            {thread.messages.length === 0 ? (
              <div className="empty">输入消息开始会话。</div>
            ) : (
              <div className="chatMessages">
                {thread.messages.map((m) => {
                  const isAssistant = m.role === "assistant";
                  const isLastAssistantForTurn =
                    isAssistant && lastAssistantMessageIdByTurnId.get(m.turnId) === m.id;
                  const isSkillTurn = Boolean(skillBusyTurnId && m.turnId && m.turnId === skillBusyTurnId);
                  const isActiveTurn = Boolean((thread.running && m.turnId && m.turnId === thread.turnId) || isSkillTurn);
                  const snapshot = m.turnId ? (thread.turnActivityByTurnId[m.turnId] ?? null) : null;
                  const activitySource = isActiveTurn ? thread : snapshot;
                  const activity = activitySource;
                  const processCollapsed = m.turnId
                    ? thread.turnActivityCollapsedByTurnId[m.turnId] ?? (isActiveTurn ? false : true)
                    : true;

                  const hasProcessContent = (() => {
                    if (!activity) {
                      return false;
                    }
                    if (activity.turnError?.message?.trim()) {
                      return true;
                    }
                    const plan = activity.turnPlan;
                    if ((plan?.explanation ?? "").trim()) {
                      return true;
                    }
                    if ((plan?.plan ?? []).length) {
                      return true;
                    }
                    return activityVisibleItems(activity).length > 0;
                  })();

                  const processAvailable = Boolean(
                    isAssistant && isLastAssistantForTurn && activity && (isActiveTurn || hasProcessContent)
                  );

                  const processDurationMs = (() => {
                    if (isSkillTurn) {
                      const startedAtMs = skillBusyStartedAtMs ?? clockMs;
                      return Math.max(0, clockMs - startedAtMs);
                    }
                    if (thread.running && m.turnId && m.turnId === thread.turnId) {
                      const startedAtMs = thread.activeTurnStartedAtMs ?? clockMs;
                      return Math.max(0, clockMs - startedAtMs);
                    }
                    if (snapshot && typeof snapshot.durationMs === "number") {
                      return snapshot.durationMs;
                    }
                    if (typeof m.durationMs === "number") {
                      return m.durationMs;
                    }
                    return null;
                  })();

                  const processHeader = (() => {
                    const base = isActiveTurn ? "思考中" : "已思考";
                    if (typeof processDurationMs === "number" && processDurationMs > 0) {
                      return `${base}（用时 ${formatElapsed(processDurationMs)}）`;
                    }
                    return base;
                  })();

                  const canCopy = m.text.trim().length > 0;

                  const bubble = (
                    <div className={m.role === "user" ? "msgBubble user" : "msgBubble assistant"}>
                      {isAssistant && !processAvailable ? (
                        <div className="msgMetaRow">
                          <div className="msgMeta" />
                          <button
                            className="msgActionBtn msgCopyBtn"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(m.text);
                              } catch {
                              }
                            }}
                            disabled={!canCopy}
                            title="复制"
                            aria-label="Copy"
                            type="button"
                          >
                            <Icon name="copy" />
                          </button>
                        </div>
                      ) : null}
                      <div className="msgText">
                        {m.placeholder && m.text.trim().length === 0 ? (
                          <span className="msgPlaceholder">正在生成…</span>
                        ) : (
                          renderMessageText(m.text)
                        )}
                      </div>
                    </div>
                  );

                  if (m.role === "user") {
                    return (
                      <div key={m.id} className="msgRow user">
                        {bubble}
                      </div>
                    );
                  }

                  return (
                    <div key={m.id} className="msgRow assistant">
                      <div className="msgStack">
                        {processAvailable && activity ? (
                          <div className="turnProcess">
                            <div className="turnProcessHeaderRow">
                              <button
                                className="turnProcessHeader"
                                onClick={() => toggleTurnActivityCollapsed(viewScope, thread.meta.id, m.turnId)}
                                type="button"
                              >
                                <span className="turnProcessIcon" aria-hidden="true">
                                  <Icon name="gpt" />
                                </span>
                                <span className="turnProcessLabel">{processHeader}</span>
                                <span className="turnProcessChevron" aria-hidden="true">
                                  {processCollapsed ? "▸" : "▾"}
                                </span>
                              </button>
                              <button
                                className="msgActionBtn turnProcessCopyBtn"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(m.text);
                                  } catch {
                                  }
                                }}
                                disabled={!canCopy}
                                title="复制"
                                aria-label="Copy"
                                type="button"
                              >
                                <Icon name="copy" />
                              </button>
                            </div>
                            {!processCollapsed ? (
                              <div className="turnProcessBody">{renderTurnProcessInline(activity, isActiveTurn)}</div>
                            ) : null}
                          </div>
                        ) : null}
                        {!m.placeholder || m.text.trim().length > 0 ? bubble : null}
                      </div>
                    </div>
                  );
                })}
                <div ref={chatEndRef} />
              </div>
            )}
          </div>
        </div>

        {thread ? (
          <div className="chatComposer">
            <div className="composerBox">
              {activeSkill && skillPopoverOpen ? (
                <div className="skillPopoverHost">
                  <div
                    ref={skillPopoverRef}
                    className={skillPanelCollapsed ? "skillPopover collapsed" : "skillPopover"}
                  >
                    {(() => {
                      if (activeSkill.kind === "wizard") {
                        const missing = wizardRequiredMissing(activeSkill);
                        const ready = missing.length === 0;
                        const output = wizardRenderOutput(activeSkill);

                        const outputId = (activeSkill.result.outputPathAnswerId ?? "").trim();
                        const showOutputPathField = outputId.length > 0;

                        const headerTitle = wizardSavedPath ? `已保存：${wizardSavedPath}` : activeSkill.title;

                        return (
                          <>
                            <div className="skillPopoverHeader">
                              <div className="skillPopoverTitle">{headerTitle}</div>
                              <div className="skillPopoverActions">
                                <button
                                  className="btn tiny"
                                  onClick={() => setSkillPanelCollapsed((v) => !v)}
                                  type="button"
                                >
                                  {skillPanelCollapsed ? "展开" : "收起"}
                                </button>
                                <button className="btn tiny" onClick={() => closeSkills()} type="button">
                                  关闭技能
                                </button>
                                <button className="btn tiny" onClick={() => setSkillPopoverOpen(false)} type="button">
                                  隐藏
                                </button>
                              </div>
                            </div>

                            {!skillPanelCollapsed ? (
                              <div className="skillPopoverBody">
                                {activeSkill.steps.map((step, idx) => {
                                  if (step.type === "markdown") {
                                    const content = step.content.trim();
                                    if (!content) {
                                      return null;
                                    }
                                    return (
                                      <div key={`md_${idx}`} className="skillWizardMarkdown">
                                        {content}
                                      </div>
                                    );
                                  }

                                  const required = Boolean(step.required);
                                  const label = required ? `${step.label} *` : step.label;
                                  const value = wizardAnswer(step.id);
                                  const help = (step.help ?? "").trim();

                                  if (step.type === "select") {
                                    return (
                                      <div key={step.id} className="skillWizardField">
                                        <div className="skillWizardLabel">{label}</div>
                                        <select
                                          className="skillWizardInput"
                                          value={value}
                                          onChange={(e) => {
                                            setWizardSavedPath(null);
                                            setWizardAnswers((prev) => ({ ...prev, [step.id]: e.target.value }));
                                          }}
                                        >
                                          {!required ? <option value="">（未选择）</option> : null}
                                          {step.options.map((opt) => (
                                            <option key={opt.value} value={opt.value}>
                                              {opt.label}
                                            </option>
                                          ))}
                                        </select>
                                        {help ? <div className="hint">{help}</div> : null}
                                      </div>
                                    );
                                  }

                                  const inputProps = {
                                    className: "skillWizardInput",
                                    value,
                                    placeholder: step.placeholder ?? "",
                                    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                                      setWizardSavedPath(null);
                                      setWizardAnswers((prev) => ({ ...prev, [step.id]: e.target.value }));
                                    }
                                  };

                                  return (
                                    <div key={step.id} className="skillWizardField">
                                      <div className="skillWizardLabel">{label}</div>
                                      {step.multiline ? <textarea {...inputProps} rows={3} /> : <input {...inputProps} />}
                                      {help ? <div className="hint">{help}</div> : null}
                                    </div>
                                  );
                                })}

                                <div className="skillWizardResult">
                                  <div className="skillWizardResultHeader">
                                    <div className="skillWizardResultTitle">{activeSkill.result.title}</div>
                                    <div className="skillWizardActions">
                                      <button
                                        className="btn tiny"
                                        onClick={() => {
                                          setDraft(output);
                                          setSkillPopoverOpen(false);
                                        }}
                                        disabled={!ready}
                                        type="button"
                                      >
                                        插入
                                      </button>
                                      <button
                                        className="btn tiny primary"
                                        onClick={() => void wizardSendOutput(activeSkill)}
                                        disabled={!ready}
                                        type="button"
                                      >
                                        发送
                                      </button>
                                      <button
                                        className="btn tiny"
                                        onClick={() => void wizardSaveToFile(activeSkill)}
                                        disabled={!ready}
                                        type="button"
                                      >
                                        保存
                                      </button>
                                    </div>
                                  </div>

                                  {missing.length > 0 ? (
                                    <div className="hint">{`请先填写：${missing.join("、")}`}</div>
                                  ) : null}
                                  {wizardError ? <div className="errorText">{wizardError}</div> : null}

                                  {showOutputPathField ? (
                                    <div className="hint">{`保存路径：${wizardAnswer(outputId) || activeSkill.result.defaultOutputPath || "（未设置）"}`}</div>
                                  ) : null}

                                  <div className="skillWizardPreview">{output ? output : "（输出为空）"}</div>
                                </div>
                              </div>
                            ) : null}
                          </>
                        );
                      }

                      if (activeSkill.kind === "custom") {
                        const threadId = viewActiveThreadId ?? null;
                        const thread = threadId ? viewThreadsById[threadId] ?? null : null;
                        const workspaceRoot = thread?.meta.cwd?.trim() ?? "";

                        const insertText = (text: string) => {
                          setDraft(text);
                          setSkillPopoverOpen(false);
                        };

                        const sendText = async (text: string) => {
                          const trimmed = text.trim();
                          if (!trimmed) {
                            return;
                          }
                          if (!threadId) {
                            openNewChatSetup(trimmed);
                            return;
                          }
                          await sendToThread(viewScope, threadId, trimmed);
                        };

                        const saveToWorkspaceFile: SkillCustomRenderProps["saveToWorkspaceFile"] = async (relPath, content) => {
                          if (!threadId) {
                            return { ok: false, error: "请先选择一个会话（工作区）" };
                          }
                          if (!workspaceRoot) {
                            return { ok: false, error: "当前会话未配置工作区目录" };
                          }
                          const rel = String(relPath ?? "").trim();
                          if (!rel) {
                            return { ok: false, error: "缺少保存路径" };
                          }
                          const abs = joinFsPath(workspaceRoot, rel);
                          const res = await window.tazhan.workspaceWriteFile({ scope: viewScope, root: workspaceRoot, path: abs, content });
                          if (!res.ok) {
                            return { ok: false, error: res.error ?? "保存失败" };
                          }
                          return { ok: true, absPath: abs };
                        };

                        const llmChatComplete: SkillCustomRenderProps["llmChatComplete"] = async (args) =>
                          await window.tazhan.llmChatComplete(args);

                        const props: SkillCustomRenderProps = {
                          scope: viewScope,
                          threadId,
                          workspaceRoot,
                          insertText,
                          sendText,
                          saveToWorkspaceFile,
                          llmChatComplete
                        };

                        return (
                          <>
                            <div className="skillPopoverHeader">
                              <div className="skillPopoverTitle">{activeSkill.title}</div>
                              <div className="skillPopoverActions">
                                <button
                                  className="btn tiny"
                                  onClick={() => setSkillPanelCollapsed((v) => !v)}
                                  type="button"
                                >
                                  {skillPanelCollapsed ? "展开" : "收起"}
                                </button>
                                <button className="btn tiny" onClick={() => closeSkills()} type="button">
                                  关闭技能
                                </button>
                                <button className="btn tiny" onClick={() => setSkillPopoverOpen(false)} type="button">
                                  隐藏
                                </button>
                              </div>
                            </div>
                            {!skillPanelCollapsed ? <div className="skillPopoverBody">{<activeSkill.Renderer {...props} />}</div> : null}
                          </>
                        );
                      }

                      const asked = interviewQa.length;
                      const maxQ = clamp(Math.floor(interviewMaxQuestions || activeSkill.maxQuestions), 1, 30);
                      const hasPrd = interviewPrd.trim().length > 0;
                      const hasSeed = interviewSeed.trim().length > 0;
                      const awaitingAnswer = interviewQuestion.trim().length > 0;
                      const headerTitle = (() => {
                        if (hasPrd) {
                          return interviewSavedPath
                            ? `已生成 PRD · 已保存：${interviewSavedPath}`
                            : "已生成 PRD";
                        }
                        if (awaitingAnswer) {
                          return "等待你的回答";
                        }
                        if (interviewBusy) {
                          return "正在生成…";
                        }
                        if (!hasSeed) {
                          return "在输入框输入产品想法并发送";
                        }
                        return `进度 ${asked}/${maxQ}`;
                      })();

                      return (
                        <>
                          <div className="skillPopoverHeader">
                            <div className="skillPopoverTitle">{headerTitle}</div>
                            <div className="skillPopoverActions">
                              <button
                                className="btn tiny"
                                onClick={() => setSkillPanelCollapsed((v) => !v)}
                                type="button"
                              >
                                {skillPanelCollapsed ? "展开" : "收起"}
                              </button>
                              <button className="btn tiny" onClick={() => closeSkills()} type="button">
                                关闭技能
                              </button>
                              <button className="btn tiny" onClick={() => setSkillPopoverOpen(false)} type="button">
                                隐藏
                              </button>
                            </div>
                          </div>

                          {!skillPanelCollapsed ? (
                            <div className="skillPopoverBody">
                              <div className="skillCompactLine">
                                <span className="skillMiniLabel">模式</span>
                                <div className="segmented">
                                  <button
                                    className={interviewAskMode === "followUp" ? "segBtn active" : "segBtn"}
                                    onClick={() => setInterviewAskMode("followUp")}
                                    type="button"
                                  >
                                    追问
                                  </button>
                                  <button
                                    className={interviewAskMode === "batch" ? "segBtn active" : "segBtn"}
                                    onClick={() => setInterviewAskMode("batch")}
                                    type="button"
                                  >
                                    一次性提问
                                  </button>
                                </div>

                                <span className="skillMiniLabel">提问数</span>
                                <input
                                  className="skillNumInput"
                                  type="number"
                                  value={interviewMaxQuestions}
                                  min={1}
                                  max={30}
                                  onChange={(e) => setInterviewMaxQuestions(Number(e.target.value || 0))}
                                />

                                <span className="skillMiniLabel">输出</span>
                                <input
                                  className="skillPathInput"
                                  value={interviewOutputPath}
                                  placeholder={activeSkill.defaultOutputPath}
                                  onChange={(e) => setInterviewOutputPath(e.target.value)}
                                />
                              </div>

                              <div className="hint">
                                {hasPrd
                                  ? "已生成 PRD。"
                                  : awaitingAnswer
                                    ? interviewAskMode === "batch"
                                      ? "请按编号把答案写在一条消息里后发送。"
                                      : "请在输入框直接回答后发送。"
                                    : interviewBusy
                                      ? "正在生成下一条问题/PRD…"
                                      : !hasSeed
                                        ? "在输入框输入产品想法并发送，开始采访。"
                                        : interviewAskMode === "batch"
                                          ? "我会一次列出 N 个问题，你按编号回答并发送即可。"
                                          : "继续在输入框回答即可。"}
                              </div>
                              {interviewError ? <div className="errorText">{interviewError}</div> : null}
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>
                </div>
              ) : null}

              {draftImages.length > 0 ? (
                <div className="composerAttachments">
                  {draftImages.map((image) => (
                    <div key={image.id} className="composerAttachment">
                      <img className="composerAttachmentThumb" src={image.dataUrl} alt={image.name} />
                      <div className="composerAttachmentMeta">
                        <div className="composerAttachmentName">{image.name}</div>
                        <div className="composerAttachmentSub">{formatComposerAttachmentMeta(image)}</div>
                      </div>
                      <button
                        className="composerAttachmentRemove"
                        onClick={() => removeDraftImage(image.id)}
                        title="移除图片"
                        aria-label={`移除 ${image.name}`}
                        type="button"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <textarea
                className="composerInput"
                value={draft}
                placeholder="输入消息...（Ctrl+Enter 发送，Ctrl/Cmd+V 粘贴图片）"
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => {
                  void handleComposerPaste(e);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composerTools">
                <div className="menuWrap composerMenuWrap">
                  <button
                    ref={composerModelBtnRef}
                    className="composerPickerBtn"
                    type="button"
                    onClick={() => {
                      const nextOpen = composerMenuOpen !== "model";
                      if (nextOpen) {
                        setComposerCustomModelDraft(activeModelId);
                      }
                      setComposerMenuOpen(nextOpen ? "model" : null);
                      setWorkspaceMenuOpen(false);
                      setMoreMenuOpen(false);
                    }}
                    title={composerModelPickerLabel}
                  >
                    <span className="pickerText">{composerModelPickerLabel}</span>
                    <span className="chev" aria-hidden="true">
                      ▾
                    </span>
                  </button>

                  {composerMenuOpen === "model" ? (
                    <div ref={composerModelMenuRef} className="popMenu" style={composerModelMenuStyle}>
                      <div className="popMenuSection">模型</div>
                      <button
                        className={activeModelId.length === 0 ? "popMenuItem active" : "popMenuItem"}
                        onClick={() => {
                          applyActiveModel("");
                          setComposerMenuOpen(null);
                        }}
                        type="button"
                      >
                        自动（Codex 默认）
                      </button>
                      {viewModels.map((m) => {
                        const label = m.displayName?.trim().length ? `${m.displayName}（${m.id}）` : m.id;
                        const active = activeModelId === m.id;
                        return (
                          <button
                            key={m.id}
                            className={active ? "popMenuItem active" : "popMenuItem"}
                            onClick={() => {
                              applyActiveModel(m.id);
                              setComposerMenuOpen(null);
                            }}
                            type="button"
                          >
                            {label}
                          </button>
                        );
                      })}

                      <div className="popMenuDivider" />
                      <div className="popMenuSection">Custom model</div>
                      <div className="popRow">
                        <input
                          value={composerCustomModelDraft}
                          placeholder="e.g. gpt-5.4"
                          onChange={(e) => setComposerCustomModelDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") {
                              return;
                            }
                            e.preventDefault();
                            const modelId = composerCustomModelDraft.trim();
                            if (!modelId) {
                              return;
                            }
                            applyActiveModel(modelId);
                            setComposerMenuOpen(null);
                          }}
                        />
                      </div>
                      <div className="popMenuFooter">
                        <button
                          className="btn tiny"
                          onClick={() => setComposerCustomModelDraft(activeModelId)}
                          type="button"
                        >
                          Current
                        </button>
                        <button
                          className="btn tiny primary"
                          onClick={() => {
                            const modelId = composerCustomModelDraft.trim();
                            if (!modelId) {
                              return;
                            }
                            applyActiveModel(modelId);
                            setComposerMenuOpen(null);
                          }}
                          disabled={!composerCustomModelDraft.trim()}
                          type="button"
                        >
                          Apply
                        </button>
                      </div>

                      <div className="popMenuDivider" />
                      <div className="popMenuSection">思考强度</div>
                      <button
                        className={!activeEffort ? "popMenuItem active" : "popMenuItem"}
                        onClick={() => {
                          applyActiveEffort("");
                          setComposerMenuOpen(null);
                        }}
                        type="button"
                      >
                        默认
                      </button>
                      {(activeModel?.supportedReasoningEfforts?.length
                        ? activeModel.supportedReasoningEfforts.map((opt) => opt.reasoningEffort)
                        : genericEfforts
                      ).map((effort) => {
                        const active = activeEffort === effort;
                        return (
                          <button
                            key={effort}
                            className={active ? "popMenuItem active" : "popMenuItem"}
                            onClick={() => {
                              applyActiveEffort(effort);
                              setComposerMenuOpen(null);
                            }}
                            type="button"
                          >
                            {`${reasoningEffortLabel(effort)}（${effort}）`}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>

                <div className="menuWrap composerMenuWrap">
                  <button
                    ref={composerPolicyBtnRef}
                    className="composerPickerBtn"
                    type="button"
                    onClick={() => {
                      setComposerMenuOpen((v) => (v === "policy" ? null : "policy"));
                      setWorkspaceMenuOpen(false);
                      setMoreMenuOpen(false);
                    }}
                    title={composerPolicyPickerLabel}
                  >
                    <span className="pickerText">{composerPolicyPickerLabel}</span>
                    <span className="chev" aria-hidden="true">
                      ▾
                    </span>
                  </button>

                  {composerMenuOpen === "policy" ? (
                    <div ref={composerPolicyMenuRef} className="popMenu" style={composerPolicyMenuStyle}>
                      <div className="popMenuSection">沙箱/权限</div>
                      {sandboxes.map((s) => {
                        const active = thread.config.sandbox === s;
                        return (
                          <button
                            key={s}
                            className={active ? "popMenuItem active" : "popMenuItem"}
                            onClick={() => {
                              applyActiveSandbox(s);
                              setComposerMenuOpen(null);
                            }}
                            type="button"
                          >
                            {sandboxModeLabel(s)}
                          </button>
                        );
                      })}

                      <div className="popMenuDivider" />
                      <div className="popMenuSection">审批策略</div>
                      {approvalPolicies.map((p) => {
                        const active = thread.config.approvalPolicy === p;
                        return (
                          <button
                            key={p}
                            className={active ? "popMenuItem active" : "popMenuItem"}
                            onClick={() => {
                              applyActiveApprovalPolicy(p);
                              setComposerMenuOpen(null);
                            }}
                            type="button"
                          >
                            {approvalPolicyLabel(p)}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>

                <div className="menuWrap composerMenuWrap">
                  <button
                    ref={composerAutoReplyBtnRef}
                    className="composerPickerBtn"
                    type="button"
                    onClick={() => openComposerAutoReplyMenu()}
                    title={
                      settings?.autoReply?.message?.trim().length
                        ? `${composerAutoReplyPickerLabel} · ${settings.autoReply.message.trim()}`
                        : composerAutoReplyPickerLabel
                    }
                  >
                    <span className="pickerText">{composerAutoReplyPickerLabel}</span>
                    <span className="chev" aria-hidden="true">
                      ▾
                    </span>
                  </button>

                  {composerMenuOpen === "autoReply" ? (
                    <div ref={composerAutoReplyMenuRef} className="popMenu" style={composerAutoReplyMenuStyle}>
                      <div className="popMenuSection">自动回复</div>
                      <button
                        className={autoReplyEnabledDraft ? "popMenuItem active" : "popMenuItem"}
                        onClick={() => setAutoReplyEnabledDraft((v) => !v)}
                        type="button"
                      >
                        {autoReplyEnabledDraft ? "已开启（回合完成后自动再发一条）" : "已关闭"}
                      </button>

                      <div className="popMenuDivider" />
                      <div className="popMenuSection">内容</div>
                      <textarea
                        className="popMenuTextarea"
                        value={autoReplyMessageDraft}
                        placeholder="例如：继续完善直到达到最顶尖"
                        onChange={(e) => setAutoReplyMessageDraft(e.target.value)}
                      />

                      <div className="popMenuDivider" />
                      <div className="popMenuSection">次数</div>
                      <div className="popRow">
                        <button
                          className={autoReplyModeDraft === "infinite" ? "segBtn active" : "segBtn"}
                          onClick={() => setAutoReplyModeDraft("infinite")}
                          type="button"
                        >
                          无限
                        </button>
                        <button
                          className={autoReplyModeDraft === "times" ? "segBtn active" : "segBtn"}
                          onClick={() => setAutoReplyModeDraft("times")}
                          type="button"
                        >
                          x 次
                        </button>
                        <input
                          className="segInput"
                          type="number"
                          min={1}
                          max={999}
                          value={autoReplyTimesDraft}
                          disabled={autoReplyModeDraft !== "times"}
                          onChange={(e) => {
                            const value = Number.parseInt(e.target.value, 10);
                            setAutoReplyTimesDraft(Number.isFinite(value) ? value : 1);
                          }}
                        />
                        <button
                          className="segBtn"
                          onClick={() => resetAutoReplyForActiveThread()}
                          type="button"
                          disabled={!activeThreadId}
                          title="将本会话的自动回复次数重置为当前设置"
                        >
                          重置计数
                        </button>
                      </div>

                      {activeThreadId && autoReplyModeDraft === "times" ? (
                        <div className="popHint">{`本会话剩余：${
                          (autoReplyRuntimeByThreadId[activeThreadId]?.remaining ?? autoReplyTimesDraft) as number
                        }`}</div>
                      ) : null}

                      <div className="popMenuFooter">
                        <button
                          className="btn tiny"
                          onClick={() => {
                            setComposerMenuOpen(null);
                          }}
                          type="button"
                        >
                          取消
                        </button>
                        <button className="btn tiny primary" onClick={() => void applyAutoReplyDraft()} type="button">
                          应用
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="menuWrap composerMenuWrap">
                  <button
                    ref={composerSkillBtnRef}
                    className="composerPickerBtn"
                    type="button"
                    onClick={() => {
                      if (activeSkill && !skillPopoverOpen) {
                        setSkillPopoverOpen(true);
                        setWorkspaceMenuOpen(false);
                        setMoreMenuOpen(false);
                        return;
                      }
                      setComposerMenuOpen((v) => (v === "skill" ? null : "skill"));
                      setWorkspaceMenuOpen(false);
                      setMoreMenuOpen(false);
                    }}
                    title={composerSkillPickerLabel}
                  >
                    <span className="pickerText">{composerSkillPickerLabel}</span>
                    <span className="chev" aria-hidden="true">
                      ▾
                    </span>
                  </button>

                  {composerMenuOpen === "skill" ? (
                    <div ref={composerSkillMenuRef} className="popMenu" style={composerSkillMenuStyle}>
                      <div className="popMenuSection">技能</div>
                      <button
                        className={!skillSelectedId ? "popMenuItem active" : "popMenuItem"}
                        onClick={() => {
                          closeSkills();
                          setComposerMenuOpen(null);
                        }}
                        type="button"
                      >
                        无
                      </button>
                      <div className="popMenuDivider" />
                      {builtinSkills.map((s) => {
                        const active = skillSelectedId === s.id;
                        return (
                          <button
                            key={s.id}
                            className={active ? "popMenuItem active twoLine" : "popMenuItem twoLine"}
                            onClick={() => {
                              selectSkill(s);
                              setComposerMenuOpen(null);
                            }}
                            type="button"
                          >
                            <div className="menuItemTitle">{s.title}</div>
                            <div className="menuItemSub">{s.description ?? ""}</div>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>

                <div className="composerSpacer" />

                {thread.running ? (
                  <button
                    className="stopBtn"
                    onClick={() => void interruptTurn(thread.meta.id)}
                    disabled={!thread.turnId.trim()}
                    type="button"
                    title={!thread.turnId.trim() ? "正在启动回合..." : "中断本次生成"}
                  >
                    停止
                  </button>
                ) : null}

                <button className="sendBtn" onClick={() => void send()} disabled={!canSend} aria-label="Send" type="button">
                  发送
                </button>
              </div>

              {terminalDockOpen ? (
                <TerminalDock
                  open={terminalDockOpen}
                  scope={viewScope}
                  cwd={activeThread?.meta.cwd?.trim() ?? ""}
                  remoteConnected={Boolean(remoteStatus?.connected)}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const approvalPolicies: readonly ApprovalPolicy[] = [
    "on-request",
    "untrusted",
    "on-failure",
    "never"
  ] as const;
  const sandboxes: readonly SandboxMode[] = [
    "workspace-write",
    "read-only",
    "danger-full-access"
  ] as const;
  const genericEfforts: readonly ReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh"
  ] as const;

  return (
    <div className="app">
      <div className={sidebarOpen ? "layout" : "layout sidebarCollapsed"}>
        <div className="sidebar">
          <div className="sidebarTop">
            <div className="sidebarTopActions">
              <button className="newChatBtn" onClick={() => void startNewWorkspace()} type="button" disabled={newThreadBusy}>
                <span className="navIcon" aria-hidden="true">
                  <Icon name="project" />
                </span>
                {newThreadBusy ? "新建工作区（创建中…）" : "新建工作区"}
              </button>
              <button className="newChatBtn" onClick={() => openSshConnect()} type="button">
                <span className="navIcon" aria-hidden="true">
                  <Icon name="server" />
                </span>
                <span className="serverBtnText">
                  <span className="serverBtnTitle">服务器</span>
                  {remoteStatus?.connected ? (
                    <span className="serverBtnStatus">
                      <span className={statusDotClass("connected")} aria-hidden="true" />
                      已连接
                    </span>
                  ) : null}
                </span>
              </button>
            </div>

            <div className="sidebarQuickActions">
              <button
                className="quickActionBtn"
                onClick={() => {
                  setSidebarPanel("threads");
                  window.setTimeout(() => sidebarSearchRef.current?.focus(), 0);
                }}
                type="button"
              >
                <Icon name="search" />
                搜索
              </button>
              <button
                className="quickActionBtn"
                onClick={() => {
                  setSidebarPanel((v) => (v === "explorer" ? "threads" : "explorer"));
                }}
                disabled={!viewActiveThreadId}
                type="button"
              >
                <Icon name="project" />
                文件浏览
              </button>
              <button
                className="quickActionBtn"
                onClick={() => void refreshThreads(viewScope)}
                disabled={viewStatus !== "connected"}
                type="button"
              >
                <Icon name="refresh" />
                刷新
              </button>
            </div>

            {sidebarPanel === "threads" ? (
              <div className="sidebarSearchWrap">
                <span className="sidebarSearchIcon" aria-hidden="true">
                  <Icon name="search" />
                </span>
                <input
                  className="sidebarSearchInput"
                  ref={sidebarSearchRef}
                  value={threadSearch}
                  placeholder="搜索会话..."
                  onChange={(e) => setThreadSearch(e.target.value)}
                />
              </div>
            ) : (
              <div className="sidebarExplorerInfo" title={activeThread?.meta.cwd?.trim() ?? ""}>
                {activeThread?.meta.cwd?.trim().length ? `工作区：${cwdLabel(activeThread.meta.cwd)}` : "未选择工作区"}
              </div>
            )}
          </div>

            <div className="sidebarBody scroll">
              <div className="sidebarTabs">
                <button
                  className={viewScope === "local" && sidebarPanel === "threads" ? "sidebarTab active" : "sidebarTab"}
                  onClick={() => {
                    setViewScope("local");
                    setSidebarPanel("threads");
                  }}
                  type="button"
                >
                  会话
                </button>
                <button
                  className={viewScope === "local" && sidebarPanel === "explorer" ? "sidebarTab active" : "sidebarTab"}
                  onClick={() => {
                    setViewScope("local");
                    setSidebarPanel("explorer");
                  }}
                  type="button"
                  disabled={!activeThreadId}
                >
                  文件
                </button>
                <button
                  className={viewScope === "remote" && sidebarPanel === "threads" ? "sidebarTab active" : "sidebarTab"}
                  onClick={() => {
                    setViewScope("remote");
                    setSidebarPanel("threads");
                    if (remoteStatus?.connected) {
                      void refreshThreads("remote");
                    }
                  }}
                  type="button"
                  disabled={!remoteStatus?.connected}
                >
                  云会话
                </button>
                <button
                  className={viewScope === "remote" && sidebarPanel === "explorer" ? "sidebarTab active" : "sidebarTab"}
                  onClick={() => {
                    setViewScope("remote");
                    setSidebarPanel("explorer");
                  }}
                  type="button"
                  disabled={!remoteStatus?.connected || !remoteActiveThreadId}
                >
                  云文件
                </button>
                <button
                  className={terminalDockOpen ? "sidebarTab active" : "sidebarTab"}
                  onClick={() => setTerminalDockOpen((v) => !v)}
                  type="button"
                  disabled={!viewActiveThreadId || !activeThread?.meta.cwd?.trim() || (viewScope === "remote" && !remoteStatus?.connected)}
                  title="在底部打开终端（按当前工作区执行命令）"
                >
                  终端
                </button>
              </div>
              {sidebarPanel === "threads" ? renderThreadList() : renderSidebarExplorer()}
            </div>

          <div className="sidebarFooter">
            <div className="sidebarFooterMeta">
              <div className="sidebarStatus" title={codexCliInfo?.error ? codexCliInfo.error : ""}>
                <span className={statusDotClass(status)} />
                <span className="muted sidebarStatusText">{statusLabel(status)}</span>
                <span className="sidebarStatusSep" aria-hidden="true">
                  ·
                </span>
                <span className="sidebarVersionInline">
                  {(() => {
                    if (!codexCliInfo) {
                      return "codex 检测中…";
                    }
                    if (!codexCliInfo.installed) {
                      return "codex 未安装";
                    }
                    const ver = codexCliInfo.version ? `codex v${codexCliInfo.version}` : "codex";
                    const upd =
                      codexCliInfo.updateAvailable && codexCliInfo.latestVersion
                        ? ` · 可更新 v${codexCliInfo.latestVersion}`
                        : "";
                    return `${ver}${upd}`;
                  })()}
                </span>
                {remoteStatus?.connected ? (
                  <>
                    <span className="sidebarStatusSep" aria-hidden="true">
                      ·
                    </span>
                    <span className="sidebarVersionInline" title={`${remoteStatus.username}@${remoteStatus.host}:${remoteStatus.port} ${remoteStatus.workspaceRoot}`}>
                      {`远端 ${remoteStatus.username}@${remoteStatus.host}`}
                    </span>
                  </>
                ) : null}
              </div>
              <div className="userPlanRow">
                <div className="userPlan">运行中 {runningThreadCount} 个任务</div>
                <button className="footerIconBtn" onClick={() => openRelayPairing()} title="连接手机" aria-label="Connect phone" type="button">
                  <Icon name="phone" />
                </button>
              </div>
            </div>
            <div className="sidebarFooterActions">
              {!codexCliInfo || codexCliInfo.installed ? null : (
                <button className="btn tiny primary" onClick={() => void installCodexCli()} disabled={codexCliBusy} type="button">
                  {codexCliBusy ? "安装中…" : "安装 Codex"}
                </button>
              )}
              {codexCliInfo && codexCliInfo.installed && codexCliInfo.updateAvailable ? (
                <button className="btn tiny" onClick={() => void installCodexCli()} disabled={codexCliBusy} type="button">
                  {codexCliBusy ? "更新中…" : "更新"}
                </button>
              ) : null}
              <button
                className="footerIconBtn"
                onClick={() => openPreferences()}
                title="设置"
                aria-label="Settings"
                type="button"
              >
                <Icon name="settings" />
              </button>
            </div>
          </div>
        </div>

        <div className="chatPage">{renderChatPanel()}</div>
      </div>

      {explorerMenu ? (
        <div
          ref={explorerMenuRef}
          className="explorerCtxMenu"
          style={{ left: explorerMenu.left, top: explorerMenu.top }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const isRoot = explorerMenu.target.kind === "dir" && explorerMenu.target.path === explorerMenu.root;
            const isFile = explorerMenu.target.kind === "file";

            if (isFile) {
              return (
                <>
                  <button
                    className="explorerCtxMenuItem"
                    onClick={() => {
                      const threadId = explorerMenu.threadId;
                      const filePath = explorerMenu.target.path;
                      setExplorerMenu(null);
                      setFilePreview({ threadId, path: filePath, mode: "view", draft: "", saving: false, error: null });
                      void explorerSelectFile(explorerMenu.scope, threadId, filePath);
                    }}
                    type="button"
                  >
                    打开
                  </button>
                  <button
                    className="explorerCtxMenuItem"
                    onClick={() => {
                      const threadId = explorerMenu.threadId;
                      const filePath = explorerMenu.target.path;
                      setExplorerMenu(null);
                      setFilePreview({ threadId, path: filePath, mode: "edit", draft: "", saving: false, error: null });
                      void explorerSelectFile(explorerMenu.scope, threadId, filePath);
                    }}
                    type="button"
                  >
                    编辑
                  </button>
                  <div className="explorerCtxMenuDivider" />
                  <button
                    className="explorerCtxMenuItem"
                    onClick={() => {
                      setExplorerMenu(null);
                      setFileOpError(null);
                      setFileOp({
                        kind: "rename",
                        threadId: explorerMenu.threadId,
                        path: explorerMenu.target.path,
                        newName: pathBasename(explorerMenu.target.path)
                      });
                    }}
                    type="button"
                  >
                    重命名
                  </button>
                  <button
                    className="explorerCtxMenuItem danger"
                    onClick={() => {
                      setExplorerMenu(null);
                      setFileOpError(null);
                      setFileOp({
                        kind: "delete",
                        threadId: explorerMenu.threadId,
                        path: explorerMenu.target.path,
                        entryKind: explorerMenu.target.kind
                      });
                    }}
                    type="button"
                  >
                    删除
                  </button>
                </>
              );
            }

            return (
              <>
                <button
                  className="explorerCtxMenuItem"
                  onClick={() => {
                    setExplorerMenu(null);
                    setFileOpError(null);
                    setFileOp({ kind: "newFile", threadId: explorerMenu.threadId, parentDir: explorerMenu.parentDir, name: "" });
                  }}
                  type="button"
                >
                  新建文件
                </button>
                <button
                  className="explorerCtxMenuItem"
                  onClick={() => {
                    setExplorerMenu(null);
                    setFileOpError(null);
                    setFileOp({ kind: "newFolder", threadId: explorerMenu.threadId, parentDir: explorerMenu.parentDir, name: "" });
                  }}
                  type="button"
                >
                  新建文件夹
                </button>
                {explorerMenu.scope === "remote" ? (
                  <>
                    <div className="explorerCtxMenuDivider" />
                    <button
                      className="explorerCtxMenuItem"
                      onClick={() => {
                        const threadId = explorerMenu.threadId;
                        const destDir = explorerMenu.parentDir;
                        setExplorerMenu(null);
                        void (async () => {
                          const localPath = await window.tazhan.pickFile();
                          if (!localPath) {
                            return;
                          }
                          const res = await window.tazhan.remoteUploadFile({ destDir, localPath });
                          if (!res.ok) {
                            appendLog(`[warn] upload file failed: ${res.error ?? "unknown error"}`);
                            return;
                          }
                          void explorerLoadDir("remote", threadId, destDir);
                        })();
                      }}
                      type="button"
                    >
                      上传文件
                    </button>
                    <button
                      className="explorerCtxMenuItem"
                      onClick={() => {
                        const threadId = explorerMenu.threadId;
                        const destDir = explorerMenu.parentDir;
                        setExplorerMenu(null);
                        void (async () => {
                          const localPath = await window.tazhan.pickFolder();
                          if (!localPath) {
                            return;
                          }
                          const res = await window.tazhan.remoteUploadFolder({ destDir, localPath });
                          if (!res.ok) {
                            appendLog(`[warn] upload folder failed: ${res.error ?? "unknown error"}`);
                            return;
                          }
                          void explorerLoadDir("remote", threadId, destDir);
                        })();
                      }}
                      type="button"
                    >
                      上传文件夹
                    </button>
                  </>
                ) : null}
                <div className="explorerCtxMenuDivider" />
                <button
                  className="explorerCtxMenuItem"
                  onClick={() => {
                    setExplorerMenu(null);
                    setFileOpError(null);
                    setFileOp({
                      kind: "rename",
                      threadId: explorerMenu.threadId,
                      path: explorerMenu.target.path,
                      newName: pathBasename(explorerMenu.target.path)
                    });
                  }}
                  disabled={isRoot}
                  type="button"
                >
                  重命名
                </button>
                <button
                  className="explorerCtxMenuItem danger"
                  onClick={() => {
                    setExplorerMenu(null);
                    setFileOpError(null);
                    setFileOp({
                      kind: "delete",
                      threadId: explorerMenu.threadId,
                      path: explorerMenu.target.path,
                      entryKind: explorerMenu.target.kind
                    });
                  }}
                  disabled={isRoot}
                  type="button"
                >
                  删除
                </button>
              </>
            );
          })()}
        </div>
      ) : null}

      {toolDrawerOpen ? (
        <div className="drawerOverlay" onClick={() => setToolDrawerOpen(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawerHeader">
              <div className="tabs">
                <button
                  className={toolTab === "activity" ? "tab active" : "tab"}
                  onClick={() => setToolTab("activity")}
                >
                  过程
                </button>
                <button
                  className={toolTab === "terminal" ? "tab active" : "tab"}
                  onClick={() => setToolTab("terminal")}
                >
                  终端输出
                </button>
                <button
                  className={toolTab === "files" ? "tab active" : "tab"}
                  onClick={() => setToolTab("files")}
                >
                  文件变更
                </button>
                <button className={toolTab === "diff" ? "tab active" : "tab"} onClick={() => setToolTab("diff")}>
                  统一 Diff
                </button>
                <button className={toolTab === "log" ? "tab active" : "tab"} onClick={() => setToolTab("log")}>
                  调试
                </button>
              </div>
              <button className="iconBtn" onClick={() => setToolDrawerOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="drawerBody scroll">{renderToolPanel()}</div>
          </div>
        </div>
      ) : null}

      {filePreview ? (
        <div className="modalOverlay" onClick={() => setFilePreview(null)}>
          <div className="modal filePreviewModal" onClick={(e) => e.stopPropagation()}>
            {(() => {
              const scope = remoteThreadsByIdRef.current[filePreview.threadId] ? "remote" : "local";
              const byId = scope === "remote" ? remoteThreadsByIdRef.current : threadsByIdRef.current;
              const thread = byId[filePreview.threadId] ?? null;
              const root = thread?.meta.cwd?.trim() ?? "";
              const explorer = thread?.explorer ?? null;
              const full = filePreview.path.replaceAll("\\", "/");
              const rootNorm = root.replaceAll("\\", "/");
              const rel =
                rootNorm &&
                full.toLowerCase().startsWith(rootNorm.toLowerCase()) &&
                full.length > rootNorm.length
                  ? full.slice(rootNorm.length).replace(/^\/+/, "")
                  : full;

              if (!thread || !explorer) {
                return (
                  <>
                    <div className="modalHeader">
                      <div className="modalTitle">文件预览</div>
                      <button className="iconBtn" onClick={() => setFilePreview(null)} aria-label="Close" type="button">
                        ×
                      </button>
                    </div>
                    <div className="modalBody">
                      <div className="empty">会话已关闭</div>
                    </div>
                  </>
                );
              }

              return (
                <>
                  <div className="modalHeader">
                    <div className="modalTitle">文件预览</div>
                    <div className="filePreviewPath" title={full}>
                      {rel || full}
                    </div>
                    {explorer.selectedTruncated ? <span className="pillWarn">已截断</span> : null}
                    {filePreview.mode === "view" ? (
                      <button
                        className="btn tiny"
                        onClick={() => startEditingFilePreview()}
                        disabled={explorer.loadingFile || Boolean(explorer.selectedError) || explorer.selectedTruncated}
                        title={explorer.selectedTruncated ? "文件过大已截断，禁止直接编辑" : ""}
                        type="button"
                      >
                        编辑
                      </button>
                    ) : (
                      <>
                        <button className="btn tiny" onClick={() => stopEditingFilePreview()} disabled={filePreview.saving} type="button">
                          取消
                        </button>
                        <button
                          className="btn tiny primary"
                          onClick={() => void saveFilePreview()}
                          disabled={filePreview.saving}
                          type="button"
                        >
                          {filePreview.saving ? "保存中…" : "保存"}
                        </button>
                      </>
                    )}
                    <button className="iconBtn" onClick={() => setFilePreview(null)} aria-label="Close" type="button">
                      ×
                    </button>
                  </div>
                  <div className="modalBody">
                    {explorer.loadingFile ? <div className="muted">读取中…</div> : null}
                    {explorer.selectedError ? <div className="explorerError">{explorer.selectedError}</div> : null}
                    {filePreview.error ? <div className="explorerError">{filePreview.error}</div> : null}
                    {filePreview.mode === "edit" ? (
                      <textarea
                        className="fileEditor mono"
                        value={filePreview.draft}
                        onChange={(e) =>
                          setFilePreview((prev) => (prev ? { ...prev, draft: e.target.value } : prev))
                        }
                      />
                    ) : (
                      <pre className="filePreviewPre mono">{explorer.selectedContent}</pre>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      ) : null}

      {fileOp ? (
        <div className="modalOverlay" onClick={() => closeFileOp()}>
          <div className="modal smallModal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">
                {fileOp.kind === "newFolder"
                  ? "新建文件夹"
                  : fileOp.kind === "newFile"
                    ? "新建文件"
                    : fileOp.kind === "rename"
                      ? "重命名"
                      : "删除"}
              </div>
              <button className="iconBtn" onClick={() => closeFileOp()} aria-label="Close" type="button">
                ×
              </button>
            </div>
            <div className="modalBody">
              {fileOp.kind === "delete" ? (
                <div className="field">
                  <div className="label">{`确定删除这个${fileOp.entryKind === "dir" ? "文件夹" : "文件"}吗？`}</div>
                  <div className="mono">{fileOp.path}</div>
                </div>
              ) : (
                <div className="field">
                  <div className="label">名称</div>
                  <input
                    value={fileOp.kind === "rename" ? fileOp.newName : fileOp.name}
                    placeholder="输入名称..."
                    autoFocus
                    onChange={(e) => {
                      const v = e.target.value;
                      setFileOp((prev) => {
                        if (!prev) {
                          return prev;
                        }
                        if (prev.kind === "rename") {
                          return { ...prev, newName: v };
                        }
                        if (prev.kind === "newFile" || prev.kind === "newFolder") {
                          return { ...prev, name: v };
                        }
                        return prev;
                      });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void confirmFileOp();
                      }
                    }}
                  />
                  <div className="hint">
                    {fileOp.kind === "rename"
                      ? `原路径：${fileOp.path}`
                      : `父目录：${fileOp.parentDir}`}
                  </div>
                </div>
              )}

              {fileOpError ? <div className="errorText">{fileOpError}</div> : null}
            </div>
            <div className="modalFooter">
              <button className="btn" onClick={() => closeFileOp()} type="button" disabled={fileOpBusy}>
                取消
              </button>
              <button
                className={fileOp.kind === "delete" ? "btn danger" : "btn primary"}
                onClick={() => void confirmFileOp()}
                disabled={
                  fileOpBusy ||
                  (fileOp.kind === "rename" ? !fileOp.newName.trim() : fileOp.kind === "delete" ? false : !fileOp.name.trim())
                }
                type="button"
              >
                {fileOpBusy ? "处理中…" : fileOp.kind === "delete" ? "删除" : "确定"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {prefsOpen ? (
        <div className="modalOverlay" onClick={() => closePreferences()}>
          <div className="modal prefsModal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">偏好设置</div>
              <div className="sidebarStatus">
                <span className={statusDotClass(status)} />
                <span className="muted">{statusLabel(status)}</span>
              </div>
              <button className="iconBtn" onClick={() => closePreferences()} aria-label="Close" type="button">
                ×
              </button>
            </div>

            <div className="modalBody">
              <div className="segmented" style={{ marginBottom: 14 }}>
                <button
                  className={prefsSection === "engine" ? "segBtn active" : "segBtn"}
                  onClick={() => showPreferencesSection("engine")}
                  type="button"
                >
                  引擎安装
                </button>
                <button
                  className={prefsSection === "defaults" ? "segBtn active" : "segBtn"}
                  onClick={() => showPreferencesSection("defaults")}
                  type="button"
                >
                  默认设置
                </button>
                <button
                  className={prefsSection === "api" ? "segBtn active" : "segBtn"}
                  onClick={() => showPreferencesSection("api")}
                  type="button"
                >
                  API 设置
                </button>
                <button
                  className={prefsSection === "connectivity" ? "segBtn active" : "segBtn"}
                  onClick={() => showPreferencesSection("connectivity")}
                  type="button"
                >
                  连接与外观
                </button>
              </div>

              {prefsSection === "engine" ? <div id="prefs-section-engine" className="apiLiveBox">
                <div className="apiLiveTop">
                  <div>
                    <div className="apiSectionTitle">引擎安装</div>
                    <div className="hint">安装 Codex 命令所依赖的运行环境，避免用户手动去官网找安装路径。</div>
                  </div>
                </div>

                <div className="field">
                  <div className="label">Codex 命令</div>
                  <input
                    value={prefsCodexPath}
                    placeholder="codex"
                    onChange={(e) => setPrefsCodexPath(e.target.value)}
                  />
                  <div className="hint">一般保持为 codex（会从系统 PATH 里找到）</div>
                </div>

                <div className="field">
                  <div className="label">运行时依赖</div>
                  <div className="runtimeGrid">
                    <div
                      className={
                        !codexCliInfo ? "runtimeCard" : codexCliInfo.nodeInstalled ? "runtimeCard ok" : "runtimeCard bad"
                      }
                    >
                      <div className="runtimeTitle">Node.js</div>
                      <div className="runtimeValue">
                        {!codexCliInfo
                          ? "检测中…"
                          : codexCliInfo.nodeInstalled
                            ? `已安装 ${codexCliInfo.nodeVersion ?? ""}`.trim()
                            : "未安装"}
                      </div>
                      {codexCliInfo?.vcRedistX64Installed === null ? null : (
                        <div className="runtimeActions">
                          <button
                            className={codexCliInfo?.nodeInstalled ? "btn tiny" : "btn tiny primary"}
                            onClick={() => void installRuntime("nodejs")}
                            disabled={runtimeInstallBusy !== null}
                            type="button"
                          >
                            {runtimeInstallBusy === "nodejs"
                              ? "下载安装中…"
                              : codexCliInfo?.nodeInstalled
                                ? "重新安装"
                                : "安装 Node.js"}
                          </button>
                        </div>
                      )}
                    </div>
                    <div
                      className={
                        !codexCliInfo
                          ? "runtimeCard"
                          : codexCliInfo.vcRedistX64Installed === null
                            ? "runtimeCard"
                            : codexCliInfo.vcRedistX64Installed
                              ? "runtimeCard ok"
                              : "runtimeCard bad"
                      }
                    >
                      <div className="runtimeTitle">Visual C++ Redistributable (x64)</div>
                      <div className="runtimeValue">
                        {!codexCliInfo
                          ? "检测中…"
                          : codexCliInfo.vcRedistX64Installed === null
                            ? "当前平台不需要"
                            : codexCliInfo.vcRedistX64Installed
                              ? `已安装 ${codexCliInfo.vcRedistX64Version ?? ""}`.trim()
                              : "未安装"}
                      </div>
                      {codexCliInfo?.vcRedistX64Installed === null ? null : (
                        <div className="runtimeActions">
                          <button
                            className={codexCliInfo?.vcRedistX64Installed ? "btn tiny" : "btn tiny primary"}
                            onClick={() => void installRuntime("vcRedistX64")}
                            disabled={runtimeInstallBusy !== null}
                            type="button"
                          >
                            {runtimeInstallBusy === "vcRedistX64"
                              ? "下载安装中…"
                              : codexCliInfo?.vcRedistX64Installed
                                ? "重新安装"
                                : "安装 VC++ 运行库"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="hint">Windows 版 Codex 依赖 Node.js 和 Visual C++ Redistributable (x64)，可直接在这里下载安装官方安装包。</div>
                </div>
              </div> : null}

              {prefsSection === "defaults" ? <div id="prefs-section-defaults" className="apiLiveBox">
                <div className="apiLiveTop">
                  <div>
                    <div className="apiSectionTitle">默认设置</div>
                    <div className="hint">以后打开任意工作区和新会话，都会优先继承这里的默认模型、权限和提醒设置。</div>
                  </div>
                </div>

                <div className="field">
                  <div className="label">默认工作目录（cwd）</div>
                  <div className="row">
                    <input
                      value={prefsDefaultCwd}
                      placeholder="请选择一个文件夹..."
                      onChange={(e) => setPrefsDefaultCwd(e.target.value)}
                    />
                    <button className="btn" onClick={() => void pickDefaultWorkspace()} type="button">
                      选择
                    </button>
                  </div>
                </div>

                <div className="field">
                  <div className="label">默认模型</div>
                  <select value={prefsModelPresetValue} onChange={(e) => choosePrefsModelPreset(e.target.value)}>
                    <option value="">Codex 默认模型</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName ? `${m.displayName}（${m.id}）` : m.id}
                      </option>
                    ))}
                    <option value="__custom__">自定义</option>
                  </select>
                  {prefsModelPresetValue === "__custom__" ? (
                    <input
                      value={prefsModel}
                      placeholder="例如：gpt-5.4"
                      onChange={(e) => choosePrefsModel(e.target.value)}
                    />
                  ) : null}
                  <div className="hint">选择“自定义”后可自行输入模型名，保存时会同步写入 config.toml 的 model = "..."。</div>
                </div>

                <div className="field">
                  <div className="label">默认思考强度</div>
                  <select value={prefsReasoningEffort} onChange={(e) => setPrefsReasoningEffort(e.target.value as any)}>
                    <option value="">
                      {prefsEffectiveModel
                        ? `默认（${reasoningEffortLabel(prefsEffectiveModel.defaultReasoningEffort)}）`
                        : "默认"}
                    </option>
                    {(prefsEffectiveModel?.supportedReasoningEfforts?.length
                      ? prefsEffectiveModel.supportedReasoningEfforts.map((opt) => opt.reasoningEffort)
                      : genericEfforts
                    ).map((effort) => (
                      <option key={effort} value={effort}>
                        {`${reasoningEffortLabel(effort)}（${effort}）`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <div className="label">默认审批策略</div>
                  <select value={prefsApprovalPolicy} onChange={(e) => setPrefsApprovalPolicy(e.target.value as any)}>
                    {approvalPolicies.map((p) => (
                      <option key={p} value={p}>
                        {approvalPolicyLabel(p)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <div className="label">默认沙箱/权限</div>
                  <select value={prefsSandbox} onChange={(e) => setPrefsSandbox(e.target.value as any)}>
                    {sandboxes.map((s) => (
                      <option key={s} value={s}>
                        {sandboxModeLabel(s)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <div className="label">回合完成提醒（全局默认）</div>
                  <button
                    className={prefsNotifyOnComplete ? "btn primary" : "btn"}
                    onClick={() => setPrefsNotifyOnComplete((v) => !v)}
                    type="button"
                  >
                    {prefsNotifyOnComplete ? "开启" : "关闭"}
                  </button>
                  <div className="hint">可在会话列表里对单个会话单独覆盖。</div>
                </div>
              </div> : null}

              {prefsSection === "api" ? <div id="prefs-section-api" className="apiLiveBox">
                <div className="apiLiveTop">
                  <div>
                    <div className="apiSectionTitle">API 设置</div>
                    <div className="hint">在同一个设置弹窗里维护提供商列表，并把选中的 Provider / Base URL / API Key 写回 Codex 配置。</div>
                  </div>
                </div>

                <div className="apiLiveBox">
                  <div className="apiLiveTop">
                    <div className="apiSectionTitle">当前 Codex</div>
                    <div className="row">
                      <button
                        className="btn tiny"
                        onClick={() => void refreshApiSettings()}
                        disabled={apiBusy}
                        type="button"
                      >
                        {apiBusy ? "读取中…" : "刷新"}
                      </button>
                      <button
                        className="btn tiny"
                        onClick={async () => {
                          if (!apiLiveCodexHome.trim()) {
                            return;
                          }
                          try {
                            await window.tazhan.openInExplorer(apiLiveCodexHome);
                          } catch (err) {
                            setApiError(String(err));
                          }
                        }}
                        disabled={!apiLiveCodexHome.trim()}
                        type="button"
                      >
                        打开目录
                      </button>
                    </div>
                  </div>
                  <div className="apiLiveMeta">
                    <div className="hint">
                      {`Provider：${apiLiveModelProvider ?? "(未知)"} · Base URL：${apiLiveBaseUrl || "(未设置)"} · Key：${
                        apiLiveKeyPresent ? apiLiveKeyMasked ?? "****" : "未设置"
                      }`}
                    </div>
                    <div className="hint">{apiLiveConfigPath.trim() ? `config.toml: ${apiLiveConfigPath}` : "config.toml: (未知)"}</div>
                    <div className="hint">{apiLiveAuthPath.trim() ? `auth.json: ${apiLiveAuthPath}` : "auth.json: (未知)"}</div>
                  </div>
                </div>

                <div className="apiGrid">
                  <div className="apiProfilesPanel">
                    <div className="apiProfilesHeader">
                      <div className="apiSectionTitle">提供商</div>
                      <div className="row">
                        <button
                          className="btn tiny"
                          onClick={async () => {
                            const s = settingsRef.current;
                            if (!s) {
                              return;
                            }
                            const created = makeNewApiProfile();
                            const nextList = [created, ...(s.apiProfiles ?? [])];
                            await saveSettingsPatch({
                              apiProfiles: nextList,
                              apiActiveProfileId: s.apiActiveProfileId ?? null
                            });
                            selectApiProfile(created.id);
                          }}
                          type="button"
                        >
                          新建
                        </button>
                        <button
                          className="btn tiny"
                          onClick={async () => {
                            const s = settingsRef.current;
                            if (!s || !apiSelectedProfileId) {
                              return;
                            }
                            const nextList = (s.apiProfiles ?? []).filter((p) => p.id !== apiSelectedProfileId);
                            const nextActive =
                              s.apiActiveProfileId === apiSelectedProfileId ? nextList[0]?.id ?? null : s.apiActiveProfileId;
                            await saveSettingsPatch({ apiProfiles: nextList, apiActiveProfileId: nextActive ?? null });
                            selectApiProfile(nextActive ?? null);
                          }}
                          disabled={!apiSelectedProfileId}
                          type="button"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="apiProfileList">
                      {(settings?.apiProfiles?.length ? settings.apiProfiles : []).map((p) => {
                        const active = p.id === apiSelectedProfileId;
                        const isDefault = settings?.apiActiveProfileId === p.id;
                        return (
                          <button
                            key={p.id}
                            className={active ? "apiProfileItem active" : "apiProfileItem"}
                            onClick={() => selectApiProfile(p.id)}
                            type="button"
                          >
                            <div className="apiProfileTitleRow">
                              <div className="apiProfileName">{p.name}</div>
                              {isDefault ? <span className="apiProfileBadge">默认</span> : null}
                            </div>
                            <div className="apiProfileSub">{p.baseUrl.trim() ? p.baseUrl : "未设置 Base URL"}</div>
                          </button>
                        );
                      })}
                      {!settings?.apiProfiles?.length ? <div className="muted apiEmpty">暂无提供商</div> : null}
                    </div>
                  </div>

                  <div className="apiEditorPanel">
                    <div className="field">
                      <div className="label">名称</div>
                      <input value={apiProfileName} onChange={(e) => setApiProfileName(e.target.value)} placeholder="例如：OpenAI / NewAPI" />
                    </div>

                    <div className="field">
                      <div className="label">Provider 标识</div>
                      <input
                        value={apiProfileProvider}
                        onChange={(e) => setApiProfileProvider(e.target.value)}
                        placeholder="例如：openai / packycode / newapi"
                      />
                    </div>

                    <div className="field">
                      <div className="label">Base URL</div>
                      <input
                        value={apiProfileBaseUrl}
                        placeholder="输入 Provider Base URL"
                        onChange={(e) => setApiProfileBaseUrl(e.target.value)}
                      />
                    </div>

                    <div className="field">
                      <div className="label">API Key</div>
                      <div className="row">
                        <input
                          type={apiProfileShowKey ? "text" : "password"}
                          value={apiProfileApiKey}
                          placeholder="粘贴 API Key..."
                          onChange={(e) => setApiProfileApiKey(e.target.value)}
                        />
                        <button className="btn tiny" onClick={() => setApiProfileShowKey((v) => !v)} type="button">
                          {apiProfileShowKey ? "隐藏" : "显示"}
                        </button>
                      </div>
                      <div className="hint">保存到本地 settings.json；应用后会写入 ~/.codex/auth.json。</div>
                    </div>

                    {apiTestResult ? (
                      <div className={apiTestResult.ok ? "apiTestBox ok" : "apiTestBox bad"}>
                        {apiTestResult.ok
                          ? `测试成功${apiTestResult.latencyMs !== null ? ` · ${apiTestResult.latencyMs}ms` : ""}${
                              apiTestResult.modelsCount !== null ? ` · models=${apiTestResult.modelsCount}` : ""
                            }`
                          : `测试失败${apiTestResult.status ? ` · HTTP ${apiTestResult.status}` : ""} · ${apiTestResult.error ?? ""}`}
                        {!apiTestResult.ok && apiTestResult.suggestedBaseUrl ? (
                          <div className="hint">{`提示：可能需要 /v1，建议 Base URL 改为 ${apiTestResult.suggestedBaseUrl}`}</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>

                {apiError ? <div className="errorText">{apiError}</div> : null}

                <div className="row wrap" style={{ marginTop: 12, justifyContent: "flex-end" }}>
                  <button className="btn" onClick={() => void saveApiProfileDraft(false)} disabled={apiBusy} type="button">
                    保存到列表
                  </button>
                  <button className="btn" onClick={() => void testApiProfileDraft()} disabled={apiTestBusy} type="button">
                    {apiTestBusy ? "测试中…" : "测试"}
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => void applyApiProfileDraft()}
                    disabled={apiBusy || !apiProfileProvider.trim() || !apiProfileBaseUrl.trim()}
                    type="button"
                  >
                    {apiBusy ? "处理中…" : "应用并重连"}
                  </button>
                </div>
              </div> : null}

              {prefsSection === "connectivity" ? <div id="prefs-section-connectivity" className="apiLiveBox">
                <div className="apiLiveTop">
                  <div>
                    <div className="apiSectionTitle">连接与外观</div>
                    <div className="hint">集中管理通知、手机远程控制和主题外观。</div>
                  </div>
                </div>

                <div className="field">
                  <div className="label">回合完成 Webhook（可选）</div>
                  <input
                    value={prefsWebhookUrl}
                    placeholder="输入 Webhook URL"
                    onChange={(e) => setPrefsWebhookUrl(e.target.value)}
                  />
                </div>

                <div className="field">
                  <div className="label">Cloud Relay（手机远程控制）</div>
                  <button
                    className={prefsRelayEnabled ? "btn primary" : "btn"}
                    onClick={() => setPrefsRelayEnabled((v) => !v)}
                    type="button"
                  >
                    {prefsRelayEnabled ? "开启" : "关闭"}
                  </button>
                  <input
                    value={prefsRelayBaseUrl}
                    placeholder="输入 Relay Base URL"
                    onChange={(e) => setPrefsRelayBaseUrl(e.target.value)}
                  />
                  <div className="hint">不会再预置默认域名；开启后会使用这里填写的地址。</div>
                </div>

                <div className="field">
                  <div className="label">外观主题</div>
                  <button
                    className={prefsTheme === "dark" ? "btn primary" : "btn"}
                    onClick={() => setPrefsTheme((v) => (v === "dark" ? "light" : "dark"))}
                    type="button"
                  >
                    {prefsTheme === "dark" ? "夜间模式" : "浅色模式"}
                  </button>
                  <div className="hint">可切换为黑暗主题，适合夜间使用。</div>
                </div>
              </div> : null}
            </div>

            <div className="modalFooter">
              <button className="btn" onClick={() => closePreferences()} type="button">
                取消
              </button>
              <button className="btn" onClick={() => void connect()} disabled={status === "connected"} type="button">
                {status === "connected" ? "已连接" : "连接"}
              </button>
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await window.tazhan.codexDisconnect();
                  } catch {
                  }
                }}
                disabled={status !== "connected"}
                type="button"
              >
                断开
              </button>
              <button className="btn primary" onClick={() => void confirmPreferences()} type="button">
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pairOpen ? (
        <div className="modalOverlay" onClick={() => closeRelayPairing()}>
          <div className="modal smallModal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">连接手机</div>
              <button className="iconBtn" onClick={() => closeRelayPairing()} aria-label="Close" type="button">
                ×
              </button>
            </div>

            <div className="modalBody">
              <div className="apiLiveBox" style={{ marginTop: 12 }}>
                <div className="apiLiveTop">
                  <div className="apiSectionTitle">配对码</div>
                  <div className="muted">
                    {relayPairingExpiresAt > 0
                      ? (() => {
                          const expired = relayPairingExpiresAt <= Math.floor(Date.now() / 1000);
                          const ts = new Date(relayPairingExpiresAt * 1000).toLocaleString();
                          return expired ? `已过期 · ${ts}` : `有效期至 ${ts}`;
                        })()
                      : ""}
                  </div>
                </div>

                {relayPairingCode ? (
                  <div className="pairQrWrap">
                    {pairQrDataUrl ? <img className="pairQrImage" src={pairQrDataUrl} alt="pairing qr" /> : <div className="muted">二维码生成中…</div>}
                  </div>
                ) : null}

                {relayPairingCode ? (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div className="mono">{relayPairingCode}</div>
                    <button
                      className="btn tiny"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(relayPairingCode);
                        } catch {
                        }
                      }}
                      type="button"
                    >
                      复制
                    </button>
                  </div>
                ) : (
                  <div className="muted">尚未生成（点击下方按钮生成）</div>
                )}

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  <button className="btn tiny primary" onClick={() => void refreshRelayPairingCode()} disabled={pairBusy} type="button">
                    {pairBusy ? "生成中…" : relayPairingCode ? "刷新配对码" : "生成配对码"}
                  </button>
                  <button
                    className="btn tiny"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(relayPairingQrPayload);
                      } catch {
                      }
                    }}
                    disabled={!relayPairingQrPayload}
                    type="button"
                  >
                    复制扫码链接
                  </button>
                </div>

                {relayPairingQrPayload ? <div className="hint" style={{ marginTop: 10 }}>{relayPairingQrPayload}</div> : null}
                <div className="hint" style={{ marginTop: 8 }}>
                  手机端打开「配对」，直接扫码即可绑定到此桌面端。
                </div>
              </div>

              <div className="apiLiveBox" style={{ marginTop: 12 }}>
                <div className="apiLiveTop">
                  <div className="apiSectionTitle">安全性</div>
                </div>
                <div className="muted">
                  传输层建议使用 https/wss（默认）。若启用 E2EE（尤其 required），即使 Relay 被入侵也能保护命令与数据内容不被 Relay 明文读取。
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  提示：首次配对时在同一局域网/面对面核对 E2EE keyId 或 fingerprint，会更不容易被中间人冒充。
                </div>
              </div>



              <div className="apiLiveBox" style={{ marginTop: 12 }}>
                <div className="apiLiveTop">
                  <div className="apiSectionTitle">E2EE</div>
                  <div className="muted">
                    {settings?.relay.e2ee.enabled
                      ? settings.relay.e2ee.required
                        ? "enabled, required"
                        : "enabled"
                      : "disabled"}
                  </div>
                </div>

                <div className="muted">
                  When enabled, app &lt;-&gt; desktop RPC is end-to-end encrypted (AES-256-GCM + integrity + anti-replay).
                  The relay only forwards the opaque `rpc` field.
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  <button
                    className={settings?.relay.e2ee.enabled ? "btn tiny primary" : "btn tiny"}
                    onClick={() => {
                      const cur = Boolean(settingsRef.current?.relay.e2ee.enabled);
                      void saveSettingsPatch({ relay: { e2ee: { enabled: !cur } as any } as any });
                    }}
                    type="button"
                  >
                    {settings?.relay.e2ee.enabled ? "Enabled" : "Enable"}
                  </button>

                  <button
                    className={settings?.relay.e2ee.required ? "btn tiny primary" : "btn tiny"}
                    onClick={() => {
                      const cur = Boolean(settingsRef.current?.relay.e2ee.required);
                      void saveSettingsPatch({ relay: { e2ee: { required: !cur } as any } as any });
                    }}
                    disabled={!settings?.relay.e2ee.enabled}
                    type="button"
                  >
                    {settings?.relay.e2ee.required ? "Required" : "Required (off)"}
                  </button>

                  <button
                    className={settings?.relay.e2ee.allowTofu ? "btn tiny primary" : "btn tiny"}
                    onClick={() => {
                      const cur = Boolean(settingsRef.current?.relay.e2ee.allowTofu);
                      void saveSettingsPatch({ relay: { e2ee: { allowTofu: !cur } as any } as any });
                    }}
                    disabled={!settings?.relay.e2ee.enabled}
                    type="button"
                  >
                    {settings?.relay.e2ee.allowTofu ? "Allow TOFU" : "allowTofu=false"}
                  </button>
                </div>

                {settings?.relay.e2ee.enabled ? (
                  <div className="hint" style={{ marginTop: 8 }}>
                    deviceKeyId: <span className="mono">{settings.relay.e2ee.deviceKeyId || "(pending)"}</span>
                  </div>
                ) : null}

                <div className="hint" style={{ marginTop: 8 }}>
                  If allowTofu=false, the desktop only trusts peers in trustedPeers.
                  Copy your phone's key from the mobile Pair screen and add it below.
                </div>

                <div className="fieldRow" style={{ marginTop: 10 }}>
                  <div className="field compact" style={{ flex: 1 }}>
                    <div className="label">Peer label (optional)</div>
                    <input
                      value={relayE2eePeerLabel}
                      onChange={(e) => setRelayE2eePeerLabel(e.target.value)}
                      placeholder="my-phone"
                    />
                  </div>
                </div>

                <div className="field" style={{ marginTop: 10 }}>
                  <div className="label">Peer ed25519 public key (spki-der, base64)</div>
                  <textarea
                    value={relayE2eePeerEd25519Pub}
                    onChange={(e) => setRelayE2eePeerEd25519Pub(e.target.value)}
                    placeholder="base64(spki-der)"
                    className="mono"
                  />
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    className="btn tiny primary"
                    onClick={() => void addRelayE2eeTrustedPeer()}
                    disabled={relayE2eePeerBusy}
                    type="button"
                  >
                    {relayE2eePeerBusy ? "Working..." : "Add trusted peer"}
                  </button>
                  <button
                    className="btn tiny"
                    onClick={async () => {
                      const peers = settingsRef.current?.relay.e2ee.trustedPeers ?? [];
                      try {
                        await navigator.clipboard.writeText(JSON.stringify(peers, null, 2));
                      } catch {
                      }
                    }}
                    disabled={!(settings?.relay.e2ee.trustedPeers ?? []).length}
                    type="button"
                  >
                    Copy trustedPeers
                  </button>
                </div>

                {relayE2eePeerError ? <div className="errorText">{relayE2eePeerError}</div> : null}

                <div className="hint" style={{ marginTop: 10 }}>
                  trustedPeers ({settings?.relay.e2ee.trustedPeers?.length ?? 0})
                </div>

                {(settings?.relay.e2ee.trustedPeers ?? []).length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                    {(settings?.relay.e2ee.trustedPeers ?? []).map((p) => (
                      <div
                        key={p.keyId}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            className="mono"
                            style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}
                            title={p.keyId}
                          >
                            {p.keyId}
                          </div>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {p.label} - {p.addedAt ? new Date(p.addedAt * 1000).toLocaleString() : ""}
                          </div>
                        </div>
                        <button
                          className="btn tiny"
                          onClick={() => void removeRelayE2eeTrustedPeer(p.keyId)}
                          disabled={relayE2eePeerBusy}
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="muted" style={{ marginTop: 8 }}>
                    (no trusted peers)
                  </div>
                )}
              </div>
              {pairError ? <div className="errorText">{pairError}</div> : null}
            </div>

            <div className="modalFooter">
              <button className="btn" onClick={() => closeRelayPairing()} type="button">
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {sshOpen ? (
        <div className="modalOverlay" onClick={() => closeSshConnect()}>
          <div className="modal smallModal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">连接服务器（SSH）</div>
              <button className="iconBtn" onClick={() => closeSshConnect()} aria-label="Close" type="button">
                ×
              </button>
            </div>

            <div className="modalBody">
              {sshStep === "connect" ? (
                <>
                  <div className="fieldRow">
                    <div className="field compact">
                      <div className="label">Host</div>
                      <input
                        value={sshHost}
                        placeholder="输入主机名或 IP"
                        onChange={(e) => setSshHost(e.target.value)}
                      />
                    </div>
                    <div className="field compact">
                      <div className="label">端口</div>
                      <input
                        value={String(sshPort)}
                        inputMode="numeric"
                        onChange={(e) => setSshPort(Math.max(1, Math.floor(Number(e.target.value) || 22)))}
                      />
                    </div>
                  </div>

                  <div className="fieldRow">
                    <div className="field compact">
                      <div className="label">用户名</div>
                      <input value={sshUsername} placeholder="root" onChange={(e) => setSshUsername(e.target.value)} />
                    </div>
                    <div className="field compact">
                      <div className="label">密码</div>
                      <input
                        value={sshPassword}
                        type="password"
                        placeholder="不会保存到本地设置"
                        onChange={(e) => setSshPassword(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="hint">先连接服务器；连接成功后再选择工作区。</div>

                  {sshError ? <div className="errorText">{sshError}</div> : null}

                  {remoteStatus?.connected ? (
                    <div className="apiLiveBox" style={{ marginTop: 12 }}>
                      <div className="apiLiveTop">
                        <div className="apiSectionTitle">远端已连接</div>
                        <div className="muted">{`${remoteStatus.username}@${remoteStatus.host}:${remoteStatus.port}`}</div>
                      </div>
                      <div className="muted">{`工作区：${remoteStatus.workspaceRoot}`}</div>
                    </div>
                  ) : null}

                  {sshResult && sshResult.ok ? (
                    <div className="apiLiveBox" style={{ marginTop: 12 }}>
                      <div className="apiLiveTop">
                        <div className="apiSectionTitle">检测结果</div>
                        <div className="muted">{sshResult.latencyMs !== null ? `${sshResult.latencyMs}ms` : ""}</div>
                      </div>
                      <div className="muted">
                        {sshResult.uname ? sshResult.uname : "uname: (未知)"}
                        <br />
                        {sshResult.codexPath
                          ? `codex：已安装 · ${sshResult.codexVersion ? `v${sshResult.codexVersion}` : "版本未知"} · ${sshResult.codexPath}`
                          : "codex：未检测到（可在服务器运行：npm i -g @openai/codex）"}
                        <br />
                        {`node：${sshResult.nodeVersion ?? "未知"} · npm：${sshResult.npmVersion ?? "未知"}`}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="apiLiveBox">
                    <div className="apiLiveTop">
                      <div className="apiSectionTitle">已连接服务器</div>
                      <div className="muted">{`${sshUsername.trim()}@${sshHost.trim()}:${Math.max(1, Math.floor(Number(sshPort) || 22))}`}</div>
                    </div>
                    {sshResult && sshResult.ok ? (
                      <div className="hint">
                        {sshResult.codexPath
                          ? `codex：已安装 · ${sshResult.codexVersion ? `v${sshResult.codexVersion}` : "版本未知"}`
                          : "codex：未检测到（可在服务器运行：npm i -g @openai/codex）"}
                      </div>
                    ) : null}
                  </div>

                  <div className="fieldRow" style={{ marginTop: 12 }}>
                    <div className="field compact" style={{ flex: 2 }}>
                      <div className="label">工作区目录</div>
                      <input
                        value={sshWorkspaceRoot}
                        placeholder="/home/ubuntu/TAZHAN_WEB"
                        onChange={(e) => setSshWorkspaceRoot(e.target.value)}
                      />
                      <div className="hint">可从下方列表选择，也可以手动输入绝对路径</div>
                    </div>
                    <div className="field compact" style={{ alignSelf: "flex-end", minWidth: 160 }}>
                      <label className="checkRow">
                        <input
                          type="checkbox"
                          checked={sshUseLoginShell}
                          onChange={(e) => setSshUseLoginShell(Boolean(e.target.checked))}
                        />
                        <span>使用 bash -lc</span>
                      </label>
                      <div className="hint">nvm 环境建议开启</div>
                    </div>
                  </div>

                  <div className="apiLiveBox" style={{ marginTop: 12 }}>
                    <div className="apiLiveTop">
                      <div className="apiSectionTitle">可用工作区</div>
                      <button
                        className="btn tiny"
                        onClick={() => void scanRemoteWorkspaces()}
                        type="button"
                        disabled={sshBusy || remoteWorkspaceScanBusy || sshNewWorkspaceBusy}
                      >
                        {remoteWorkspaceScanBusy ? "扫描中…" : "刷新"}
                      </button>
                    </div>
                    <div className="hint">{remoteWorkspaceHome.trim() ? `HOME：${remoteWorkspaceHome}` : "扫描将从 HOME 目录列出候选项"}</div>
                    {remoteWorkspaceScanError ? <div className="errorText">{remoteWorkspaceScanError}</div> : null}
                    {remoteWorkspaceCandidates.length === 0 ? (
                      <div className="muted">（没有找到 / 尚未扫描）</div>
                    ) : (
                      <div className="workspaceCandidates">
                        {remoteWorkspaceCandidates.map((c) => {
                          const tag = c.hasGit ? "git" : c.hasPackageJson ? "node" : "";
                          const active = sshWorkspaceRoot.trim() === c.path.trim();
                          return (
                            <button
                              key={c.path}
                              className={active ? "workspaceCandidate active" : "workspaceCandidate"}
                              onClick={() => setSshWorkspaceRoot(c.path)}
                              type="button"
                              title={c.path}
                            >
                              <span className="workspaceCandidateName">{c.label}</span>
                              {tag ? <span className="pill tiny">{tag}</span> : null}
                              <span className="workspaceCandidatePath">{c.path}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="apiLiveBox" style={{ marginTop: 12 }}>
                    <div className="apiLiveTop">
                      <div className="apiSectionTitle">新建工作区文件夹</div>
                    </div>
                    <div className="fieldRow" style={{ marginTop: 8, flexWrap: "wrap" }}>
                      <div className="field compact" style={{ flex: 2 }}>
                        <div className="label">父目录</div>
                        <input
                          value={sshNewWorkspaceParent}
                          placeholder={remoteWorkspaceHome.trim() || "/home/username"}
                          onChange={(e) => setSshNewWorkspaceParent(e.target.value)}
                        />
                      </div>
                      <div className="field compact" style={{ flex: 1 }}>
                        <div className="label">文件夹名</div>
                        <input value={sshNewWorkspaceName} placeholder="my_project" onChange={(e) => setSshNewWorkspaceName(e.target.value)} />
                      </div>
                      <div style={{ alignSelf: "flex-end", minWidth: 110, flex: "0 0 auto" }}>
                        <button
                          className="btn tiny"
                          onClick={() => void createRemoteWorkspaceFolder()}
                          type="button"
                          disabled={sshBusy || sshNewWorkspaceBusy || remoteWorkspaceScanBusy}
                        >
                          {sshNewWorkspaceBusy ? "创建中…" : "创建"}
                        </button>
                      </div>
                    </div>
                    {sshNewWorkspaceError ? <div className="errorText">{sshNewWorkspaceError}</div> : null}
                    <div className="hint">创建后会自动选中该目录作为工作区。</div>
                  </div>

                  {sshError ? <div className="errorText">{sshError}</div> : null}
                </>
              )}
            </div>

            <div className="modalFooter">
              <button className="btn" onClick={() => closeSshConnect()} type="button" disabled={sshBusy}>
                取消
              </button>
              {remoteStatus?.connected ? (
                <button className="btn" onClick={() => void disconnectRemoteWorkspace()} type="button" disabled={sshBusy}>
                  断开远端
                </button>
              ) : null}
              {sshStep === "connect" ? (
                <button className="btn primary" onClick={() => void probeSsh()} type="button" disabled={sshBusy}>
                  {sshBusy ? "连接中…" : "连接"}
                </button>
              ) : (
                <>
                  <button
                    className="btn"
                    onClick={() => backToSshConnectInfo()}
                    type="button"
                    disabled={sshBusy || remoteWorkspaceScanBusy || sshNewWorkspaceBusy}
                  >
                    上一步
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => void connectRemoteWorkspace()}
                    type="button"
                    disabled={sshBusy || remoteWorkspaceScanBusy || sshNewWorkspaceBusy}
                  >
                    {sshBusy ? "连接中…" : "进入工作区"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {apiOpen ? (
        <div className="modalOverlay" onClick={() => closeApiSettings()}>
          <div className="modal apiModal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">API 设置</div>
              <button className="iconBtn" onClick={() => closeApiSettings()} aria-label="Close" type="button">
                ×
              </button>
            </div>

            <div className="modalBody">
              <div className="apiLiveBox">
                <div className="apiLiveTop">
                  <div className="apiSectionTitle">当前 Codex</div>
                  <div className="row">
                    <button
                      className="btn tiny"
                      onClick={() => void refreshApiSettings()}
                      disabled={apiBusy}
                      type="button"
                    >
                      {apiBusy ? "读取中…" : "刷新"}
                    </button>
                    <button
                      className="btn tiny"
                      onClick={async () => {
                        if (!apiLiveCodexHome.trim()) {
                          return;
                        }
                        try {
                          await window.tazhan.openInExplorer(apiLiveCodexHome);
                        } catch {
                        }
                      }}
                      type="button"
                      disabled={!apiLiveCodexHome.trim()}
                    >
                      打开目录
                    </button>
                  </div>
                </div>
                <div className="apiLiveMeta">
                  <div className="muted">
                    {`Provider：${apiLiveModelProvider ?? "(未知)"} · Base URL：${apiLiveBaseUrl || "(未设置)"} · Key：${
                      apiLiveKeyPresent ? apiLiveKeyMasked ?? "****" : "未设置"
                    }`}
                  </div>
                  <div className="hint">
                    {apiLiveConfigPath.trim() ? `config.toml: ${apiLiveConfigPath}` : "config.toml: (未知)"}
                    <br />
                    {apiLiveAuthPath.trim() ? `auth.json: ${apiLiveAuthPath}` : "auth.json: (未知)"}
                  </div>
                </div>
              </div>

              <div className="apiGrid">
                <div className="apiProfilesPanel">
                  <div className="apiProfilesHeader">
                    <div className="apiSectionTitle">提供商</div>
                    <div className="row">
                      <button
                        className="btn tiny primary"
                        onClick={async () => {
                          const s = settingsRef.current;
                          if (!s) {
                            return;
                          }
                          const created = makeNewApiProfile();
                          const nextList = [created, ...(s.apiProfiles ?? [])];
                          await saveSettingsPatch({
                            apiProfiles: nextList,
                            apiActiveProfileId: s.apiActiveProfileId ?? null
                          });
                          selectApiProfile(created.id);
                        }}
                        type="button"
                      >
                        新增
                      </button>
                      <button
                        className="btn tiny"
                        onClick={async () => {
                          const s = settingsRef.current;
                          if (!s || !apiSelectedProfileId) {
                            return;
                          }
                          const nextList = (s.apiProfiles ?? []).filter((p) => p.id !== apiSelectedProfileId);
                          const nextActive =
                            s.apiActiveProfileId === apiSelectedProfileId ? nextList[0]?.id ?? null : s.apiActiveProfileId;
                          await saveSettingsPatch({ apiProfiles: nextList, apiActiveProfileId: nextActive ?? null });
                          selectApiProfile(nextActive && nextList.some((p) => p.id === nextActive) ? nextActive : nextList[0]?.id ?? null);
                        }}
                        disabled={!apiSelectedProfileId}
                        type="button"
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  <div className="apiProfileList">
                    {(settings?.apiProfiles?.length ? settings.apiProfiles : []).map((p) => {
                      const active = p.id === apiSelectedProfileId;
                      const isDefault = settings?.apiActiveProfileId === p.id;
                      return (
                        <button
                          key={p.id}
                          className={active ? "apiProfileItem active" : "apiProfileItem"}
                          onClick={() => selectApiProfile(p.id)}
                          type="button"
                          title={p.codexProvider}
                        >
                          <div className="apiProfileTitleRow">
                            <div className="apiProfileName">{p.name}</div>
                            {isDefault ? <span className="apiProfileBadge">默认</span> : null}
                          </div>
                          <div className="apiProfileSub">{p.baseUrl.trim() ? p.baseUrl : "未设置 Base URL"}</div>
                        </button>
                      );
                    })}
                    {!settings?.apiProfiles?.length ? <div className="muted apiEmpty">暂无提供商</div> : null}
                  </div>
                </div>

                <div className="apiEditorPanel">
                  <div className="field">
                    <div className="label">名称</div>
                    <input value={apiProfileName} onChange={(e) => setApiProfileName(e.target.value)} placeholder="例如：OpenAI / NewAPI" />
                  </div>

                  <div className="field">
                    <div className="label">Provider 标识（写入 config.toml）</div>
                    <input
                      value={apiProfileProvider}
                      onChange={(e) => setApiProfileProvider(e.target.value)}
                      placeholder="例如：openai / packycode / newapi"
                    />
                    <div className="hint">仅允许字母/数字/下划线/短横线</div>
                  </div>

                  <div className="field">
                    <div className="label">Base URL</div>
                    <input
                      value={apiProfileBaseUrl}
                      placeholder="输入 Provider Base URL"
                      onChange={(e) => setApiProfileBaseUrl(e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <div className="label">API Key</div>
                    <div className="row">
                      <input
                        type={apiProfileShowKey ? "text" : "password"}
                        value={apiProfileApiKey}
                        placeholder="粘贴 API Key..."
                        onChange={(e) => setApiProfileApiKey(e.target.value)}
                      />
                      <button className="btn tiny" onClick={() => setApiProfileShowKey((v) => !v)} type="button">
                        {apiProfileShowKey ? "隐藏" : "显示"}
                      </button>
                    </div>
                    <div className="hint">保存到本地 settings.json；应用后会写入 ~/.codex/auth.json</div>
                  </div>

                  {apiTestResult ? (
                    <div className={apiTestResult.ok ? "apiTestBox ok" : "apiTestBox bad"}>
                      {apiTestResult.ok
                        ? `测试成功${apiTestResult.latencyMs !== null ? ` · ${apiTestResult.latencyMs}ms` : ""}${
                            apiTestResult.modelsCount !== null ? ` · models=${apiTestResult.modelsCount}` : ""
                          }`
                        : `测试失败${apiTestResult.status ? ` · HTTP ${apiTestResult.status}` : ""} · ${apiTestResult.error ?? ""}`}
                      {!apiTestResult.ok && apiTestResult.suggestedBaseUrl ? (
                        <div className="hint">{`提示：可能需要 /v1，建议 Base URL 改为 ${apiTestResult.suggestedBaseUrl}`}</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {apiError ? <div className="errorText">{apiError}</div> : null}
            </div>

            <div className="modalFooter">
              <button className="btn" onClick={() => closeApiSettings()} type="button">
                取消
              </button>
              <button
                className="btn"
                onClick={() => void saveApiProfileDraft(false)}
                disabled={apiBusy}
                type="button"
              >
                保存到列表
              </button>
              <button
                className="btn"
                onClick={async () => {
                  setApiTestBusy(true);
                  setApiTestResult(null);
                  try {
                    const res = await window.tazhan.codexProviderTest({
                      baseUrl: apiProfileBaseUrl.trim(),
                      apiKey: apiProfileApiKey.trim()
                    });
                    setApiTestResult(res);
                  } catch (err) {
                    setApiTestResult({
                      ok: false,
                      latencyMs: null,
                      status: null,
                      modelsCount: null,
                      suggestedBaseUrl: null,
                      error: String(err)
                    });
                  } finally {
                    setApiTestBusy(false);
                  }
                }}
                disabled={apiTestBusy}
                type="button"
              >
                {apiTestBusy ? "测试中…" : "测试"}
              </button>
              <button
                className="btn primary"
                onClick={() => void applyApiProfileDraft()}
                disabled={apiBusy || !apiProfileProvider.trim() || !apiProfileBaseUrl.trim()}
                type="button"
              >
                {apiBusy ? "处理中…" : "应用并重连"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameThreadId ? (
        <div className="modalOverlay" onClick={() => closeRenameThread()}>
          <div className="modal smallModal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">重命名会话</div>
              <div className="label">{renameThreadId}</div>
              <button className="iconBtn" onClick={() => closeRenameThread()} aria-label="Close" type="button">
                ×
              </button>
            </div>
            <div className="modalBody">
              <div className="field">
                <div className="label">名称</div>
                <input
                  value={renameThreadName}
                  placeholder="输入名称..."
                  autoFocus
                  onChange={(e) => setRenameThreadName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void confirmRenameThread();
                    }
                  }}
                />
              </div>
            </div>
            <div className="modalFooter">
              <button className="btn" onClick={() => closeRenameThread()} type="button">
                取消
              </button>
              <button
                className="btn primary"
                onClick={() => void confirmRenameThread()}
                disabled={!renameThreadName.trim()}
                type="button"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingApproval ? (
        <div className="modalOverlay">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">需要确认</div>
              <div className="label">
                {pendingApproval.method}
                {pendingApproval.threadId ? ` · ${pendingApproval.threadId}` : ""}
              </div>
            </div>
            <div className="modalBody">
              <div className="kicker">请求内容</div>
              <div className="mono">{stringifyShort(pendingApproval.params)}</div>
            </div>
            <div className="modalFooter">
              <button className="btn" onClick={() => void respondApproval("acceptForSession")}>
                本次会话允许
              </button>
              <button className="btn primary" onClick={() => void respondApproval("accept")}>
                允许
              </button>
              <button className="btn" onClick={() => void respondApproval("decline")}>
                拒绝
              </button>
              <button className="btn danger" onClick={() => void respondApproval("cancel")}>
                取消回合
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
