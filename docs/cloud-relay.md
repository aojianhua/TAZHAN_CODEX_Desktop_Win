# Cloud Relay (Desktop Agent) - Developer Notes

This document describes how `tazhan-desktop` connects to the Cloud Relay as a **device**.

## Enable

The desktop app will auto-start the relay connection on startup when either:

- `settings.relay.enabled = true`, or
- `TAZHAN_RELAY_ENABLED=1`, or
- `TAZHAN_RELAY_BASE_URL` is set (non-empty)

### UI (pairing)

In the desktop app, you can generate a pairing code + QR payload for the mobile app:

- Sidebar footer: click the `Connect phone` (phone icon) button next to the running task count.
- The desktop will best-effort enable Cloud Relay (default base URL: `https://tazhan.top`) and refresh a pairing code via `POST /v1/devices/{deviceId}/pairing-codes`.
- The QR payload is `tazhan://pair?code=...&secret=...` (the `secret` enables scan-only first-time pairing; the mobile app can receive and persist a `userToken` without manual JWT entry).
- Scan the QR code on the mobile app Pair screen, or copy/paste the pairing code.

### Environment variables

- `TAZHAN_RELAY_BASE_URL`: e.g. `https://tazhan.top`
- `TAZHAN_RELAY_ENABLED`: set to `1` to force-enable

## What the desktop does (v1)

- Registers a device (if missing auth) via `POST /v1/devices`
  - When `settings.relay.e2ee.enabled=true`, the desktop includes `e2ee.deviceKeyId` + `e2ee.deviceEd25519Pub` (and `required` when supported) so apps can verify the device identity for E2EE.
- Persists `deviceId` + `deviceToken` into `settings.relay.auth`
- Can regenerate a pairing code via `POST /v1/devices/{deviceId}/pairing-codes` (device token)
- Connects `wss://.../ws/device` and performs `hello` handshake
- Forwards Codex app-server notifications/requests to the relay as `type:"rpc"` envelopes
- Accepts incoming `type:"rpc"` messages and forwards them into the local `codex app-server`
- Implements additional desktop capability RPCs under `tazhan/*` (filesystem + terminal) and emits `tazhan/*/event` notifications

## Security notes

- Transport security is expected to be `https/wss` (TLS). The desktop blocks non-local `http/ws` by default.
  - Dev override: set `TAZHAN_RELAY_ALLOW_INSECURE=1`.
- The desktop supports an **optional E2EE layer** (see `settings.relay.e2ee`) to protect against a compromised relay.
  - When enabled, App<->Device messages are wrapped as `e2ee/*` payloads inside the relay `rpc` field (opaque to the relay).
  - When `required=true`, the desktop refuses to execute plaintext remote commands.

## E2EE settings (v1)

The device will generate a persistent Ed25519 signing key on first enable and store it under `settings.relay.e2ee.*`.

Minimal example (pseudo):

```json
{
  "relay": {
    "e2ee": {
      "enabled": true,
      "required": true,
      "allowTofu": false,
      "trustedPeers": [
        {
          "keyId": "k_xxx",
          "label": "my-phone",
          "ed25519PublicKey": "base64(spki-der)",
          "addedAt": 1739155200
        }
      ]
    }
  }
}
```

## Remote execution allowlist

Remote requests that explicitly set `params.cwd` are validated against `settings.relay.allowedRoots`.

- If `allowedRoots` is empty and `settings.defaultCwd` is set, the app will set `allowedRoots=[defaultCwd]` as a minimal safe default.
- If `allowedRoots` is empty and a remote request tries to set `cwd`, the request is rejected (fail closed).

## Exposed RPC methods (over relay)

Notes:

- The `tazhan/*` capability methods are implemented as **JSON-RPC requests** (they must include an `id`).
  - In v1 the desktop intentionally ignores `tazhan/*` JSON-RPC notifications for forward compatibility.
- Paths are treated as absolute on the desktop, and are validated against `settings.relay.allowedRoots`.

Filesystem:

