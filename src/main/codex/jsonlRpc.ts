import { EventEmitter } from "node:events";
import readline from "node:readline";

import type { RpcId } from "../../shared/types";

type RpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type RpcRequest = {
  id: RpcId;
  method: string;
  params?: unknown;
};

type RpcNotification = {
  method: string;
  params?: unknown;
};

type RpcResponse = {
  id: RpcId;
  result?: unknown;
  error?: RpcError;
};

function hasOwn(obj: unknown, key: string): obj is Record<string, unknown> {
  return typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "number" || typeof value === "string";
}

function isRpcRequest(value: unknown): value is RpcRequest {
  return (
    hasOwn(value, "id") &&
    isRpcId(value.id) &&
    hasOwn(value, "method") &&
    typeof value.method === "string"
  );
}

function isRpcNotification(value: unknown): value is RpcNotification {
  return hasOwn(value, "method") && typeof value.method === "string" && !hasOwn(value, "id");
}

function isRpcResponse(value: unknown): value is RpcResponse {
  return hasOwn(value, "id") && isRpcId(value.id) && (!hasOwn(value, "method") || value.method === undefined);
}

export type JsonlRpcClientEvents = {
  notification: (msg: RpcNotification) => void;
  request: (msg: RpcRequest) => void;
  disconnected: (reason?: string) => void;
};

type JsonlRpcClientOptions = {
  onNonJsonLine?: (line: string) => void;
  onUnknownJson?: (json: unknown) => void;
};

export class JsonlRpcClient extends EventEmitter {
  private readonly rl: readline.Interface;
  private readonly writable: NodeJS.WritableStream;
  private nextId = 1_000_000;
  private readonly opts: JsonlRpcClientOptions;
  private readonly pending = new Map<
    RpcId,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      method: string;
    }
  >();

  constructor(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream, opts?: JsonlRpcClientOptions) {
    super();
    this.writable = writable;
    this.opts = opts ?? {};
    this.rl = readline.createInterface({ input: readable, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.handleLine(line));
    this.rl.on("close", () => this.handleClose("stream closed"));
  }

  call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload: RpcRequest = params === undefined ? { id, method } : { id, method, params };
    this.send(payload);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  notify(method: string, params?: unknown): void {
    const payload: RpcNotification = params === undefined ? { method } : { method, params };
    this.send(payload);
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: RpcId, error: RpcError): void {
    this.send({ id, error });
  }

  dispose(reason?: string): void {
    this.handleClose(reason ?? "disposed");
    this.rl.close();
  }

  private send(obj: unknown): void {
    const json = JSON.stringify(obj);
    this.writable.write(`${json}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.opts.onNonJsonLine?.(trimmed);
      return;
    }

    if (isRpcRequest(msg)) {
      this.emit("request", msg);
      return;
    }

    if (isRpcNotification(msg)) {
      this.emit("notification", msg);
      return;
    }

    if (isRpcResponse(msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        this.opts.onUnknownJson?.(msg);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        const message = `RPC error for ${pending.method}: ${msg.error.message}`;
        const err = new Error(message);
        (err as Error & { rpc?: RpcError }).rpc = msg.error;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    this.opts.onUnknownJson?.(msg);
  }

  private handleClose(reason?: string): void {
    if (this.pending.size > 0) {
      for (const [id, pending] of this.pending.entries()) {
        this.pending.delete(id);
        pending.reject(new Error(`RPC disconnected while awaiting ${pending.method} (id=${String(id)})`));
      }
    }
    this.emit("disconnected", reason);
  }
}
