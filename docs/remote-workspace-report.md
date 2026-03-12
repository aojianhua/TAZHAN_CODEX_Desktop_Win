# 远端工作区调查报告（基于 `remote-workspace-questionnaire.md`）

生成日期：2026-02-09  
采集方式：在该服务器上执行命令自动采集 + 少量人工待确认项

---

## 1) 基本信息

- 云厂商/系统：
  - 云厂商（DMI）：Tencent Cloud（CVM）
  - OS：Ubuntu 24.04 LTS（Noble Numbat）
  - Kernel：Linux 6.8.0-71-generic（x86_64，KVM）
- CPU/内存：
  - CPU：2 vCPU（Intel(R) Xeon(R) Platinum 8255C @ 2.50GHz）
  - 内存：约 1.9 GiB
  - Swap：约 1.9 GiB
- 服务器用途：待确认（开发机 / 生产机 / 跳板机）
- 工作区目录（候选）：
  - `/home/ubuntu/TAZHAN_WEB`（检测到 `.git`）
  - `/home/ubuntu/tazhan-vs`（检测到 `.git`）
  - 其他：待确认（你希望把哪个目录作为工作区？）

---

## 2) SSH 登录与权限

- SSH 端口：22（本机监听 `*:22`）
- SSHD 配置（best effort，从 `/etc/ssh/sshd_config` 抽取关键项）：
  - `PasswordAuthentication yes`（允许密码登录）
  - `PermitRootLogin yes`（允许 root 登录）
  - `Subsystem sftp /usr/lib/openssh/sftp-server`（配置了 SFTP 子系统）
- 登录方式（需要你确认）：
  - 密码 / SSH Key（私钥）+ passphrase（有/无）
  - 是否需要 2FA/OTP（有/无）
  - 是否需要跳板机（有/无，跳板机地址/方式）
  - 是否允许 SFTP：大概率允许（已配置 Subsystem），但是否有额外限制需你确认
- 目标用户权限（以当前用户 `ubuntu` 为准）：
  - `sudo`：可用（NOPASSWD）
  - 写入权限：`ubuntu` 可写 `/home/ubuntu`（工作区若换到别的目录需再确认）

---

## 3) Shell 与 PATH（非常关键）

- 默认 shell：`/bin/bash`
- PATH（当前会话）：
  - `/home/ubuntu/.local/bin:/home/ubuntu/.codex/tmp/...:/home/ubuntu/.nvm/versions/node/v22.20.0/bin:...:/snap/bin`
- codex 是否能直接运行：能
  - `codex --version`：`codex-cli 0.98.0`
  - `command -v codex`：`/home/ubuntu/.nvm/versions/node/v22.20.0/bin/codex`
- 登录 shell（`bash -lc`）下 codex 可用：是（同上路径与版本）

---

## 4) Node / npm / pnpm（如果通过 npm -g 安装 codex）

- `node -v`：`v22.20.0`
- `npm -v`：`10.9.3`
- 是否用 nvm/volta/asdf：nvm（路径与目录特征显示使用了 `~/.nvm`）
- `npm prefix -g`：`/home/ubuntu/.nvm/versions/node/v22.20.0`
- 全局 codex 入口：
  - `/home/ubuntu/.nvm/versions/node/v22.20.0/bin/codex`（指向 `@openai/codex/bin/codex.js` 的 symlink）

---

## 5) Codex 安装与可用性

- 安装方式：`npm i -g @openai/codex`（通过 `npm ls -g` 结果推断）
- 包版本：`@openai/codex@0.98.0`
- `codex app-server`：
  - `codex app-server --help`：可用（命令存在）
  - “是否会持续运行 / 启动是否报错”：待进一步按你的目标运行方式确认（例如以 SSH exec 方式启动并保持会话）
- 远端网络访问模型提供商（OpenAI）：
  - 服务器可访问 `https://api.openai.com/v1/models`（未带鉴权返回 HTTP 401，符合“可达但未授权”的预期）
  - 是否需要代理：待确认

---

## 6) 期望的产品形态（待你选择）

