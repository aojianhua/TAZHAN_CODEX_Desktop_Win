# TAZHAN Desktop (Electron)

Minimal desktop app that hosts `codex app-server` (stdio) and provides a simple UI to start a thread/turn, stream events, and handle approvals.

## Prerequisites

- Node.js 22+
- pnpm 10+
- `codex` installed and available on PATH (or configure an absolute path in the UI)

## Development

```bash
pnpm install
pnpm dev
```

Notes:

- `pnpm dev` picks an available renderer port automatically (starting from 5173) to avoid conflicts with other Vite dev servers.
- If you want to force a specific port, set `TAZHAN_DEV_PORT` (e.g. `TAZHAN_DEV_PORT=5175 pnpm dev`).

## Tests

```bash
pnpm test
```

## Build

```bash
pnpm build
```
