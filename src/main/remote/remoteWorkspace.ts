import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";

import { Client } from "ssh2";

import { JsonlRpcClient } from "../codex/jsonlRpc";
import type {
  CodexEvent,
  RemoteWorkspaceConnectArgs,
  RemoteWorkspaceStatus,
  RpcId,
  TerminalCreateArgs,
  TerminalRunResult,
  WorkspaceDirEntry,
  WorkspaceListDirResult,
  WorkspaceOpResult,
  WorkspacePathResult,
  WorkspaceReadFileResult
} from "../../shared/types";

import type { SFTPWrapper, ClientChannel, Stats } from "ssh2";

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

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}

function truncateLine(line: string): string {
  const s = String(line ?? "");
  if (s.length <= 600) {
    return s;
  }
  return `${s.slice(0, 600)}…`;
}

function firstLine(text: string): string {
  return (
    String(text ?? "")
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? ""
  );
}

function shQuotePosix(value: string): string {
  // Safe single-quote for POSIX shells.
  const s = String(value ?? "");
  return `'${s.replaceAll("'", `'\"'\"'`)}'`;
}

function normalizePosixAbs(p: string): string {
  return path.posix.resolve("/", p);
}

function isWithinRootPosix(rootAbs: string, candidateAbs: string): boolean {
  if (candidateAbs === rootAbs) {
    return true;
  }
  return candidateAbs.startsWith(`${rootAbs}/`);
}

function isSafeName(name: string): boolean {
  const s = name.trim();
  if (!s) {
    return false;
  }
  if (s === "." || s === "..") {
    return false;
  }
  if (s.includes("/") || s.includes("\\") || s.includes("\0")) {
    return false;
  }
  return true;
}

function statsKind(st: Stats): "dir" | "file" {
  if (typeof st.isDirectory === "function" && st.isDirectory()) {
    return "dir";
  }
  return "file";
}

async function sftpStat(sftp: SFTPWrapper, p: string): Promise<Stats> {
  return await new Promise((resolve, reject) => {
    sftp.lstat(p, (err, st) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(st);
    });
  });
}

async function sftpReaddir(sftp: SFTPWrapper, p: string): Promise<readonly { filename: string; attrs: Stats }[]> {
  return await new Promise((resolve, reject) => {
    sftp.readdir(p, (err, list) => {
      if (err) {
        reject(err);
        return;
      }
      resolve((list ?? []).map((it) => ({ filename: it.filename, attrs: it.attrs })));
    });
  });
}

async function sftpMkdir(sftp: SFTPWrapper, p: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.mkdir(p, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function ensureDir(sftp: SFTPWrapper, p: string): Promise<void> {
  const abs = normalizePosixAbs(p);
  const parts = abs.split("/").filter(Boolean);
  let cur = "/";
  for (const part of parts) {
    cur = path.posix.join(cur, part);
    try {
      const st = await sftpStat(sftp, cur);
      if (statsKind(st) !== "dir") {
        throw new Error("path is not a directory");
      }
      continue;
    } catch {
      // try create
    }
    await sftpMkdir(sftp, cur);
  }
}

async function sftpWriteFile(sftp: SFTPWrapper, fileAbs: string, content: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = sftp.createWriteStream(fileAbs, { flags: "w", encoding: "utf8" });
    stream.on("error", (err: unknown) => reject(err));
    stream.on("finish", () => resolve());
    stream.end(content, "utf8");
  });
}

async function sftpFastPut(sftp: SFTPWrapper, localPath: string, remoteAbs: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.fastPut(localPath, remoteAbs, (err?: unknown) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function sftpCreateEmptyFileExclusive(sftp: SFTPWrapper, fileAbs: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.open(fileAbs, "wx", (err, handle) => {
      if (err) {
        reject(err);
        return;
      }
      sftp.close(handle, (closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve();
      });
    });
  });
}

