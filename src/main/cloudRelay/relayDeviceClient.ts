import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import os from "node:os";

import type { JsonValue, RelayDeviceAuth } from "../../shared/types";

type RelayStatus = "disconnected" | "connecting" | "connected";

type RelayDeviceRegisterResponse = {
  device?: { deviceId?: unknown };
  deviceToken?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
  pairing?: { pairingCode?: unknown; expiresAt?: unknown; qrPayload?: unknown };
};

type RelayPairingCodeResponse = {
  pairing?: { pairingCode?: unknown; expiresAt?: unknown; qrPayload?: unknown };
};

type RelayHelloAck = {
  type: "hello/ack";
  connId?: unknown;
  serverTime?: unknown;
  acceptedProtocolVersion?: unknown;
  resumeFromSeq?: unknown;
};

type RelayAck = {
  type: "ack";
  deviceId?: unknown;
  streamId?: unknown;
  lastSeq?: unknown;
};

type RelayError = {
  type: "error";
  code?: unknown;
  message?: unknown;
};

type RelayRpcEnvelope = {
  type: "rpc";
  deviceId?: unknown;
  streamId?: unknown;
  seq?: unknown;
  ts?: unknown;
  rpc?: unknown;
};

type RelayPing = { type: "ping"; ts?: unknown };
type RelayPong = { type: "pong"; ts?: unknown };

type IncomingRelayMessage = RelayHelloAck | RelayAck | RelayError | RelayRpcEnvelope | RelayPing | RelayPong;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRpcId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function isRpcResponseLike(value: unknown): value is { id: string | number } {
  if (!isRecord(value) || !isRpcId(value.id)) {
    return false;
  }
  if ("method" in value && value.method !== undefined) {
    return false;
  }
  return "result" in value || "error" in value;
}

function clampEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) {
    return fallback;
  }
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

