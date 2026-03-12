# 远端工作区（下一步实现前的补充问题）

基于 `remote-workspace-report.md`，目前我们已经确认：

- OS：Ubuntu 24.04 LTS
- SSH：`PasswordAuthentication yes`，已配置 SFTP Subsystem
- Node/npm：nvm + Node v22.x + npm 10.x
- Codex：已安装（`codex-cli 0.98.0`），且 `command -v codex` 有路径

为了把「远端目录作为工作区 / SFTP 文件浏览 / 远端跑 codex app-server 并接入会话」做完整，还需要你确认下面这些点（越少越好，按优先级排列）。

---

## A. 目标工作区与会话策略（必填）

1) 你最终要把哪个目录作为“远端工作区 root”？
   - 候选：`/home/ubuntu/TAZHAN_WEB` / `/home/ubuntu/tazhan-vs` / 其他：________
2) 远端工作区是否允许我们创建 `.codex`/`.tazhan` 之类的辅助目录（用于缓存/临时文件）？
3) 同一台服务器是否会同时开多个项目/多个工作区？（影响 sidebar 展示与连接复用）

---

## B. SSH 登录方式与安全（必填）

1) 你希望最终使用哪种登录方式？
   - SSH Key（推荐）
   - 密码（不推荐，但可用；我们不会保存密码到 settings）
2) 是否需要跳板机 / 端口转发 / 2FA？
3) 服务器安全策略是否允许：
   - 长连接（我们会保持一个 SSH session 持续跑 app-server）
   - 多通道（同一连接开：一个跑 codex app-server + 一个做 SFTP）

---

## C. 远端启动 codex app-server 的“可靠方式”（非常关键）

目标：我们要在 SSH 里启动 `codex app-server`，并把它的 stdout/stderr 当作 JSON-RPC 数据流使用。
这要求：启动时不能往 stdout 打印任何 banner/MOTD/echo，否则会污染 JSON。

请你在服务器上验证并贴回输出（可打码 host/用户名）：

1) 非交互执行是否会输出额外内容？
   - `ssh <server> 'echo OK'` 输出是否只有 `OK`？
2) 是否存在 `.bashrc/.profile` 自动打印内容？
   - `ssh <server> 'bash -lc \"echo OK\"'` 输出是否只有 `OK`？
3) 能否稳定启动 app-server（不要 Ctrl+C，让它跑 5~10 秒）：
   - `ssh <server> 'codex app-server'`
   - 如果 `codex` 依赖 nvm PATH，改用：`ssh <server> 'bash -lc \"codex app-server\"'`
4) 如果上面会输出杂音，我们会改用“绝对路径 + node 绝对路径”启动：
   - `readlink -f $(command -v codex)` 的输出
   - `ls -la $(dirname $(command -v codex))/node` 是否存在

---

## D. 远端 Codex 的账号/Provider 配置（必填）

因为你希望“用云端原生 codex”，所以最终调用会在远端发生，远端必须能正常鉴权与访问模型提供商。

请确认：

1) 远端是否已完成登录/配置？
   - `~/.codex/config.toml` 是否存在
   - `~/.codex/auth.json` 是否存在
2) 远端是否需要代理才能访问模型提供商？（HTTP_PROXY/HTTPS_PROXY）

---

## E. SFTP 文件浏览范围（推荐确认）

1) 侧边栏 Explorer 是否只展示工作区 root 下的文件？（推荐是）
2) 是否允许访问工作区外路径？（推荐否，避免误删）
3) 是否需要实时更新（watch）：
   - 只做手动刷新/低频轮询（简单、稳）
   - 做 SFTP + 轮询 + 增量刷新（更像 VS Code）

