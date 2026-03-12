import fs from "node:fs/promises";
import path from "node:path";

import type { AppSettings } from "../shared/types";

const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  codexPath: "codex",
  defaultCwd: "",
  notifyWebhookUrl: "",
  model: "",
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  reasoningEffort: "",
  notifyOnComplete: true,
  notifyThreads: {},
  autoReply: { enabled: false, message: "", mode: "infinite", times: 1 },
  workspaceNames: {},
  apiProfiles: [],
  apiActiveProfileId: null,
  relay: {
    enabled: false,
    baseUrl: "",
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
  sshDefaults: { host: "", port: 22, username: "", workspaceRoot: "" }
};

export class SettingsStore {
  private readonly filePath: string;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, "settings.json");
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppSettings> | null;
      // Deep-merge nested objects so new default fields (e.g. relay/e2ee) are not lost
      // when loading older settings files.
      return mergeSettings(DEFAULT_SETTINGS, parsed ?? {});
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async save(next: AppSettings): Promise<void> {
    const json = JSON.stringify(next, null, 2);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, json, "utf8");
  }
}

export function mergeSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    theme: patch.theme ?? current.theme,
    codexPath: patch.codexPath ?? current.codexPath,
    defaultCwd: patch.defaultCwd ?? current.defaultCwd,
    notifyWebhookUrl: patch.notifyWebhookUrl ?? current.notifyWebhookUrl,
    model: patch.model ?? current.model,
    approvalPolicy: patch.approvalPolicy ?? current.approvalPolicy,
    sandbox: patch.sandbox ?? current.sandbox,
    reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort,
    notifyOnComplete: patch.notifyOnComplete ?? current.notifyOnComplete,
    notifyThreads: patch.notifyThreads
      ? { ...current.notifyThreads, ...patch.notifyThreads }
      : current.notifyThreads,
    autoReply: patch.autoReply ? { ...current.autoReply, ...patch.autoReply } : current.autoReply,
    workspaceNames: patch.workspaceNames
      ? { ...current.workspaceNames, ...patch.workspaceNames }
      : current.workspaceNames,
    apiProfiles: patch.apiProfiles ?? current.apiProfiles,
    apiActiveProfileId: patch.apiActiveProfileId ?? current.apiActiveProfileId,
    relay: patch.relay
      ? {
          ...current.relay,
          ...patch.relay,
          auth: patch.relay.auth === undefined ? current.relay.auth : patch.relay.auth,
          allowedRoots: patch.relay.allowedRoots ?? current.relay.allowedRoots,
          e2ee: patch.relay.e2ee
            ? { ...current.relay.e2ee, ...patch.relay.e2ee, trustedPeers: patch.relay.e2ee.trustedPeers ?? current.relay.e2ee.trustedPeers }
            : current.relay.e2ee
        }
      : current.relay,
    sshDefaults: patch.sshDefaults ? { ...current.sshDefaults, ...patch.sshDefaults } : current.sshDefaults
  };
}
