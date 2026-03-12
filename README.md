# TAZHAN Desktop (Electron)

## 中文

这是一个 codex 可视化窗口，做了很多我平时需要的功能，也可以同时连接云端会话并发进行。

“塔栈”是我想的一个名字，觉得还挺好听的。

目前这个桌面端依然是半成品，但我现在没有太多精力继续完善了。如果你也想加入开发，欢迎留言，或者加入 QQ 群 `1042659807`。

## English

This is a visual desktop client for Codex with many features I use in daily workflows. It can also connect to cloud sessions and run them in parallel.

"TAZHAN" is a name I came up with and liked.

This desktop app is still a work in progress, and I do not have enough time to keep polishing it for now. If you want to join the development effort, feel free to leave a message or join the QQ group `1042659807`.

## Project

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

## Build

```bash
pnpm build
```

## Release

```bash
git tag v0.1.0
git push origin v0.1.0
```

Pushing a `v*` tag triggers GitHub Actions to build the Windows installer and upload it to GitHub Releases automatically.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=aojianhua/TAZHAN_CODEX_Desktop_Win&type=Date)](https://www.star-history.com/#aojianhua/TAZHAN_CODEX_Desktop_Win&Date)