- `tazhan/workspace/listRoots`
- `tazhan/workspace/listDir`
- `tazhan/workspace/readFile`
- `tazhan/workspace/writeFile`
- `tazhan/workspace/mkdir`
- `tazhan/workspace/createFile`
- `tazhan/workspace/rename`
- `tazhan/workspace/delete`
- `tazhan/workspace/watchSet`
- `tazhan/workspace/event` (notification)

### Filesystem payloads

`tazhan/workspace/listRoots`

Params:
```json
{}
```

Result:
```json
{ "ok": true, "roots": [{ "path": "C:\\\\repo", "label": "repo" }], "error": null }
```

`tazhan/workspace/listDir`

Params:
```json
{ "root": "C:\\\\repo", "dir": "C:\\\\repo\\\\src" }
```

Result:
```json
{
  "ok": true,
  "entries": [{ "name": "main.ts", "path": "C:\\\\repo\\\\src\\\\main.ts", "kind": "file" }],
  "error": null
}
```

`tazhan/workspace/readFile`

Params:
```json
{ "root": "C:\\\\repo", "path": "C:\\\\repo\\\\README.md" }
```

Result:
```json
{ "ok": true, "content": "...", "truncated": false, "error": null }
```

`tazhan/workspace/writeFile`

Params:
```json
{ "root": "C:\\\\repo", "path": "C:\\\\repo\\\\README.md", "content": "..." }
```

Result:
```json
{ "ok": true, "error": null }
```

`tazhan/workspace/mkdir` / `tazhan/workspace/createFile`

Params:
```json
{ "root": "C:\\\\repo", "parentDir": "C:\\\\repo\\\\src", "name": "new-dir" }
```

Result:
```json
{ "ok": true, "path": "C:\\\\repo\\\\src\\\\new-dir", "error": null }
```

`tazhan/workspace/rename`

Params:
```json
{ "root": "C:\\\\repo", "path": "C:\\\\repo\\\\src\\\\old.ts", "newName": "new.ts" }
```

Result:
```json
{ "ok": true, "path": "C:\\\\repo\\\\src\\\\new.ts", "error": null }
```

`tazhan/workspace/delete`

Params:
```json
{ "root": "C:\\\\repo", "path": "C:\\\\repo\\\\src\\\\tmp" }
```

Result:
```json
{ "ok": true, "error": null }
```

`tazhan/workspace/watchSet`

Params:
```json
{ "root": "C:\\\\repo", "dirs": ["C:\\\\repo\\\\src"] }
```

Result:
```json
{ "ok": true, "error": null }
```

Notification: `tazhan/workspace/event`

Params:
```json
{ "root": "C:\\\\repo", "dir": "C:\\\\repo\\\\src", "atMs": 1739155412000 }
```

Terminal:

- `tazhan/terminal/create`
- `tazhan/terminal/write`
- `tazhan/terminal/resize`
- `tazhan/terminal/dispose`
- `tazhan/terminal/run`
- `tazhan/terminal/event` (notification)

### Terminal payloads

`tazhan/terminal/create`

Params:
```json
{ "cwd": "C:\\\\repo", "cols": 80, "rows": 24 }
```

Result:
```json
{ "ok": true, "terminalId": "term_...", "error": null }
```

`tazhan/terminal/write`

Params:
```json
{ "terminalId": "term_...", "data": "ls -la\\n" }
```

Result:
```json
{ "ok": true, "error": null }
```

`tazhan/terminal/resize`

Params:
```json
{ "terminalId": "term_...", "cols": 120, "rows": 32 }
```

Result:
```json
{ "ok": true, "error": null }
```

`tazhan/terminal/dispose`

Params:
```json
{ "terminalId": "term_..." }
```

Result:
```json
{ "ok": true, "error": null }
```

`tazhan/terminal/run`

Params:
```json
{ "cwd": "C:\\\\repo", "command": "pnpm -v", "timeoutMs": 60000 }
```

Result:
```json
{ "ok": true, "stdout": "...", "stderr": "", "exitCode": 0, "error": null }
```

Notification: `tazhan/terminal/event`

Params (union):
```json
{ "type": "data", "terminalId": "term_...", "data": "..." }
```

```json
{ "type": "exit", "terminalId": "term_...", "exitCode": 0, "signal": null }
```

```json
{ "type": "error", "terminalId": "term_...", "error": "..." }
```
