import path from "node:path";

import type { CodexEvent, JsonValue, RelaySettings } from "../../shared/types";
import type { RelayDeviceClient } from "./relayDeviceClient";

type RpcId = string | number;

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

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || typeof value === "number";
}

function isRpcRequest(value: unknown): value is RpcRequest {
  return isRecord(value) && isRpcId(value.id) && typeof value.method === "string";
}

function isRpcNotification(value: unknown): value is RpcNotification {
  return isRecord(value) && typeof value.method === "string" && !hasOwn(value, "id");
}

function isRpcResponse(value: unknown): value is RpcResponse {
  if (!isRecord(value) || !isRpcId(value.id)) {
    return false;
  }
  if (hasOwn(value, "method") && value.method !== undefined) {
    return false;
  }
  return hasOwn(value, "result") || hasOwn(value, "error");
}

function isRpcError(value: unknown): value is RpcError {
  return isRecord(value) && typeof value.code === "number" && typeof value.message === "string";
}

function normalizeWindowsPath(p: string): string {
  return p.replaceAll("/", "\\");
}

function isWithinAllowedRoots(relay: RelaySettings, cwd: string): boolean {
  const raw = cwd.trim();
  if (!raw) {
    return true;
  }

  const roots = relay.allowedRoots ?? [];
  if (roots.length === 0) {
    return false;
  }

  const candidateAbs = path.resolve(raw);
  for (const root of roots) {
    const rootAbs = path.resolve(root);
    if (process.platform === "win32") {
      const a = normalizeWindowsPath(rootAbs).toLowerCase();
      const b = normalizeWindowsPath(candidateAbs).toLowerCase();
      if (b === a || b.startsWith(`${a}\\`)) {
        return true;
      }
      continue;
    }

    if (candidateAbs === rootAbs || candidateAbs.startsWith(`${rootAbs}${path.sep}`)) {
      return true;
    }
  }

  return false;
}

function coerceRpcForCodex(method: string, params: unknown, relay: RelaySettings): unknown {
  if (isRecord(params) && typeof params.cwd === "string") {
    const cwd = params.cwd;
    if (!isWithinAllowedRoots(relay, cwd)) {
      throw new Error(`remote cwd not allowed: ${cwd}`);
    }
  }

  if (method === "thread/start" || method === "turn/start") {
    if (isRecord(params)) {
      const next: Record<string, unknown> = { ...params };
      next.approvalPolicy = relayDefaultsApproval(relay);
      next.sandbox = relayDefaultsSandbox(relay);
      return next;
    }
    return { approvalPolicy: relayDefaultsApproval(relay), sandbox: relayDefaultsSandbox(relay) };
  }

  return params;
}

function relayDefaultsApproval(_relay: RelaySettings): string {
  return "on-request";
}

function relayDefaultsSandbox(_relay: RelaySettings): string {
  return "workspace-write";
}

export async function handleRelayRpc(params: {
  relay: RelayDeviceClient;
  relaySettings: RelaySettings;
  rpc: JsonValue;
  ensureCodexConnected: () => Promise<void>;
  codexCall: (method: string, params?: unknown) => Promise<unknown>;
  codexNotify: (method: string, params?: unknown) => void;
  codexRespond: (id: RpcId, result: unknown) => void;
  codexRespondError?: (id: RpcId, error: RpcError) => void;
}): Promise<void> {
  const { relay, rpc, ensureCodexConnected, codexCall, codexNotify, codexRespond, codexRespondError, relaySettings } =
    params;

  if (isRpcRequest(rpc)) {
    await ensureCodexConnected();
    const remoteId = rpc.id;
    try {
      const coerced = coerceRpcForCodex(rpc.method, rpc.params, relaySettings);
      const result = await codexCall(rpc.method, coerced);
      relay.sendRpc({ id: remoteId, result } as JsonValue);
    } catch (err) {
      const e = err as Error & { rpc?: unknown };
      const rpcErr = isRpcError(e.rpc) ? (e.rpc as RpcError) : ({ code: -32000, message: e.message } satisfies RpcError);
      relay.sendRpc({ id: remoteId, error: rpcErr } as JsonValue);
    }
    return;
  }

  if (isRpcNotification(rpc)) {
    await ensureCodexConnected();
    const coerced = coerceRpcForCodex(rpc.method, rpc.params, relaySettings);
    codexNotify(rpc.method, coerced);
    return;
  }

  if (isRpcResponse(rpc)) {
    await ensureCodexConnected();
    if (rpc.error && codexRespondError) {
      codexRespondError(rpc.id, rpc.error);
    } else {
      codexRespond(rpc.id, rpc.result ?? {});
    }
  }
}

export function forwardCodexEventToRelay(relay: RelayDeviceClient, ev: CodexEvent): void {
  if (ev.type === "notification") {
    const rpc: JsonValue =
      ev.params === undefined ? ({ method: ev.method } as JsonValue) : ({ method: ev.method, params: ev.params } as JsonValue);
    relay.sendRpc(rpc);
    return;
  }
  if (ev.type === "request") {
    const rpc: JsonValue =
      ev.params === undefined
        ? ({ id: ev.id, method: ev.method } as JsonValue)
        : ({ id: ev.id, method: ev.method, params: ev.params } as JsonValue);
    relay.sendRpc(rpc);
  }
}