function splitUtf8StringByBytes(input: string, maxBytes: number): string[] {
  const s = String(input ?? "");
  if (!s) {
    return [""];
  }
  if (Buffer.byteLength(s, "utf8") <= maxBytes) {
    return [s];
  }

  const out: string[] = [];
  let rest = s;
  while (rest) {
    let lo = 1;
    let hi = rest.length;
    let best = 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      let cand = rest.slice(0, mid);
      // Avoid splitting a surrogate pair.
      const last = cand.charCodeAt(cand.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        cand = cand.slice(0, -1);
      }
      const bytes = Buffer.byteLength(cand, "utf8");
      if (bytes <= maxBytes && cand.length > 0) {
        best = cand.length;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    const chunk = rest.slice(0, best);
    out.push(chunk);
    rest = rest.slice(best);

    // Safety: avoid infinite loops if something weird happens.
    if (out.length > 200_000) {
      break;
    }
  }

  return out;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}


const DEFAULT_MAX_ENVELOPE_BYTES = 1_000_000;
const DEFAULT_MAX_TERMINAL_CHUNK_BYTES = 240_000;

function buildWsUrl(baseUrl: string, wsPath: string): string {
  const u = new URL(baseUrl);
  if (u.protocol === "https:") {
    u.protocol = "wss:";
  } else if (u.protocol === "http:") {
    u.protocol = "ws:";
  }
  u.pathname = wsPath;
  u.search = "";
  u.hash = "";
  return u.toString();
}

function pickPlatform(): "windows" | "macos" | "linux" {
  if (process.platform === "win32") {
    return "windows";
  }
  if (process.platform === "darwin") {
    return "macos";
  }
  return "linux";
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeInt(value: unknown): number | null {
  const n = safeNumber(value);
  if (n === null) {
    return null;
  }
  return Math.floor(n);
}

function parseDeviceAuth(resp: RelayDeviceRegisterResponse): {
  auth: RelayDeviceAuth;
  pairingCode: string;
  pairingExpiresAt: number;
  pairingQrPayload: string;
} {
  const deviceId = safeString(resp.device?.deviceId);
  const accessToken = safeString(resp.deviceToken?.accessToken);
  const refreshToken = safeString(resp.deviceToken?.refreshToken);
  const expiresAt = safeInt(resp.deviceToken?.expiresAt) ?? 0;
  const pairingCode = safeString(resp.pairing?.pairingCode);
  const pairingExpiresAt = safeInt(resp.pairing?.expiresAt) ?? 0;
  const pairingQrPayload = safeString(resp.pairing?.qrPayload) || (pairingCode ? `tazhan://pair?code=${pairingCode}` : "");

  const missing: string[] = [];
  if (!deviceId) {
    missing.push("device.deviceId");
  }
  if (!accessToken) {
    missing.push("deviceToken.accessToken");
  }
  if (!refreshToken) {
    missing.push("deviceToken.refreshToken");
  }
  if (!expiresAt) {
    missing.push("deviceToken.expiresAt");
  }
  if (!pairingCode) {
    missing.push("pairing.pairingCode");
  }
  if (!pairingExpiresAt) {
    missing.push("pairing.expiresAt");
  }
  if (!pairingQrPayload) {
    missing.push("pairing.qrPayload");
  }

  if (missing.length > 0) {
    throw new Error(`invalid device register response (missing: ${missing.join(", ")})`);
  }

  return { auth: { deviceId, accessToken, refreshToken, expiresAt }, pairingCode, pairingExpiresAt, pairingQrPayload };
}

function normalizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export type RelayDeviceClientStatus = {
  status: RelayStatus;
  details?: string;
};

export type RelayDeviceClientState = {
  status: RelayStatus;
  baseUrl: string;
  deviceId: string;
  streamId: string;
  lastAckSeq: number;
  lastSentSeq: number;
  lastError: string | null;
};

export type RelayDeviceClientEvents = {
  status: (ev: RelayDeviceClientStatus) => void;
  rpc: (ev: { rpc: JsonValue }) => void;
  error: (ev: { message: string }) => void;
  pairing: (ev: { pairingCode: string; expiresAt: number; qrPayload: string }) => void;
};

export class RelayDeviceClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private status: RelayStatus = "disconnected";
  private lastError: string | null = null;
  private stopped = true;

  private baseUrl = "";
  private auth: RelayDeviceAuth | null = null;
  private streamId = `strm_${randomUUID()}`;

  private outgoingRpcTransform: ((rpc: JsonValue) => JsonValue) | null = null;

  private nextSeq = 1;
  private lastAckSeq = 0;
  private unacked: { seq: number; json: string }[] = [];

  private unackedCapWarned = false;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  constructor(private readonly log: (line: string) => void) {
    super();
  }

  getState(): RelayDeviceClientState {
    return {
      status: this.status,
      baseUrl: this.baseUrl,
      deviceId: this.auth?.deviceId ?? "",
      streamId: this.streamId,
      lastAckSeq: this.lastAckSeq,
      lastSentSeq: this.nextSeq - 1,
      lastError: this.lastError
    };
  }

  configure(baseUrl: string, auth: RelayDeviceAuth | null): void {
    this.baseUrl = baseUrl.trim();
    this.auth = auth;
  }

  setOutgoingRpcTransform(fn: ((rpc: JsonValue) => JsonValue) | null): void {
    this.outgoingRpcTransform = fn;
  }

  async ensureRegistered(
    appVersion: string,
    e2ee?: null | { deviceKeyId: string; deviceEd25519Pub: string; required?: boolean }
  ): Promise<{ auth: RelayDeviceAuth; pairingCode: string; pairingExpiresAt: number; pairingQrPayload: string }> {
    if (!this.baseUrl) {
      throw new Error("relay baseUrl is not configured");
    }

    const url = new URL("/v1/devices", this.baseUrl).toString();
    const baseBody: Record<string, unknown> = {
      displayName: os.hostname(),
      platform: pickPlatform(),
      agentVersion: appVersion
    };

    const canSendE2ee = Boolean(e2ee?.deviceKeyId?.trim() && e2ee?.deviceEd25519Pub?.trim());

    const buildBody = (mode: "full" | "no_required" | "none"): Record<string, unknown> => {
      const out: Record<string, unknown> = { ...baseBody };
      if (!canSendE2ee || mode === "none") {
        return out;
      }

      const e2: Record<string, unknown> = {
        deviceKeyId: e2ee!.deviceKeyId,
        deviceEd25519Pub: e2ee!.deviceEd25519Pub
      };
      if (mode === "full" && typeof e2ee!.required === "boolean") {
        e2.required = e2ee!.required;
      }
      out.e2ee = e2;
      return out;
    };

    const attempts: Array<{ mode: "full" | "no_required" | "none"; label: string }> = [];
    if (canSendE2ee) {
      attempts.push({ mode: "full", label: "with e2ee" });
      if (typeof e2ee!.required === "boolean") {
        attempts.push({ mode: "no_required", label: "with e2ee (no required)" });
      }
      attempts.push({ mode: "none", label: "without e2ee" });
    } else {
      attempts.push({ mode: "none", label: "without e2ee" });
    }

    let res: Response | null = null;
    let text = "";
    for (const attempt of attempts) {
      const body = buildBody(attempt.mode);
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        break;
      }
      text = await res.text().catch(() => "");
      if (attempt.mode !== "none" && (res.status === 400 || res.status === 422)) {
        this.log(`[relay] register failed ${attempt.label} (${res.status}); retrying...`);
        continue;
      }
      throw new Error(`device register failed (${res.status}): ${text || res.statusText}`);
    }

    if (!res) {
      throw new Error("device register failed: no response");
    }

    const json = (await res.json()) as unknown;
    if (!isRecord(json)) {
      throw new Error("device register failed: invalid JSON");
    }

    const parsed = parseDeviceAuth(json as RelayDeviceRegisterResponse);
    this.auth = parsed.auth;
    this.emit("pairing", { pairingCode: parsed.pairingCode, expiresAt: parsed.pairingExpiresAt, qrPayload: parsed.pairingQrPayload });
    return parsed;
  }

  async refreshAuth(): Promise<RelayDeviceAuth> {
    if (!this.baseUrl) {
      throw new Error("relay baseUrl is not configured");
    }
    const auth = this.auth;
    if (!auth?.deviceId || !auth.refreshToken) {
      throw new Error("relay auth is missing");
    }

    const url = new URL("/v1/device-tokens/refresh", this.baseUrl).toString();
    const body = { deviceId: auth.deviceId, refreshToken: auth.refreshToken };

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`device token refresh failed (${res.status}): ${text || res.statusText}`);
    }

    const json = (await res.json()) as unknown;
    if (!isRecord(json)) {
      throw new Error("device token refresh failed: invalid JSON");
    }

    const deviceToken = (json as any).deviceToken ?? null;
    const accessToken = safeString(deviceToken?.accessToken);
    const refreshToken = safeString(deviceToken?.refreshToken);
    const expiresAt = safeInt(deviceToken?.expiresAt) ?? 0;

    const missing: string[] = [];
    if (!accessToken) {
      missing.push("deviceToken.accessToken");
    }
    if (!refreshToken) {
      missing.push("deviceToken.refreshToken");
    }
    if (!expiresAt) {
      missing.push("deviceToken.expiresAt");
    }
    if (missing.length > 0) {
      throw new Error(`invalid device token refresh response (missing: ${missing.join(", ")})`);
    }

    const next: RelayDeviceAuth = { deviceId: auth.deviceId, accessToken, refreshToken, expiresAt };
    this.auth = next;
    return next;
  }

  async refreshPairingCode(): Promise<{ pairingCode: string; expiresAt: number; qrPayload: string }> {
    if (!this.baseUrl) {
      throw new Error("relay baseUrl is not configured");
    }

    const auth = this.auth;
    if (!auth?.deviceId || !auth.accessToken) {
      throw new Error("relay auth is missing");
    }

    const url = new URL(`/v1/devices/${auth.deviceId}/pairing-codes`, this.baseUrl).toString();

    const attempt = async (accessToken: string): Promise<Response> => {
      return await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` }
      });
    };

    let res = await attempt(auth.accessToken);
    if (res.status === 401 && auth.refreshToken) {
      // Best-effort refresh and retry once.
      try {
        await this.refreshAuth();
      } catch {
        // ignore
      }
      const next = this.auth;
      if (next?.accessToken && next.accessToken !== auth.accessToken) {
        res = await attempt(next.accessToken);
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`pairing code refresh failed (${res.status}): ${text || res.statusText}`);
    }

    const json = (await res.json()) as unknown;
    if (!isRecord(json)) {
      throw new Error("pairing code refresh failed: invalid JSON");
    }

    const pairing = (json as RelayPairingCodeResponse).pairing ?? null;
    const pairingCode = safeString(pairing?.pairingCode);
    const expiresAt = safeInt(pairing?.expiresAt) ?? 0;
    const qrPayload = safeString(pairing?.qrPayload) || (pairingCode ? `tazhan://pair?code=${pairingCode}` : "");

    const missing: string[] = [];
    if (!pairingCode) {
      missing.push("pairing.pairingCode");
    }
    if (!expiresAt) {
      missing.push("pairing.expiresAt");
    }
    if (!qrPayload) {
      missing.push("pairing.qrPayload");
    }
    if (missing.length > 0) {
      throw new Error(`invalid pairing refresh response (missing: ${missing.join(", ")})`);
    }

    this.emit("pairing", { pairingCode, expiresAt, qrPayload });
    return { pairingCode, expiresAt, qrPayload };
  }

  start(): void {
    if (this.ws || this.status === "connecting" || this.status === "connected") {
      return;
    }
    if (!this.baseUrl) {
      this.setStatus("disconnected", "relay baseUrl is empty");
      return;
    }
    if (!this.auth?.deviceId || !this.auth?.accessToken) {
      this.setStatus("disconnected", "relay device auth is missing");
      return;
    }

    this.stopped = false;
    this.setStatus("connecting");
    this.unackedCapWarned = false;
    this.connectInternal();
  }

  stop(reason?: string): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.setStatus("disconnected", reason ?? "stopped");
  }

  sendRpc(rpc: JsonValue): void {
    if (!this.auth?.deviceId) {
      return;
    }

    const maxEnvelopeBytes = clampEnvInt(
      "TAZHAN_RELAY_MAX_ENVELOPE_BYTES",
      DEFAULT_MAX_ENVELOPE_BYTES,
      50_000,
      50_000_000
    );
    const maxTerminalChunkBytes = clampEnvInt(
      "TAZHAN_RELAY_MAX_TERMINAL_CHUNK_BYTES",
      DEFAULT_MAX_TERMINAL_CHUNK_BYTES,
      10_000,
      Math.max(10_000, Math.floor(maxEnvelopeBytes / 2))
    );

    // Chunk terminal stream data aggressively to avoid large websocket frames.
    if (isRecord(rpc) && rpc.method === "tazhan/terminal/event" && isRecord(rpc.params) && rpc.params.type === "data") {
      const terminalId = safeString((rpc.params as any).terminalId);
      const data = safeString((rpc.params as any).data);
      if (data && Buffer.byteLength(data, "utf8") > maxTerminalChunkBytes) {
        const parts = splitUtf8StringByBytes(data, maxTerminalChunkBytes);
        for (const part of parts) {
          this.sendRpc({ method: "tazhan/terminal/event", params: { type: "data", terminalId, data: part } } as any);
        }
        return;
      }
    }

    let payload: JsonValue = rpc;
    const transform = this.outgoingRpcTransform;
    if (transform) {
      try {
        payload = transform(rpc);
      } catch (err) {
        const msg = normalizeError(err);
        this.lastError = msg;
        this.emit("error", { message: msg });
        this.log(`[relay] outgoing rpc transform failed: ${msg}`);
        return;
      }
    }

    const envelope = {
      type: "rpc",
      deviceId: this.auth.deviceId,
      streamId: this.streamId,
      seq: this.nextSeq++,
      ts: Date.now(),
      rpc: payload
    };

    const json = JSON.stringify(envelope);
    const jsonBytes = Buffer.byteLength(json, "utf8");
    if (jsonBytes > maxEnvelopeBytes) {
      const method = isRecord(payload) && typeof payload.method === "string" ? payload.method : "";
      const tag = method ? ` method=${method}` : "";
      this.log(`[relay] dropping oversized rpc jsonBytes=${jsonBytes} max=${maxEnvelopeBytes}${tag}`);

      // If a response is too large, try to fail fast so the caller doesn't hang.
      if (isRpcResponseLike(payload)) {
        const id = (payload as any).id;
        this.sendRpc({ id, error: { code: -32000, message: `response too large (${jsonBytes} bytes)` } } as any);
      }
      return;
    }

    this.unacked.push({ seq: envelope.seq, json });
    // Best-effort bound: if the cloud isn't acking, avoid unbounded memory growth.
    if (this.unacked.length > 20_000) {
      this.unacked.splice(0, this.unacked.length - 20_000);
      if (!this.unackedCapWarned) {
        this.unackedCapWarned = true;
        this.log(
          `[relay] warning: unacked buffer capped at 20000 messages (status=${this.status} lastAckSeq=${this.lastAckSeq} nextSeq=${this.nextSeq}); events may be lost on reconnect`
        );
      }
    }

    this.trySendRpc(json);
  }



  private connectInternal(): void {
    const auth = this.auth;
    if (!auth) {
      this.setStatus("disconnected", "missing auth");
      return;
    }

    const wsUrl = buildWsUrl(this.baseUrl, "/ws/device");
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      this.lastError = normalizeError(err);
      this.emit("error", { message: this.lastError });
      this.scheduleReconnect(`failed to create websocket: ${this.lastError}`);
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      const hello = {
        type: "hello",
        role: "device",
        deviceId: auth.deviceId,
        streamId: this.streamId,
        token: auth.accessToken,
        protocolVersion: 1,
        resumeFromSeq: this.lastAckSeq,
        capabilities: { rpc: true, binary: false }
      };
      this.trySendRaw(JSON.stringify(hello));
    };

    ws.onmessage = (evt) => this.handleWsMessage(evt.data);
    ws.onerror = () => {
      // Error details are generally not surfaced; rely on close.
    };
    ws.onclose = (evt: any) => {
      const code = typeof evt?.code === "number" ? evt.code : null;
      const reason = typeof evt?.reason === "string" ? evt.reason : "";
      const details = code ? `websocket closed code=${code}${reason ? ` reason=${reason}` : ""}` : "websocket closed";

      if (this.ws === ws) {
        this.ws = null;
      }
      if (this.status !== "disconnected") {
        this.setStatus("disconnected", details);
      }
      this.scheduleReconnect(details);
    };
  }

  private handleWsMessage(data: unknown): void {
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : "";
    if (!text.trim()) {
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.log(`[relay] non-json message ignored: ${text.slice(0, 200)}`);
      return;
    }

    if (!isRecord(msg) || typeof msg.type !== "string") {
      this.log("[relay] invalid message ignored");
      return;
    }

    const t = msg.type;
    if (t === "hello/ack") {
      this.handleHelloAck(msg as RelayHelloAck);
      return;
    }
    if (t === "ack") {
      this.handleAck(msg as RelayAck);
      return;
    }
    if (t === "rpc") {
      const env = msg as RelayRpcEnvelope;
      const rpc = env.rpc as unknown;
      if (rpc !== undefined) {
        this.emit("rpc", { rpc: rpc as JsonValue });
      }
      return;
    }
    if (t === "ping") {
      const ping = msg as RelayPing;
      const ts = safeInt(ping.ts) ?? Date.now();
      this.trySendRaw(JSON.stringify({ type: "pong", ts }));
      return;
    }
    if (t === "pong") {
      return;
    }
    if (t === "error") {
      const e = msg as RelayError;
      const code = safeString(e.code);
      const message = safeString(e.message);
      const combined = code ? `${code}: ${message}` : message || "relay error";
      this.lastError = combined;
      this.emit("error", { message: combined });
      this.log(`[relay] server error: ${combined}`);
      return;
    }

    // Unknown types are ignored for forward compatibility.
  }

  private handleHelloAck(msg: RelayHelloAck): void {
    const resume = safeInt(msg.resumeFromSeq);
    if (resume !== null) {
      // Server returns the next expected seq (lastAcked + 1). Convert it to lastAcked.
      const serverLastAck = Math.max(0, resume - 1);

      // Server is the source of truth.
      if (serverLastAck > this.lastAckSeq) {
        this.lastAckSeq = serverLastAck;
        this.pruneUnacked();
      } else if (serverLastAck < this.lastAckSeq) {
        // The server forgot ack state (or a different server). We might not have old messages
        // anymore; start a fresh stream to avoid replaying an inconsistent sequence.
        this.log(
          `[relay] warning: server resumeFromSeq=${resume} (serverLastAck=${serverLastAck}) behind lastAckSeq=${this.lastAckSeq}; resetting stream`
        );
        this.resetStream();
      }
    }

    this.setStatus("connected");
    this.reconnectAttempts = 0;

    // Replay any pending messages the server hasn't acked yet.
    for (const it of this.unacked) {
      if (it.seq > this.lastAckSeq) {
        this.trySendRpc(it.json);
      }
    }
  }
  private handleAck(msg: RelayAck): void {
    const lastSeq = safeInt(msg.lastSeq);
    if (lastSeq === null) {
      return;
    }
    if (lastSeq <= this.lastAckSeq) {
      return;
    }
    this.lastAckSeq = lastSeq;
    this.pruneUnacked();
  }

  private pruneUnacked(): void {
    const ack = this.lastAckSeq;
    if (this.unacked.length === 0) {
      return;
    }
    let idx = 0;
    while (idx < this.unacked.length && this.unacked[idx].seq <= ack) {
      idx++;
    }
    if (idx > 0) {
      this.unacked.splice(0, idx);
    }
  }

  private resetStream(): void {
    this.streamId = `strm_${randomUUID()}`;
    this.nextSeq = 1;
    this.lastAckSeq = 0;
    this.unacked = [];
    this.unackedCapWarned = false;
  }

  private trySendRpc(json: string): void {
    if (this.status !== "connected") {
      return;
    }
    this.trySendRaw(json);
  }

  private trySendRaw(json: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      ws.send(json);
    } catch (err) {
      this.lastError = normalizeError(err);
      this.emit("error", { message: this.lastError });
      this.log(`[relay] send failed: ${this.lastError}`);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }

    const attempt = this.reconnectAttempts++;
    const delayMs = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempt, 5)));
    this.log(`[relay] reconnect scheduled in ${delayMs}ms: ${reason}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) {
        return;
      }
      this.setStatus("connecting", "reconnecting");
      this.connectInternal();
    }, delayMs);
  }

  private setStatus(status: RelayStatus, details?: string): void {
    this.status = status;
    if (status === "connected") {
      this.lastError = null;
    } else if (details) {
      this.lastError = details;
    }
    this.emit("status", { status, details });
  }
}
