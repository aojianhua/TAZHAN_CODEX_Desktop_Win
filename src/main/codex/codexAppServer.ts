import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { JsonlRpcClient } from "./jsonlRpc";
import type { CodexEvent, RpcId } from "../../shared/types";

type ClientInfo = {
  name: string;
  title?: string;
  version: string;
};

type InitializeParams = {
  clientInfo: ClientInfo;
  capabilities?: {
    experimentalApi?: boolean;
  };
};

export class CodexAppServer extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rpc: JsonlRpcClient | null = null;

  constructor(private readonly emitEvent: (ev: CodexEvent) => void) {
    super();
  }

  async connect(codexPath: string, clientInfo: ClientInfo): Promise<void> {
    if (this.proc) {
      return;
    }

    this.emitEvent({ type: "status", status: "connecting" });
    const command = codexPath.trim().length > 0 ? codexPath.trim() : "codex";
    const useShell = process.platform === "win32";
    try {
      // On Windows, npm installs `codex` as `codex.cmd`/`codex.ps1`. Spawning with a shell
      // makes this work consistently without requiring users to set an explicit .exe path.
      // NOTE: Older Codex builds don't support the `--listen` flag on `codex app-server`.
      // Stdio is the default transport, so omit `--listen` for maximum compatibility.
      this.proc = spawn(command, ["app-server"], {
        stdio: "pipe",
        shell: useShell,
        windowsHide: true
      });
    } catch (err) {
      this.emitEvent({
        type: "status",
        status: "exited",
        details: `failed to spawn codex: ${String(err)}`
      });
      throw err;
    }

    this.proc.on("exit", (code, signal) => {
      this.emitEvent({
        type: "status",
        status: "exited",
        details: `app-server exited (code=${code ?? "null"} signal=${signal ?? "null"})`
      });
      this.proc = null;
      this.rpc = null;
    });

    this.proc.on("error", (err) => {
      this.emitEvent({ type: "status", status: "exited", details: `spawn error: ${err.message}` });
      this.proc = null;
      this.rpc = null;
    });

    const stderrRl = readline.createInterface({
      input: this.proc.stderr,
      crlfDelay: Infinity
    });
    stderrRl.on("line", (line) => this.emitEvent({ type: "stderr", line }));

    this.rpc = new JsonlRpcClient(this.proc.stdout, this.proc.stdin, {
      onNonJsonLine: (line) => this.emitEvent({ type: "stderr", line: `[rpc] non-json: ${line}` }),
      onUnknownJson: (json) => {
        try {
          this.emitEvent({ type: "stderr", line: `[rpc] unknown: ${JSON.stringify(json)}` });
        } catch {
          this.emitEvent({ type: "stderr", line: "[rpc] unknown: (unserializable json)" });
        }
      }
    });
    this.rpc.on("notification", (msg) => {
      this.emitEvent({ type: "notification", method: msg.method, params: msg.params as any });
    });
    this.rpc.on("request", (msg) => {
      this.emitEvent({ type: "request", id: msg.id, method: msg.method, params: msg.params as any });
    });
    this.rpc.on("disconnected", (reason) => {
      this.emitEvent({ type: "status", status: "exited", details: reason });
    });

    const initParams: InitializeParams = {
      clientInfo,
      capabilities: { experimentalApi: false }
    };
    await this.rpc.call("initialize", initParams);
    this.rpc.notify("initialized", {});
    this.emitEvent({ type: "status", status: "connected" });
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    if (!this.rpc) {
      throw new Error("codex app-server is not connected");
    }
    return this.rpc.call(method, params);
  }

  notify(method: string, params?: unknown): void {
    if (!this.rpc) {
      throw new Error("codex app-server is not connected");
    }
    this.rpc.notify(method, params);
  }

  respond(id: RpcId, result: unknown): void {
    if (!this.rpc) {
      throw new Error("codex app-server is not connected");
    }
    this.rpc.respond(id, result);
  }

  respondError(id: RpcId, error: { code: number; message: string; data?: unknown }): void {
    if (!this.rpc) {
      throw new Error("codex app-server is not connected");
    }
    this.rpc.respondError(id, error);
  }

  disconnect(): void {
    if (this.rpc) {
      this.rpc.dispose("disconnect requested");
      this.rpc = null;
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.emitEvent({ type: "status", status: "disconnected" });
  }
}
