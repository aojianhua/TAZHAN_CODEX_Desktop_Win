import { Client } from "ssh2";

import type { SshProbeArgs, SshProbeResult } from "../shared/types";

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

function firstLine(text: string): string {
  return text
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? "";
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

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
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
    });
  });
}

function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

async function detectCodexPath(client: Client): Promise<string | null> {
  // NOTE: ssh2 exec runs non-interactive shells by default, so user profile PATH may not be loaded.
  // We try several strategies to find the codex binary.
  const direct = firstLine(
    (await execSsh(client, "sh -c \"command -v codex 2>/dev/null || true\"", 4000)).stdout
  );
  if (direct) {
    return direct;
  }

  const viaBash = firstLine(
    (
      await execSsh(
        client,
        "sh -c \"command -v bash >/dev/null 2>&1 && bash -lc 'command -v codex 2>/dev/null || true' || true\"",
        5000
      )
    ).stdout
  );
  if (viaBash) {
    return viaBash;
  }

  const viaNvm = firstLine(
    (
      await execSsh(
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
      await execSsh(
        client,
        "sh -c \"P=$(npm prefix -g 2>/dev/null || true); if [ -n \\\"$P\\\" ] && [ -x \\\"$P/bin/codex\\\" ]; then echo \\\"$P/bin/codex\\\"; fi\"",
        5000
      )
    ).stdout
  );
  if (viaNpmPrefix) {
    return viaNpmPrefix;
  }

  const viaPnpm = firstLine(
    (
      await execSsh(
        client,
        "sh -c \"if command -v pnpm >/dev/null 2>&1; then B=$(pnpm -g bin 2>/dev/null || true); if [ -n \\\"$B\\\" ] && [ -x \\\"$B/codex\\\" ]; then echo \\\"$B/codex\\\"; fi; fi\"",
        5000
      )
    ).stdout
  );
  if (viaPnpm) {
    return viaPnpm;
  }

  return null;
}

export async function sshProbe(args: SshProbeArgs): Promise<SshProbeResult> {
  const host = args.host.trim();
  const port = Number.isFinite(args.port) && args.port > 0 ? Math.floor(args.port) : 22;
  const username = args.username.trim();
  const password = args.password;

  if (!host || !username) {
    return {
      ok: false,
      latencyMs: null,
      host,
      port,
      username,
      uname: null,
      codexPath: null,
      codexVersion: null,
      nodeVersion: null,
      npmVersion: null,
      error: "host/username 不能为空"
    };
  }

  const startedAtMs = Date.now();
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
      }, 8000);

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
        readyTimeout: 8000
      });
    });

    const uname = (await execSsh(client, "uname -a", 4000).catch(() => null))?.stdout.trim() || null;

    const codexPath = await detectCodexPath(client);

    const codexVersionOut = codexPath
      ? await execSsh(client, `sh -c "\"${codexPath.replaceAll("\"", "\\\"")}\" --version 2>/dev/null || true"`, 5000).catch(
          () => null
        )
      : null;
    const codexVersion = codexVersionOut ? parseVersion(`${codexVersionOut.stdout}\n${codexVersionOut.stderr}`) : null;

    const nodeVersionRaw = (await execSsh(client, "sh -c \"node -v 2>/dev/null || true\"", 4000).catch(() => null))?.stdout.trim() || "";
    const nodeVersion = nodeVersionRaw.length > 0 ? nodeVersionRaw.split("\n")[0]?.trim() || null : null;

    const npmVersionRaw = (await execSsh(client, "sh -c \"npm -v 2>/dev/null || true\"", 4000).catch(() => null))?.stdout.trim() || "";
    const npmVersion = npmVersionRaw.length > 0 ? npmVersionRaw.split("\n")[0]?.trim() || null : null;

    const latencyMs = Math.max(0, Date.now() - startedAtMs);
    return {
      ok: true,
      latencyMs,
      host,
      port,
      username,
      uname,
      codexPath,
      codexVersion,
      nodeVersion,
      npmVersion,
      error: null
    };
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - startedAtMs);
    return {
      ok: false,
      latencyMs,
      host,
      port,
      username,
      uname: null,
      codexPath: null,
      codexVersion: null,
      nodeVersion: null,
      npmVersion: null,
      error: String(err)
    };
  } finally {
    try {
      client.end();
    } catch {
      // Best-effort.
    }
  }
}