- A. 远端跑 Codex app-server（推荐）：待确认是否采用
- B. 本地跑 Codex app-server + 远端代理：待确认是否采用

---

## 7) 附录：一键采集脚本输出（已执行，摘录）

- `uname -a`：Linux VM-8-11-ubuntu 6.8.0-71-generic x86_64 GNU/Linux
- `shell=/bin/bash`，`pwd=/home/ubuntu`
- `node v22.20.0`，`npm 10.9.3`
- `codex --version`：codex-cli 0.98.0
- `command -v codex`：/home/ubuntu/.nvm/versions/node/v22.20.0/bin/codex

---

## 待你补充的最小信息（把答案直接回在聊天里即可）

1) 服务器用途：开发机 / 生产机 / 跳板机？
2) 你希望的工作区目录：`/home/ubuntu/TAZHAN_WEB`、`/home/ubuntu/tazhan-vs`，还是别的？
3) SSH 登录方式：密码 / key（私钥是否有 passphrase）/ 是否需要 2FA / 是否需要跳板机？
4) 你更想要的实现方式：A（远端 app-server）还是 B（本地 app-server + 远端代理）？

---

## 8) 下一步实现前的补充问题（已确认/待确认）

### A. 目标工作区与会话策略

- 远端工作区 root：待你指定（候选目录均可写且为 Git 仓库）
  - `/home/ubuntu/TAZHAN_WEB`：可写；`.git` 存在
  - `/home/ubuntu/tazhan-vs`：可写；`.git` 存在
- 是否允许创建辅助目录：可（当前用户 `ubuntu` 对上述候选目录均有写权限）
- 是否会同时开多个项目/工作区：待你确认（从目录上看至少存在两个项目仓库）

### B. SSH 登录方式与安全

- 登录方式：待你选择（服务端同时支持密码与 key）
  - `PasswordAuthentication yes`
  - `PubkeyAuthentication yes`，但 `/home/ubuntu/.ssh/authorized_keys` 目前为空（如要用 key 需添加）
- 是否需要跳板机/2FA：待你确认
- 长连接/多通道：
  - 服务端允许维持长连接（`ClientAliveInterval 30`，`ClientAliveCountMax 3`，`TCPKeepAlive yes`）
  - 支持同一连接多通道（一个跑 `codex app-server` + 一个 SFTP）属于 OpenSSH 标准能力；是否有额外安全策略限制需你确认

### C. 远端启动 codex app-server 的“可靠方式”

- `codex app-server` 可稳定运行（在保持 stdin 打开的情况下可持续运行；5s 观察无 stdout/stderr 输出）
- 为避免 PATH 问题，推荐启动命令优先用 `bash -lc`，若仍有杂音再切绝对路径：
  - `readlink -f $(command -v codex)`：`/home/ubuntu/.nvm/versions/node/v22.20.0/lib/node_modules/@openai/codex/bin/codex.js`
  - `node`（同目录 sibling）存在：`/home/ubuntu/.nvm/versions/node/v22.20.0/bin/node`
- **潜在“stdout 杂音”风险点（需你从本机 `ssh ...` 实测确认）：**
  - `usepam yes` 且 PAM 启用了 `pam_motd`（`/run/motd.dynamic` 当前内容非空）
  - `printlastlog yes`（可能打印 Last login）
  - 建议用不分配 TTY 的方式启动（如 `ssh -T ...`），并按补充问题里的 `echo OK` 测试确认输出是否干净

### D. 远端 Codex 的账号/Provider 配置

- 远端已存在配置与鉴权文件：
  - `~/.codex/config.toml`：存在
  - `~/.codex/auth.json`：存在
- 代理：
  - 当前环境未检测到 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`
  - OpenAI API 可达（未鉴权访问 models 返回 401，符合预期）

### E. SFTP 文件浏览范围

- 推荐基线（待你确认是否接受）：Explorer 仅展示工作区 root；默认不允许访问 root 外路径
- 实时更新策略：你已选择“做 SFTP + 轮询 + 增量刷新”
