import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "..");

function withShellOnWindows() {
  return process.platform === "win32";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath, timeoutMs) {
  const start = Date.now();
  while (true) {
    if (await fileExists(filePath)) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }
    await sleep(50);
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        server.close(() => resolve(true));
      });
    server.listen(port, "localhost");
  });
}

async function findFreePort(startPort, maxAttempts) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const free = await isPortFree(port);
    if (free) {
      return port;
    }
  }
  throw new Error(`No free port found starting at ${startPort} (attempts=${maxAttempts})`);
}

function spawnLogged(command, args, extra) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: withShellOnWindows(),
    ...extra
  });
  child.on("error", (err) => {
    console.error(`[dev] failed to spawn ${command}:`, err);
  });
  return child;
}

let shuttingDown = false;
async function main() {
  const preferredPort = Number.parseInt(process.env.TAZHAN_DEV_PORT ?? "5173", 10);
  const port = await findFreePort(preferredPort, 50);

  console.log(`[dev] renderer port: ${port}`);

  const distMain = path.join(projectRoot, "dist", "main", "index.js");
  const distPreload = path.join(projectRoot, "dist", "preload", "index.js");

  const tsupProc = spawnLogged("pnpm", ["dev:main"]);

  const server = await createServer({
    configFile: path.join(projectRoot, "vite.renderer.config.ts"),
    server: { port, strictPort: true },
    clearScreen: false
  });

  await server.listen();
  server.printUrls();

  await waitForFile(distMain, 30_000);
  await waitForFile(distPreload, 30_000);

  const devUrl = server.resolvedUrls?.local[0] ?? `http://localhost:${port}`;

  const electronEnv = { ...process.env, VITE_DEV_SERVER_URL: devUrl };
  const electronProc = spawnLogged("pnpm", ["exec", "electron", "."], { env: electronEnv });

  async function shutdown(code) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      electronProc.kill();
    } catch {
    }
    try {
      tsupProc.kill();
    } catch {
    }
    try {
      await server.close();
    } catch {
    }
    process.exit(code ?? 0);
  }

  electronProc.on("exit", (code) => {
    void shutdown(code ?? 0);
  });

  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));
}

main().catch((err) => {
  console.error("[dev] fatal error:", err);
  process.exit(1);
});
