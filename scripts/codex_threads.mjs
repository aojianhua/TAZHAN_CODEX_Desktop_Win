import { spawn } from "node:child_process";
import readline from "node:readline";

function parseArgs(argv) {
  const args = { limit: 20, cwd: "", method: "thread/list", sources: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit" && i + 1 < argv.length) {
      args.limit = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (a === "--cwd" && i + 1 < argv.length) {
      args.cwd = argv[++i];
      continue;
    }
    if (a === "--method" && i + 1 < argv.length) {
      args.method = argv[++i];
      continue;
    }
    if (a === "--sources" && i + 1 < argv.length) {
      args.sources = argv[++i];
      continue;
    }
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    args.limit = 20;
  }
  return args;
}

function rpcClient(proc) {
  let nextId = 1;
  const pending = new Map();

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = String(line).trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg && (typeof msg.id === "number" || typeof msg.id === "string") && !msg.method) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(String(msg.error.message ?? "RPC error"));
        err.rpc = msg.error;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
  });

  function send(obj) {
    proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  async function call(method, params) {
    const id = nextId++;
    send(params === undefined ? { id, method } : { id, method, params });
    return await new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  function notify(method, params) {
    send(params === undefined ? { method } : { method, params });
  }

  return { call, notify };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const codexCmd = process.env.CODEX_CMD?.trim() ? process.env.CODEX_CMD.trim() : "codex";
  const proc = spawn(codexCmd, ["app-server"], { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });

  const rpc = rpcClient(proc);
  await rpc.call("initialize", {
    clientInfo: { name: "tazhan-desktop", version: "dev", title: "tazhan-desktop" },
    capabilities: { experimentalApi: false }
  });
  rpc.notify("initialized", {});

  const resp = await rpc.call(args.method, {
    cursor: null,
    limit: args.limit,
    sortKey: "updated_at",
    ...(args.sources.trim()
      ? { sourceKinds: args.sources.split(",").map((s) => s.trim()).filter(Boolean) }
      : {}),
    archived: false
  });

  const data = Array.isArray(resp?.data) ? resp.data : [];
  const normalizedCwd = args.cwd.trim().toLowerCase();
  const filtered = normalizedCwd
    ? data.filter((t) => String(t?.cwd ?? "").trim().toLowerCase() === normalizedCwd)
    : data;

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ count: filtered.length, nextCursor: resp?.nextCursor ?? null, data: filtered }, null, 2));

  proc.kill();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[codex_threads] error:", err?.message ?? String(err));
  process.exit(1);
});
