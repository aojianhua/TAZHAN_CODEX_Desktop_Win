import path from "node:path";

import { Client } from "ssh2";

import type {
  RemoteWorkspaceCandidate,
  RemoteWorkspaceMkdirAbsArgs,
  RemoteWorkspaceMkdirAbsResult,
  RemoteWorkspaceScanResult,
  SshProbeArgs
} from "../shared/types";

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

function firstLine(text: string): string {
  return (
    text
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

function execSsh(client: Client, command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.exec(command, { pty: false }, (err, stream) => {
      if (err || !stream) {
        clearTimeout(timer);
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
      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (done) {
          return;
        }
        done = true;
        resolve({ stdout, stderr, code });
      });
      stream.on("error", (e: unknown) => {
        clearTimeout(timer);
        if (done) {
          return;
        }
        done = true;
        reject(e);
      });
    });
  });
}

async function sftpStatSafe(sftp: any, absPath: string): Promise<null | { kind: "file" | "dir" }> {
  return await new Promise((resolve) => {
    sftp.stat(absPath, (err: unknown, stats: any) => {
      if (err || !stats) {
        resolve(null);
        return;
      }
      try {
        if (typeof stats.isDirectory === "function" && stats.isDirectory()) {
          resolve({ kind: "dir" });
          return;
        }
      } catch {
        // fallthrough
      }
      resolve({ kind: "file" });
    });
  });
}

export async function scanRemoteWorkspaces(args: SshProbeArgs): Promise<RemoteWorkspaceScanResult> {
  const host = args.host.trim();
  const port = Number.isFinite(args.port) && args.port > 0 ? Math.floor(args.port) : 22;
  const username = args.username.trim();
  const password = args.password;

  if (!host || !username) {
    return { ok: false, home: "", candidates: [], error: "host/username 不能为空" };
  }
  if (!password) {
    return { ok: false, home: "", candidates: [], error: "请输入密码" };
  }

  const client = new Client();
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) {
          return;
        }
        done = true;
        reject(new Error("连接超时"));
      }, 10_000);

      client.on("ready", () => {
        clearTimeout(timer);
        if (done) {
          return;
        }
        done = true;
        resolve();
      });
      client.on("error", (err) => {
        clearTimeout(timer);
        if (done) {
          return;
        }
        done = true;
        reject(err);
      });

      client.connect({
        host,
        port,
        username,
        password,
        readyTimeout: 10_000
      });
    });

    const homeOut = await execSsh(client, "sh -c 'printf %s \"${HOME:-}\"'", 4000).catch(() => null);
    const home = (homeOut ? firstLine(`${homeOut.stdout}\n${homeOut.stderr}`) : "").trim() || `/home/${username}`;

    const sftp = await new Promise<any>((resolve, reject) => {
      client.sftp((err, handle) => {
        if (err || !handle) {
          reject(err ?? new Error("failed to open sftp"));
          return;
        }
        resolve(handle);
      });
    });

    const list = await new Promise<any[]>((resolve, reject) => {
      sftp.readdir(home, (err: unknown, items: any[]) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(Array.isArray(items) ? items : []);
      });
    });

    const dirs = list
      .map((it) => String(it?.filename ?? ""))
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && !name.startsWith("."))
      .slice(0, 200);

    const candidates: RemoteWorkspaceCandidate[] = [];
    for (const name of dirs) {
      const absPath = path.posix.join(home, name);
      const st = await sftpStatSafe(sftp, absPath);
      if (!st || st.kind !== "dir") {
        continue;
      }

      const git = await sftpStatSafe(sftp, path.posix.join(absPath, ".git"));
      const pkg = await sftpStatSafe(sftp, path.posix.join(absPath, "package.json"));
      const hasGit = Boolean(git && git.kind === "dir");
      const hasPackageJson = Boolean(pkg && pkg.kind === "file");

      candidates.push({
        path: absPath,
        label: name,
        hasGit,
        hasPackageJson
      });
    }

    candidates.sort((a, b) => {
      if (a.hasGit !== b.hasGit) {
        return a.hasGit ? -1 : 1;
      }
      if (a.hasPackageJson !== b.hasPackageJson) {
        return a.hasPackageJson ? -1 : 1;
      }
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });

    return { ok: true, home, candidates, error: null };
  } catch (err) {
    return { ok: false, home: "", candidates: [], error: String(err) };
  } finally {
    try {
      client.end();
    } catch {
      // Best-effort.
    }
  }
}

export async function mkdirRemoteAbs(args: RemoteWorkspaceMkdirAbsArgs): Promise<RemoteWorkspaceMkdirAbsResult> {
  const host = args.host.trim();
  const port = Number.isFinite(args.port) && args.port > 0 ? Math.floor(args.port) : 22;
  const username = args.username.trim();
  const password = args.password;
  const rawPath = String(args.absPath ?? "").trim();

  if (!host || !username) {
    return { ok: false, absPath: null, error: "host/username 不能为空" };
  }
  if (!password) {
    return { ok: false, absPath: null, error: "请输入密码" };
  }
  if (!rawPath) {
    return { ok: false, absPath: null, error: "absPath 不能为空" };
  }
  if (!rawPath.startsWith("/")) {
    return { ok: false, absPath: null, error: "absPath 必须是绝对路径" };
  }

  const absPath = path.posix.resolve("/", rawPath);

  const client = new Client();
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) {
          return;
        }
        done = true;
        reject(new Error("连接超时"));
      }, 10_000);

      client.on("ready", () => {
        clearTimeout(timer);
        if (done) {
          return;
        }
        done = true;
        resolve();
      });
      client.on("error", (err) => {
        clearTimeout(timer);
        if (done) {
          return;
        }
        done = true;
        reject(err);
      });

      client.connect({
        host,
        port,
        username,
        password,
        readyTimeout: 10_000
      });
    });

    // Use "$1" to avoid shell injection issues.
    const mkdirOut = await execSsh(client, `sh -c 'mkdir -p -- "$1"' _ ${shQuotePosix(absPath)}`, 8_000);
    if (mkdirOut.code !== 0) {
      const hint = firstLine(`${mkdirOut.stderr}\n${mkdirOut.stdout}`.trim());
      return { ok: false, absPath: null, error: hint ? `mkdir failed: ${hint}` : "mkdir failed" };
    }

    const sftp = await new Promise<any>((resolve, reject) => {
      client.sftp((err, handle) => {
        if (err || !handle) {
          reject(err ?? new Error("failed to open sftp"));
          return;
        }
        resolve(handle);
      });
    });

    const st = await sftpStatSafe(sftp, absPath);
    if (!st || st.kind !== "dir") {
      return { ok: false, absPath: null, error: "创建失败或目标不是目录" };
    }

    return { ok: true, absPath, error: null };
  } catch (err) {
    return { ok: false, absPath: null, error: String(err) };
  } finally {
    try {
      client.end();
    } catch {
      // Best-effort.
    }
  }
}