async function sftpRename(sftp: SFTPWrapper, fromAbs: string, toAbs: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.rename(fromAbs, toAbs, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function sftpUnlink(sftp: SFTPWrapper, p: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.unlink(p, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function sftpRmdir(sftp: SFTPWrapper, p: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(p, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function sftpDeleteRecursive(sftp: SFTPWrapper, targetAbs: string): Promise<void> {
  const st = await sftpStat(sftp, targetAbs);
  if (typeof st.isSymbolicLink === "function" && st.isSymbolicLink()) {
    await sftpUnlink(sftp, targetAbs);
    return;
  }

  if (statsKind(st) === "file") {
    await sftpUnlink(sftp, targetAbs);
    return;
  }

  const items = await sftpReaddir(sftp, targetAbs);
  for (const it of items) {
    const name = it.filename;
    if (!name || name === "." || name === "..") {
      continue;
    }
    await sftpDeleteRecursive(sftp, path.posix.join(targetAbs, name));
  }
  await sftpRmdir(sftp, targetAbs);
}

async function sftpReadFileLimited(
  sftp: SFTPWrapper,
  fileAbs: string,
  maxBytes: number
): Promise<{ content: string; truncated: boolean }> {
  const st = await sftpStat(sftp, fileAbs);
  if (statsKind(st) === "dir") {
    throw new Error("path is a directory");
  }

  let size = typeof (st as any).size === "number" ? ((st as any).size as number) : null;
  if (size === null || !Number.isFinite(size)) {
    size = null;
  }
  const truncated = size !== null ? size > maxBytes : false;

  const toRead = size !== null ? Math.min(size, maxBytes) : maxBytes;
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = sftp.createReadStream(fileAbs, { start: 0, end: Math.max(0, toRead - 1) });
    stream.on("error", (err: unknown) => reject(err));
    stream.on("data", (chunk: Buffer) => {
      if (total >= toRead) {
        return;
      }
      const buf = Buffer.from(chunk);
      const remain = toRead - total;
      chunks.push(remain < buf.length ? buf.slice(0, remain) : buf);
      total += Math.min(remain, buf.length);
      if (total >= toRead) {
        stream.destroy();
      }
    });
    stream.on("close", () => resolve());
    stream.on("end", () => resolve());
  });

  return { content: Buffer.concat(chunks).toString("utf8"), truncated };
}

async function execSshOnce(client: Client, command: string, timeoutMs: number): Promise<ExecResult> {
  return await withTimeout(
    new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, { pty: false }, (err, stream) => {
        if (err || !stream) {
          reject(err ?? new Error("ssh exec failed"));
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        stream.on("close", (code: number | null) => resolve({ stdout, stderr, code }));
        stream.on("error", (e: unknown) => reject(e));
      });
    }),
    timeoutMs,
    `ssh exec: ${command}`
  );
}

async function detectCodexBin(client: Client): Promise<string | null> {
  const direct = firstLine((await execSshOnce(client, "sh -c \"command -v codex 2>/dev/null || true\"", 4000)).stdout);
  if (direct) {
    return direct;
  }

  const viaBash = firstLine(
    (await execSshOnce(client, "sh -c \"command -v bash >/dev/null 2>&1 && bash -lc 'command -v codex 2>/dev/null || true' || true\"", 5000))
      .stdout
  );
  if (viaBash) {
    return viaBash;
  }

  // nvm installs global npm bins under ~/.nvm/versions/node/<ver>/bin.
  // This often isn't on PATH for non-interactive ssh exec shells.
  const viaNvm = firstLine(
    (
      await execSshOnce(
        client,
        "sh -c \"if [ -d \\\"$HOME/.nvm/versions/node\\\" ]; then ls -1d \\\"$HOME\\\"/.nvm/versions/node/*/bin/codex 2>/dev/null | (command -v sort >/dev/null 2>&1 && sort -V || cat) | tail -n 1; fi\"",
        6000
      )
    ).stdout
  );
  if (viaNvm) {
    return viaNvm;
  }

  const viaNpmPrefix = firstLine(
    (
      await execSshOnce(
        client,
        "sh -c \"P=$(npm prefix -g 2>/dev/null || true); if [ -n \\\"$P\\\" ] && [ -x \\\"$P/bin/codex\\\" ]; then echo \\\"$P/bin/codex\\\"; fi\"",
        6000
      )
    ).stdout
  );
  if (viaNpmPrefix) {
    return viaNpmPrefix;
  }

  const viaPnpm = firstLine(
    (
      await execSshOnce(
        client,
        "sh -c \"if command -v pnpm >/dev/null 2>&1; then B=$(pnpm -g bin 2>/dev/null || true); if [ -n \\\"$B\\\" ] && [ -x \\\"$B/codex\\\" ]; then echo \\\"$B/codex\\\"; fi; fi\"",
        6000
      )
    ).stdout
  );
  if (viaPnpm) {
    return viaPnpm;
  }

  return null;
}

async function detectNodeBin(client: Client, codexBin: string): Promise<string | null> {
  const inferred = `${path.posix.dirname(codexBin)}/node`;
  const ok = firstLine(
    (
      await execSshOnce(
        client,
        `sh -c "if [ -x ${shQuotePosix(inferred)} ]; then echo OK; fi"`,
        4000
      )
    ).stdout
  );
  if (ok === "OK") {
    return inferred;
  }

  const direct = firstLine((await execSshOnce(client, "sh -c \"command -v node 2>/dev/null || true\"", 4000)).stdout);
  if (direct) {
    return direct;
  }

  const viaBash = firstLine(
    (await execSshOnce(client, "sh -c \"command -v bash >/dev/null 2>&1 && bash -lc 'command -v node 2>/dev/null || true' || true\"", 5000))
      .stdout
  );
  if (viaBash) {
    return viaBash;
  }

  const viaNvm = firstLine(
    (
      await execSshOnce(
        client,
        "sh -c \"if [ -d \\\"$HOME/.nvm/versions/node\\\" ]; then ls -1d \\\"$HOME\\\"/.nvm/versions/node/*/bin/node 2>/dev/null | (command -v sort >/dev/null 2>&1 && sort -V || cat) | tail -n 1; fi\"",
        6000
      )
    ).stdout
  );
  if (viaNvm) {
    return viaNvm;
  }

  return null;
}

async function resolveCodexJs(client: Client, codexBin: string): Promise<string> {
  const quoted = shQuotePosix(codexBin);
  const out = firstLine((await execSshOnce(client, `sh -c "readlink -f ${quoted} 2>/dev/null || true"`, 4000)).stdout);
  if (out) {
    return out;
  }

  // Fallback if readlink isn't available for some reason.
  const py = firstLine(
    (
      await execSshOnce(
        client,
        `sh -c "command -v python3 >/dev/null 2>&1 && python3 - <<'PY'\nimport os\nprint(os.path.realpath(${quoted}))\nPY\n"`,
        6000
      )
    ).stdout
  );
  return py || codexBin;
}

export class RemoteWorkspace extends EventEmitter {
  private ssh: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  private channel: ClientChannel | null = null;
  private rpc: JsonlRpcClient | null = null;
  private connected = false;
  private status: RemoteWorkspaceStatus = { connected: false, host: "", port: 22, username: "", workspaceRoot: "" };
  private useLoginShellForCommands = false;

  constructor(private readonly emitEvent: (ev: CodexEvent) => void) {
    super();
  }

  getStatus(): RemoteWorkspaceStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(args: RemoteWorkspaceConnectArgs, clientInfo: ClientInfo): Promise<void> {
    if (this.connected) {
      return;
    }

    const host = args.host.trim();
    const port = Number.isFinite(args.port) && args.port > 0 ? Math.floor(args.port) : 22;
    const username = args.username.trim();
    const password = args.password;
    const workspaceRoot = normalizePosixAbs(args.workspaceRoot.trim());
    const useLoginShell = args.useLoginShell === true;

    if (!host || !username) {
      throw new Error("missing host or username");
    }
    if (!workspaceRoot.startsWith("/")) {
      throw new Error("workspaceRoot must be an absolute path");
    }

    this.emitEvent({ type: "status", status: "connecting" });
    this.useLoginShellForCommands = useLoginShell;

    this.ssh = new Client();
    const ssh = this.ssh;

    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) {
          return;
        }
        done = true;
        reject(new Error("SSH connect timeout"));
      }, 12_000);

      ssh.on("ready", () => {
        clearTimeout(timer);
        if (done) {
          return;
        }
        done = true;
        resolve();
      });
      ssh.on("error", (err) => {
        clearTimeout(timer);
        if (done) {
          return;
        }
        done = true;
        reject(err);
      });

      ssh.connect({
        host,
        port,
        username,
        password,
        readyTimeout: 12_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3
      });
    });

    this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      ssh.sftp((err, sftp) => {
        if (err || !sftp) {
          reject(err ?? new Error("failed to open sftp"));
          return;
        }
        resolve(sftp);
      });
    });

    // Validate workspace root exists and is a directory.
    const rootStat = await sftpStat(this.sftp, workspaceRoot);
    if (statsKind(rootStat) !== "dir") {
      throw new Error("workspaceRoot is not a directory");
    }

    // Resolve codex/node paths explicitly so we don't depend on login shell PATH.
    const codexBin = await detectCodexBin(ssh);
    if (!codexBin) {
      throw new Error("remote codex not found (PATH not loaded?)");
    }
    const nodeBin = await detectNodeBin(ssh, codexBin);
    if (!nodeBin) {
      throw new Error("remote node not found");
    }
    const codexJs = await resolveCodexJs(ssh, codexBin);

    this.emitEvent({
      type: "stderr",
      line: `[remote] resolved codexBin=${codexBin} nodeBin=${nodeBin} codexJs=${codexJs}`
    });

    // Use node + codex.js to bypass env shebang PATH resolution.
    const appServerCmd = `${shQuotePosix(nodeBin)} ${shQuotePosix(codexJs)} app-server`;
    const cmd = useLoginShell ? `bash -lc ${shQuotePosix(appServerCmd)}` : `sh -c ${shQuotePosix(appServerCmd)}`;
    this.channel = await new Promise<ClientChannel>((resolve, reject) => {
      ssh.exec(cmd, { pty: false }, (err, ch) => {
        if (err || !ch) {
          reject(err ?? new Error("failed to start codex app-server"));
          return;
        }
        resolve(ch as ClientChannel);
      });
    });

    this.channel.on("close", (code?: number, signal?: string) => {
      this.emitEvent({
        type: "status",
        status: "exited",
        details: `remote app-server exited (code=${code ?? "null"} signal=${signal ?? "null"})`
      });
      this.connected = false;
      this.status = { connected: false, host, port, username, workspaceRoot };
    });

    const stderrRl = readline.createInterface({ input: (this.channel as any).stderr, crlfDelay: Infinity });
    stderrRl.on("line", (line) => this.emitEvent({ type: "stderr", line: `[remote] ${line}` }));

    this.rpc = new JsonlRpcClient(this.channel as any, this.channel as any, {
      onNonJsonLine: (line) => this.emitEvent({ type: "stderr", line: `[remote-stdout] ${truncateLine(line)}` }),
      onUnknownJson: (json) => {
        try {
          this.emitEvent({ type: "stderr", line: `[remote-stdout] unknown-json: ${truncateLine(JSON.stringify(json))}` });
        } catch {
          this.emitEvent({ type: "stderr", line: "[remote-stdout] unknown-json: (unserializable)" });
        }
      }
    });
    this.rpc.on("notification", (msg) => this.emitEvent({ type: "notification", method: msg.method, params: msg.params as any }));
    this.rpc.on("request", (msg) => this.emitEvent({ type: "request", id: msg.id, method: msg.method, params: msg.params as any }));
    this.rpc.on("disconnected", (reason) => {
      this.emitEvent({ type: "status", status: "exited", details: `remote rpc disconnected: ${reason ?? ""}`.trim() });
    });

    const initParams: InitializeParams = {
      clientInfo,
      capabilities: { experimentalApi: false }
    };
    await withTimeout(this.rpc.call("initialize", initParams), 12_000, "initialize");
    this.rpc.notify("initialized", {});

    this.connected = true;
    this.status = { connected: true, host, port, username, workspaceRoot };
    this.emitEvent({ type: "status", status: "connected" });
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    if (!this.rpc) {
      throw new Error("remote codex is not connected");
    }
    return this.rpc.call(method, params);
  }

  notify(method: string, params?: unknown): void {
    if (!this.rpc) {
      throw new Error("remote codex is not connected");
    }
    this.rpc.notify(method, params);
  }

  respond(id: RpcId, result: unknown): void {
    if (!this.rpc) {
      throw new Error("remote codex is not connected");
    }
    this.rpc.respond(id, result);
  }

  disconnect(): void {
    try {
      this.rpc?.dispose("disconnect requested");
    } catch {
      // Best-effort.
    }
    this.rpc = null;

    try {
      this.channel?.close();
    } catch {
      // Best-effort.
    }
    try {
      this.channel?.end();
    } catch {
      // Best-effort.
    }
    this.channel = null;

    try {
      this.sftp?.end();
    } catch {
      // Best-effort.
    }
    this.sftp = null;

    try {
      this.ssh?.end();
    } catch {
      // Best-effort.
    }
    this.ssh = null;

    this.connected = false;
    this.status = { connected: false, host: "", port: 22, username: "", workspaceRoot: "" };
    this.emitEvent({ type: "status", status: "disconnected" });
  }

  async terminalRun(cwd: string, command: string, timeoutMs?: number): Promise<TerminalRunResult> {
    if (!this.ssh || !this.connected) {
      return { ok: false, stdout: "", stderr: "", exitCode: null, error: "remote workspace not connected" };
    }
    const cmd = String(command ?? "").trim();
    const rawCwd = String(cwd ?? "").trim();
    if (!cmd) {
      return { ok: false, stdout: "", stderr: "", exitCode: null, error: "missing command" };
    }
    if (!rawCwd) {
      return { ok: false, stdout: "", stderr: "", exitCode: null, error: "missing cwd" };
    }

    const rootAbs = normalizePosixAbs(this.status.workspaceRoot);
    const cwdAbs = normalizePosixAbs(rawCwd);
    if (!isWithinRootPosix(rootAbs, cwdAbs)) {
      return { ok: false, stdout: "", stderr: "", exitCode: null, error: "path is outside the workspace root" };
    }

    const inner = `cd ${shQuotePosix(cwdAbs)} && ${cmd}`;
    const wrapped = this.useLoginShellForCommands ? `bash -lc ${shQuotePosix(inner)}` : `sh -c ${shQuotePosix(inner)}`;
    const budget = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 60_000;

    try {
      const res = await execSshOnce(this.ssh, wrapped, budget);
      return { ok: true, stdout: res.stdout, stderr: res.stderr, exitCode: res.code, error: null };
    } catch (err) {
      return { ok: false, stdout: "", stderr: "", exitCode: null, error: String(err) };
    }
  }

  async terminalOpenPty(args: Pick<TerminalCreateArgs, "cwd" | "cols" | "rows">): Promise<
    | { ok: true; channel: ClientChannel }
    | { ok: false; error: string }
  > {
    if (!this.ssh || !this.connected) {
      return { ok: false, error: "remote workspace not connected" };
    }

    const rawCwd = String(args.cwd ?? "").trim();
    if (!rawCwd) {
      return { ok: false, error: "missing cwd" };
    }

    const cols = Number.isFinite(args.cols) && args.cols > 0 ? Math.floor(args.cols) : 80;
    const rows = Number.isFinite(args.rows) && args.rows > 0 ? Math.floor(args.rows) : 24;

    const rootAbs = normalizePosixAbs(this.status.workspaceRoot);
    const cwdAbs = normalizePosixAbs(rawCwd);
    if (!isWithinRootPosix(rootAbs, cwdAbs)) {
      return { ok: false, error: "path is outside the workspace root" };
    }

    try {
      const ch = await new Promise<ClientChannel>((resolve, reject) => {
        this.ssh!.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
          if (err || !stream) {
            reject(err ?? new Error("ssh shell failed"));
            return;
          }
          resolve(stream as ClientChannel);
        });
      });

      // Best-effort: start in the requested directory.
      ch.write(`cd ${shQuotePosix(cwdAbs)}\n`);
      return { ok: true, channel: ch };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async listDir(root: string, dir: string): Promise<WorkspaceListDirResult> {
    if (!this.sftp || !this.connected) {
      return { ok: false, entries: [], error: "remote workspace not connected" };
    }

    try {
      const rootAbs = normalizePosixAbs(root);
      const dirAbs = normalizePosixAbs(dir);
      if (!isWithinRootPosix(rootAbs, dirAbs)) {
        return { ok: false, entries: [], error: "path is outside the workspace root" };
      }

      const items = await sftpReaddir(this.sftp, dirAbs);
      const entries: WorkspaceDirEntry[] = items
        .map((it) => ({
          name: it.filename,
          path: path.posix.join(dirAbs, it.filename),
          kind: statsKind(it.attrs)
        }))
        .filter((e) => e.name && e.name !== "." && e.name !== "..");

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

  async readFile(root: string, filePath: string): Promise<WorkspaceReadFileResult> {
    if (!this.sftp || !this.connected) {
      return { ok: false, content: "", truncated: false, error: "remote workspace not connected" };
    }

    try {
      const rootAbs = normalizePosixAbs(root);
      const fileAbs = normalizePosixAbs(filePath);
      if (!isWithinRootPosix(rootAbs, fileAbs)) {
        return { ok: false, content: "", truncated: false, error: "path is outside the workspace root" };
      }

      const maxBytes = 400_000;
      const { content, truncated } = await sftpReadFileLimited(this.sftp, fileAbs, maxBytes);
      return { ok: true, content, truncated, error: null };
    } catch (err) {
      return { ok: false, content: "", truncated: false, error: String(err) };
    }
  }

  async mkdir(root: string, parentDir: string, name: string): Promise<WorkspacePathResult> {
    if (!this.sftp || !this.connected) {
      return { ok: false, path: null, error: "remote workspace not connected" };
    }
    if (!isSafeName(name)) {
      return { ok: false, path: null, error: "invalid name" };
    }

    try {
      const rootAbs = normalizePosixAbs(root);
      const parentAbs = normalizePosixAbs(parentDir);
      const targetAbs = normalizePosixAbs(path.posix.join(parentAbs, name.trim()));
      if (!isWithinRootPosix(rootAbs, parentAbs) || !isWithinRootPosix(rootAbs, targetAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" };
      }
      await sftpMkdir(this.sftp, targetAbs);
      return { ok: true, path: targetAbs, error: null };
    } catch (err) {
      return { ok: false, path: null, error: String(err) };
    }
  }

  async createFile(root: string, parentDir: string, name: string): Promise<WorkspacePathResult> {
    if (!this.sftp || !this.connected) {
      return { ok: false, path: null, error: "remote workspace not connected" };
    }
    if (!isSafeName(name)) {
      return { ok: false, path: null, error: "invalid name" };
    }

    try {
      const rootAbs = normalizePosixAbs(root);
      const parentAbs = normalizePosixAbs(parentDir);
      const targetAbs = normalizePosixAbs(path.posix.join(parentAbs, name.trim()));
      if (!isWithinRootPosix(rootAbs, parentAbs) || !isWithinRootPosix(rootAbs, targetAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" };
      }
      await sftpCreateEmptyFileExclusive(this.sftp, targetAbs);
      return { ok: true, path: targetAbs, error: null };
    } catch (err) {
      return { ok: false, path: null, error: String(err) };
    }
  }

  async rename(root: string, fromPath: string, newName: string): Promise<WorkspacePathResult> {
    if (!this.sftp || !this.connected) {
      return { ok: false, path: null, error: "remote workspace not connected" };
    }
    if (!isSafeName(newName)) {
      return { ok: false, path: null, error: "invalid newName" };
    }

    try {
      const rootAbs = normalizePosixAbs(root);
      const fromAbs = normalizePosixAbs(fromPath);
      if (!isWithinRootPosix(rootAbs, fromAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" };
      }
      if (fromAbs === rootAbs) {
        return { ok: false, path: null, error: "cannot rename the workspace root" };
      }
      const toAbs = normalizePosixAbs(path.posix.join(path.posix.dirname(fromAbs), newName.trim()));
      if (!isWithinRootPosix(rootAbs, toAbs)) {
        return { ok: false, path: null, error: "path is outside the workspace root" };
      }
      await sftpRename(this.sftp, fromAbs, toAbs);
      return { ok: true, path: toAbs, error: null };
    } catch (err) {
      return { ok: false, path: null, error: String(err) };
    }
  }

  async delete(root: string, targetPath: string): Promise<WorkspaceOpResult> {
    if (!this.sftp || !this.connected) {
      return { ok: false, error: "remote workspace not connected" };
    }

    try {
      const rootAbs = normalizePosixAbs(root);
      const targetAbs = normalizePosixAbs(targetPath);
      if (!isWithinRootPosix(rootAbs, targetAbs)) {
        return { ok: false, error: "path is outside the workspace root" };
      }
      if (targetAbs === rootAbs) {
        return { ok: false, error: "cannot delete the workspace root" };
      }
      await sftpDeleteRecursive(this.sftp, targetAbs);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async writeFile(root: string, filePath: string, content: string): Promise<WorkspaceOpResult> {
    if (!this.sftp || !this.connected) {
      return { ok: false, error: "remote workspace not connected" };
    }

    try {
      const rootAbs = normalizePosixAbs(root);
      const fileAbs = normalizePosixAbs(filePath);
      if (!isWithinRootPosix(rootAbs, fileAbs)) {
        return { ok: false, error: "path is outside the workspace root" };
      }

      const parent = path.posix.dirname(fileAbs);
      if (!isWithinRootPosix(rootAbs, parent)) {
        return { ok: false, error: "path is outside the workspace root" };
      }

      await ensureDir(this.sftp, parent);
      const st = await sftpStat(this.sftp, fileAbs).catch(() => null);
      if (st && statsKind(st) === "dir") {
        return { ok: false, error: "path is a directory" };
      }

      await sftpWriteFile(this.sftp, fileAbs, content);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async uploadFile(root: string, destDir: string, localPath: string): Promise<WorkspaceOpResult> {
    if (!this.sftp || !this.connected) {
      return { ok: false, error: "remote workspace not connected" };
    }

    try {
      const rootAbs = normalizePosixAbs(root);
      const destDirAbs = normalizePosixAbs(destDir);
      if (!isWithinRootPosix(rootAbs, destDirAbs)) {
        return { ok: false, error: "path is outside the workspace root" };
      }

      const dirStat = await sftpStat(this.sftp, destDirAbs);
      if (statsKind(dirStat) !== "dir") {
        return { ok: false, error: "destDir is not a directory" };
      }

      const st = await fs.stat(localPath);
      if (!st.isFile()) {
        return { ok: false, error: "localPath is not a file" };
      }

      const fileName = path.win32.basename(localPath);
      const remoteAbs = normalizePosixAbs(path.posix.join(destDirAbs, fileName));
      if (!isWithinRootPosix(rootAbs, remoteAbs)) {
        return { ok: false, error: "target is outside the workspace root" };
      }

      await sftpFastPut(this.sftp, localPath, remoteAbs);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async uploadFolder(root: string, destDir: string, localFolder: string): Promise<WorkspaceOpResult> {
    if (!this.sftp || !this.connected) {
      return { ok: false, error: "remote workspace not connected" };
    }

    const uploadRecursive = async (rootAbs: string, localDir: string, remoteDirAbs: string): Promise<void> => {
      await ensureDir(this.sftp!, remoteDirAbs);

      const entries = await fs.readdir(localDir, { withFileTypes: true });
      for (const ent of entries) {
        const localAbs = path.join(localDir, ent.name);
        const remoteAbs = normalizePosixAbs(path.posix.join(remoteDirAbs, ent.name));
        if (!isWithinRootPosix(rootAbs, remoteAbs)) {
          throw new Error(`target is outside the workspace root: ${remoteAbs}`);
        }

        if (ent.isDirectory()) {
          await uploadRecursive(rootAbs, localAbs, remoteAbs);
          continue;
        }

        if (ent.isFile()) {
          await sftpFastPut(this.sftp!, localAbs, remoteAbs);
        }
      }
    };

    try {
      const rootAbs = normalizePosixAbs(root);
      const destDirAbs = normalizePosixAbs(destDir);
      if (!isWithinRootPosix(rootAbs, destDirAbs)) {
        return { ok: false, error: "path is outside the workspace root" };
      }

      const dirStat = await sftpStat(this.sftp, destDirAbs);
      if (statsKind(dirStat) !== "dir") {
        return { ok: false, error: "destDir is not a directory" };
      }

      const st = await fs.stat(localFolder);
      if (!st.isDirectory()) {
        return { ok: false, error: "localFolder is not a directory" };
      }

      const folderName = path.win32.basename(localFolder);
      const remoteBase = normalizePosixAbs(path.posix.join(destDirAbs, folderName));
      if (!isWithinRootPosix(rootAbs, remoteBase)) {
        return { ok: false, error: "target is outside the workspace root" };
      }

      await uploadRecursive(rootAbs, localFolder, remoteBase);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
