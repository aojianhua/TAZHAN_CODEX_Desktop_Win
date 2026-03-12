# 远端工作区（SSH/SFTP + 远端 Codex）信息收集

目的：为了把「远端目录作为工作区 / SFTP 文件浏览 / 在远端跑 codex app-server 并接入会话」做得稳定，需要先确认云端环境与限制。

你可以把本文件填写后发回给我；或者把「一键采集脚本」的输出贴回来（注意脱敏）。

---

## 1) 基本信息

- 云厂商/系统：例如 Ubuntu 22.04 / Debian 12 / CentOS / Alpine / 其他
- CPU/内存：例如 2C4G
- 服务器用途：开发机 / 生产机 / 跳板机
- 你希望把哪个目录作为工作区：例如 `/home/ubuntu/project`
- 这个目录是否存在 Git 仓库：是/否

---

## 2) SSH 登录与权限

- 登录方式：
  - 密码
  - SSH Key（私钥）+ passphrase（有/无）
  - 需要 2FA/OTP（有/无）
  - 需要跳板机（有/无，跳板机地址/方式）
- 是否允许 SFTP：是/否/不确定
- 目标用户权限：
  - 是否可以 `sudo`：是/否
  - 是否能写工作区目录：是/否
- SSH 端口：默认 22 / 自定义

---

## 3) Shell 与 PATH（非常关键）

> 说明：通过程序发起的 SSH `exec` 通常是「非交互、非登录 shell」，很多机器的 `PATH` 需要 `bash -lc` 才会加载，所以会出现“明明装了 codex，但检测不到”的情况。

- 默认 shell：`echo $SHELL` 的结果
- `PATH`：`echo $PATH` 的结果
- codex 是否能直接运行：`codex --version`（能/不能）
- `command -v codex` 的输出（如果为空也请写）

---

## 4) Node / npm / pnpm（如果通过 npm -g 安装 codex）

- `node -v` 输出：
- `npm -v` 输出：
- 是否用 nvm/volta/asdf：是/否（哪个）
- `npm prefix -g` 输出：
- `ls -la $(npm prefix -g)/bin | rg codex`（没有 rg 用 grep）

---

## 5) Codex 安装与可用性

- 安装方式：
  - `npm i -g @openai/codex`
  - `pnpm add -g @openai/codex`
  - 其他（请写）
- `codex --version` 输出：
- `codex app-server` 能否启动：
  - 能（是否会持续运行）
  - 不能（报错全文）
- 远端网络是否能访问模型提供商（OpenAI/自建网关）：能/不能/需要代理

---

## 6) 你希望的产品形态（选项）

请勾选你更想要的实现方式（两种都可以做，但路径不同）：

1) A. 远端跑 Codex app-server（推荐）
   - 客户端通过 SSH 直接 `exec codex app-server`，把 JSON-RPC 走 SSH 通道
   - 优点：不需要开端口；工具/文件操作都发生在远端；最接近“远端工作区”
   - 需要：远端能跑 `codex app-server`，且执行权限/网络 OK

2) B. 本地跑 Codex app-server + 远端只做文件/命令代理
   - 优点：codex 安装/账号都在本地；远端只当作一个“文件服务器/执行器”
   - 缺点：需要我们自己做一套远端工具代理协议；工作量更大

---

## 7) 一键采集脚本（在服务器运行）

把下面整段复制到服务器终端执行，然后把输出贴回来（注意脱敏：IP/用户名/路径如需可打码，但 PATH/npm prefix/codex 路径最好保留）。

```sh
set -e
echo "== basic =="
uname -a || true
echo "shell=$SHELL"
echo "pwd=$(pwd)"
echo

echo "== env =="
echo "PATH=$PATH"
echo

echo "== node/npm =="
node -v 2>/dev/null || echo "node: (missing)"
npm -v 2>/dev/null || echo "npm: (missing)"
echo

echo "== codex path =="
command -v codex 2>/dev/null || echo "codex: (not in PATH)"
echo

echo "== codex version =="
codex --version 2>/dev/null || echo "codex --version failed"
echo

echo "== npm prefix -g =="
npm prefix -g 2>/dev/null || echo "npm prefix -g failed"
echo

echo "== list global bin (best effort) =="
P="$(npm prefix -g 2>/dev/null || true)"
if [ -n "$P" ]; then
  ls -la "$P/bin" 2>/dev/null | grep -i codex || true
fi
echo

echo "== try login shell (bash -lc) =="
if command -v bash >/dev/null 2>&1; then
  bash -lc 'command -v codex || true'
  bash -lc 'codex --version || true'
else
  echo "bash: (missing)"
fi
```

