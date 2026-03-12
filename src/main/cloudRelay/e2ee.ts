import crypto from "node:crypto";

import type { JsonValue, RelayE2eeSettings, RelayE2eeTrustedPeer } from "../../shared/types";

export type E2eeHandshakeInit = {
  type: "e2ee/handshake/init";
  v: 1;
  sid: string;
  clientKeyId: string;
  clientEd25519Pub: string; // base64(spki der)
  clientX25519Pub: string; // base64(spki der) - ephemeral
  clientSig: string; // base64(signature)
};

export type E2eeHandshakeAck = {
  type: "e2ee/handshake/ack";
  v: 1;
  sid: string;
  deviceKeyId: string;
  deviceEd25519Pub: string; // base64(spki der)
  deviceX25519Pub: string; // base64(spki der) - ephemeral
  deviceSig: string; // base64(signature)
};

export type E2eeError = {
  type: "e2ee/error";
  v: 1;
  sid?: string;
  code: string;
  message: string;
};

export type E2eePacket = {
  type: "e2ee/packet";
  v: 1;
  sid: string;
  seq: number;
  ct: string; // base64(ciphertext || tag)
};

type IncomingE2ee = E2eeHandshakeInit | E2eeHandshakeAck | E2eeError | E2eePacket;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(obj: unknown, key: string): obj is Record<string, unknown> {
  return isRecord(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function b64(buf: Buffer): string {
  return buf.toString("base64");
}

function b64decode(s: string): Buffer {
  return Buffer.from(s, "base64");
}

function sha256(data: Buffer | string): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
}

export function keyIdForEd25519PublicKey(ed25519PublicKeyDerB64: string): string {
  const h = sha256(b64decode(ed25519PublicKeyDerB64));
  return `k_${base64url(h).slice(0, 16)}`;
}

export function fingerprintForEd25519PublicKey(ed25519PublicKeyDerB64: string): string {
  const h = sha256(b64decode(ed25519PublicKeyDerB64));
  const hex = h.toString("hex");
  // Group for readability (like SSH fingerprints).
  return hex.match(/.{1,4}/g)?.join(":") ?? hex;
}

export function generateDeviceEd25519Keypair(): { keyId: string; publicKeyDerB64: string; privateKeyDerB64: string; fingerprint: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const privDer = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const publicKeyDerB64 = b64(pubDer);
  const keyId = keyIdForEd25519PublicKey(publicKeyDerB64);
  return { keyId, publicKeyDerB64, privateKeyDerB64: b64(privDer), fingerprint: fingerprintForEd25519PublicKey(publicKeyDerB64) };
}

function importEd25519PublicKey(derB64: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: b64decode(derB64), format: "der", type: "spki" });
}

function importEd25519PrivateKey(derB64: string): crypto.KeyObject {
  return crypto.createPrivateKey({ key: b64decode(derB64), format: "der", type: "pkcs8" });
}

function importX25519PublicKey(derB64: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: b64decode(derB64), format: "der", type: "spki" });
}

function buildInitTranscript(params: {
  deviceId: string;
  sid: string;
  clientKeyId: string;
  clientEd25519Pub: string;
  clientX25519Pub: string;
}): Buffer {
  // Stable, language-agnostic transcript encoding.
  const lines = [
    "tazhan-e2ee-v1",
    "handshake:init",
    `deviceId=${params.deviceId}`,
    `sid=${params.sid}`,
    `clientKeyId=${params.clientKeyId}`,
    `clientEd25519Pub=${params.clientEd25519Pub}`,
    `clientX25519Pub=${params.clientX25519Pub}`,
    ""
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

function buildAckTranscript(params: {
  deviceId: string;
  sid: string;
  clientKeyId: string;
  deviceKeyId: string;
  clientEd25519Pub: string;
  clientX25519Pub: string;
  deviceEd25519Pub: string;
  deviceX25519Pub: string;
}): Buffer {
  const lines = [
    "tazhan-e2ee-v1",
    "handshake:ack",
    `deviceId=${params.deviceId}`,
    `sid=${params.sid}`,
    `clientKeyId=${params.clientKeyId}`,
    `deviceKeyId=${params.deviceKeyId}`,
    `clientEd25519Pub=${params.clientEd25519Pub}`,
    `clientX25519Pub=${params.clientX25519Pub}`,
    `deviceEd25519Pub=${params.deviceEd25519Pub}`,
    `deviceX25519Pub=${params.deviceX25519Pub}`,
    ""
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

function hkdfSha256(params: { ikm: Buffer; salt: Buffer; info: Buffer; length: number }): Buffer {
  const out = crypto.hkdfSync("sha256", params.ikm, params.salt, params.info, params.length);
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

function u64be(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n, 0);
  return b;
}

function makeNonce(prefix4: Buffer, seq: bigint): Buffer {
  if (prefix4.length !== 4) {
    throw new Error("invalid nonce prefix length");
  }
  return Buffer.concat([prefix4, u64be(seq)]);
}

type ReplayWindow = {
  maxSeq: bigint;
  // Bit i (0..63) represents whether (maxSeq - i) has been seen.
  bitmap: bigint;
};

function replayWindowInit(): ReplayWindow {
  return { maxSeq: 0n, bitmap: 0n };
}

function replayWindowAccept(window: ReplayWindow, seq: bigint): boolean {
  if (seq <= 0n) {
    return false;
  }

  if (window.maxSeq === 0n) {
    window.maxSeq = seq;
    window.bitmap = 1n;
    return true;
  }

  if (seq > window.maxSeq) {
    const shift = seq - window.maxSeq;
    if (shift >= 64n) {
      window.bitmap = 1n;
    } else {
      window.bitmap = (window.bitmap << shift) | 1n;
      window.bitmap &= (1n << 64n) - 1n;
    }
    window.maxSeq = seq;
    return true;
  }

  const delta = window.maxSeq - seq;
  if (delta >= 64n) {
    return false; // too old
  }

  const bit = 1n << delta;
  if ((window.bitmap & bit) !== 0n) {
    return false; // replay
  }

  window.bitmap |= bit;
  return true;
}

class E2eeChannel {
  private sendSeq: bigint = 0n;
  private recvWindow: ReplayWindow = replayWindowInit();

  constructor(
    private readonly sid: string,
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
    private readonly sendNoncePrefix4: Buffer,
    private readonly recvNoncePrefix4: Buffer
  ) {}

  encrypt(rpc: JsonValue): E2eePacket {
    this.sendSeq += 1n;
    const seq = this.sendSeq;
    const plaintext = Buffer.from(JSON.stringify(rpc), "utf8");
    const nonce = makeNonce(this.sendNoncePrefix4, seq);

    const aad = Buffer.from(`tazhan-e2ee-v1|sid=${this.sid}|seq=${seq.toString(10)}`, "utf8");
    const cipher = crypto.createCipheriv("aes-256-gcm", this.sendKey, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return { type: "e2ee/packet", v: 1, sid: this.sid, seq: Number(seq), ct: b64(Buffer.concat([ciphertext, tag])) };
  }

  decrypt(packet: E2eePacket): JsonValue {
    if (packet.v !== 1) {
      throw new Error("unsupported e2ee packet version");
    }
    if (packet.sid !== this.sid) {
      throw new Error("e2ee sid mismatch");
    }
    const seq = BigInt(packet.seq);
    if (!replayWindowAccept(this.recvWindow, seq)) {
      throw new Error("e2ee replay/too-old packet");
    }

    const data = b64decode(packet.ct);
    if (data.length < 16) {
      throw new Error("e2ee packet too small");
    }
    const ciphertext = data.slice(0, -16);
    const tag = data.slice(-16);
    const nonce = makeNonce(this.recvNoncePrefix4, seq);
    const aad = Buffer.from(`tazhan-e2ee-v1|sid=${this.sid}|seq=${seq.toString(10)}`, "utf8");

    const decipher = crypto.createDecipheriv("aes-256-gcm", this.recvKey, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    return parsed as JsonValue;
  }
}

type DeviceE2eeState =
  | { status: "disabled" }
  | { status: "enabled_no_session" }
  | { status: "enabled_session"; sid: string; peerKeyId: string };

export type E2eeDeviceHandleResult =
  | { kind: "noop" }
  | { kind: "send"; message: IncomingE2ee }
  | { kind: "rpc"; rpc: JsonValue }
  | { kind: "error"; error: E2eeError };

export class E2eeDeviceSession {
  private readonly deviceId: string;
  private readonly settings: RelayE2eeSettings;

  private readonly deviceEd25519Priv: crypto.KeyObject;
  private readonly deviceEd25519Pub: crypto.KeyObject;

  private trustedPeers = new Map<string, RelayE2eeTrustedPeer>();
  private trustedPeerKeys = new Map<string, crypto.KeyObject>();

  private channel: E2eeChannel | null = null;
  private currentSid: string | null = null;
  private currentPeerKeyId: string | null = null;

  constructor(params: {
    deviceId: string;
    e2ee: RelayE2eeSettings;
    decryptDevicePrivateKey: (stored: string) => string;
    onTrustPeer?: (peer: RelayE2eeTrustedPeer) => void;
  }) {
    this.deviceId = params.deviceId;
    this.settings = params.e2ee;
    this.deviceEd25519Priv = importEd25519PrivateKey(params.decryptDevicePrivateKey(params.e2ee.deviceEd25519PrivateKey));
    this.deviceEd25519Pub = importEd25519PublicKey(params.e2ee.deviceEd25519PublicKey);

    for (const peer of params.e2ee.trustedPeers ?? []) {
      this.addTrustedPeer(peer);
    }
    this.onTrustPeer = params.onTrustPeer ?? null;
  }

  private readonly onTrustPeer: ((peer: RelayE2eeTrustedPeer) => void) | null;

  getState(): DeviceE2eeState {
    if (!this.settings.enabled) {
      return { status: "disabled" };
    }
    if (!this.channel || !this.currentSid || !this.currentPeerKeyId) {
      return { status: "enabled_no_session" };
    }
    return { status: "enabled_session", sid: this.currentSid, peerKeyId: this.currentPeerKeyId };
  }

  resetSession(): void {
    this.channel = null;
    this.currentSid = null;
    this.currentPeerKeyId = null;
  }

  encryptOutgoing(rpc: JsonValue): JsonValue {
    if (!this.settings.enabled) {
      return rpc;
    }
    if (isRecord(rpc) && typeof rpc.type === "string" && rpc.type.startsWith("e2ee/")) {
      // Avoid double-wrapping.
      return rpc as unknown as JsonValue;
    }
    if (!this.channel) {
      if (this.settings.required) {
        throw new Error("e2ee is required but no session is established");
      }
      return rpc;
    }
    return this.channel.encrypt(rpc) as unknown as JsonValue;
  }

  handleIncoming(raw: JsonValue): E2eeDeviceHandleResult {
    if (!this.settings.enabled) {
      return { kind: "noop" };
    }

    const msg = this.parseIncoming(raw);
    if (!msg) {
      if (this.settings.required) {
        return { kind: "error", error: { type: "e2ee/error", v: 1, code: "e2ee_required", message: "e2ee is required" } };
      }
      return { kind: "noop" };
    }

    if (msg.type === "e2ee/handshake/init") {
      return this.handleHandshakeInit(msg);
    }
    if (msg.type === "e2ee/packet") {
      return this.handlePacket(msg);
    }
    // Ack/errors are only expected on the app side; ignore for forward compatibility.
    return { kind: "noop" };
  }

  private parseIncoming(raw: JsonValue): IncomingE2ee | null {
    if (!isRecord(raw) || typeof raw.type !== "string") {
      return null;
    }

    const t = raw.type;
    if (t === "e2ee/handshake/init") {
      return {
        type: "e2ee/handshake/init",
        v: safeInt(raw.v) === 1 ? 1 : 1,
        sid: safeString(raw.sid),
        clientKeyId: safeString(raw.clientKeyId),
        clientEd25519Pub: safeString(raw.clientEd25519Pub),
        clientX25519Pub: safeString(raw.clientX25519Pub),
        clientSig: safeString(raw.clientSig)
      };
    }
    if (t === "e2ee/packet") {
      const seq = safeInt(raw.seq);
      return {
        type: "e2ee/packet",
        v: safeInt(raw.v) === 1 ? 1 : 1,
        sid: safeString(raw.sid),
        seq: seq ?? 0,
        ct: safeString(raw.ct)
      };
    }
    if (t === "e2ee/error") {
      return {
        type: "e2ee/error",
        v: safeInt(raw.v) === 1 ? 1 : 1,
        sid: hasOwn(raw, "sid") ? safeString(raw.sid) : undefined,
        code: safeString(raw.code),
        message: safeString(raw.message)
      };
    }
    if (t === "e2ee/handshake/ack") {
      return {
        type: "e2ee/handshake/ack",
        v: safeInt(raw.v) === 1 ? 1 : 1,
        sid: safeString(raw.sid),
        deviceKeyId: safeString(raw.deviceKeyId),
        deviceEd25519Pub: safeString(raw.deviceEd25519Pub),
        deviceX25519Pub: safeString(raw.deviceX25519Pub),
        deviceSig: safeString(raw.deviceSig)
      };
    }

    return null;
  }

  private addTrustedPeer(peer: RelayE2eeTrustedPeer): void {
    if (!peer?.keyId || !peer.ed25519PublicKey) {
      return;
    }
    this.trustedPeers.set(peer.keyId, peer);
    try {
      this.trustedPeerKeys.set(peer.keyId, importEd25519PublicKey(peer.ed25519PublicKey));
    } catch {
      // Ignore invalid peer keys.
    }
  }

  private maybeTrustPeer(peer: RelayE2eeTrustedPeer): void {
    this.addTrustedPeer(peer);
    this.onTrustPeer?.(peer);
  }

  private handleHandshakeInit(init: E2eeHandshakeInit): E2eeDeviceHandleResult {
    if (!init.sid || !init.clientKeyId || !init.clientEd25519Pub || !init.clientX25519Pub || !init.clientSig) {
      return { kind: "error", error: { type: "e2ee/error", v: 1, sid: init.sid || undefined, code: "bad_handshake", message: "missing fields" } };
    }

    const claimedKeyId = init.clientKeyId;
    const computedKeyId = keyIdForEd25519PublicKey(init.clientEd25519Pub);
    if (claimedKeyId !== computedKeyId) {
      return {
        kind: "error",
        error: { type: "e2ee/error", v: 1, sid: init.sid, code: "bad_handshake", message: "clientKeyId mismatch" }
      };
    }

    let peerKey = this.trustedPeerKeys.get(claimedKeyId) ?? null;
    if (!peerKey) {
      if (!this.settings.allowTofu) {
        return { kind: "error", error: { type: "e2ee/error", v: 1, sid: init.sid, code: "untrusted_peer", message: "peer key not trusted" } };
      }
      const peer: RelayE2eeTrustedPeer = {
        keyId: claimedKeyId,
        label: "TOFU",
        ed25519PublicKey: init.clientEd25519Pub,
        addedAt: Math.floor(Date.now() / 1000)
      };
      this.maybeTrustPeer(peer);
      peerKey = this.trustedPeerKeys.get(claimedKeyId) ?? null;
    }

    if (!peerKey) {
      return { kind: "error", error: { type: "e2ee/error", v: 1, sid: init.sid, code: "untrusted_peer", message: "invalid peer key" } };
    }

    const transcript = buildInitTranscript({
      deviceId: this.deviceId,
      sid: init.sid,
      clientKeyId: init.clientKeyId,
      clientEd25519Pub: init.clientEd25519Pub,
      clientX25519Pub: init.clientX25519Pub
    });

    const sigOk = crypto.verify(null, transcript, peerKey, b64decode(init.clientSig));
    if (!sigOk) {
      return { kind: "error", error: { type: "e2ee/error", v: 1, sid: init.sid, code: "bad_handshake", message: "invalid signature" } };
    }

    const { publicKey: deviceXPub, privateKey: deviceXPriv } = crypto.generateKeyPairSync("x25519");
    const deviceX25519PubDer = deviceXPub.export({ format: "der", type: "spki" }) as Buffer;
    const deviceX25519Pub = b64(deviceX25519PubDer);

    let shared: Buffer;
    try {
      const clientXPub = importX25519PublicKey(init.clientX25519Pub);
      shared = crypto.diffieHellman({ privateKey: deviceXPriv, publicKey: clientXPub });
    } catch {
      return { kind: "error", error: { type: "e2ee/error", v: 1, sid: init.sid, code: "bad_handshake", message: "invalid x25519 key" } };
    }

    const deviceEd25519PubDer = this.deviceEd25519Pub.export({ format: "der", type: "spki" }) as Buffer;
    const deviceEd25519Pub = b64(deviceEd25519PubDer);

    const ackTranscript = buildAckTranscript({
      deviceId: this.deviceId,
      sid: init.sid,
      clientKeyId: init.clientKeyId,
      deviceKeyId: this.settings.deviceKeyId,
      clientEd25519Pub: init.clientEd25519Pub,
      clientX25519Pub: init.clientX25519Pub,
      deviceEd25519Pub,
      deviceX25519Pub
    });

    const deviceSig = crypto.sign(null, ackTranscript, this.deviceEd25519Priv);

    const salt = sha256(ackTranscript);
    const info = Buffer.from("tazhan-e2ee-v1|keys", "utf8");
    const keyMaterial = hkdfSha256({ ikm: shared, salt, info, length: 32 + 32 + 4 + 4 });
    const kA2d = keyMaterial.slice(0, 32);
    const kD2a = keyMaterial.slice(32, 64);
    const nA2d = keyMaterial.slice(64, 68);
    const nD2a = keyMaterial.slice(68, 72);

    // Device receives app->device (a2d) and sends device->app (d2a).
    this.channel = new E2eeChannel(init.sid, kD2a, kA2d, nD2a, nA2d);
    this.currentSid = init.sid;
    this.currentPeerKeyId = init.clientKeyId;

    const ack: E2eeHandshakeAck = {
      type: "e2ee/handshake/ack",
      v: 1,
      sid: init.sid,
      deviceKeyId: this.settings.deviceKeyId,
      deviceEd25519Pub,
      deviceX25519Pub,
      deviceSig: b64(deviceSig)
    };

    return { kind: "send", message: ack };
  }

  private handlePacket(packet: E2eePacket): E2eeDeviceHandleResult {
    if (!this.channel || !this.currentSid) {
      return { kind: "error", error: { type: "e2ee/error", v: 1, sid: packet.sid, code: "no_session", message: "no active e2ee session" } };
    }

    try {
      const decrypted = this.channel.decrypt(packet);
      return { kind: "rpc", rpc: decrypted };
    } catch (err) {
      return { kind: "error", error: { type: "e2ee/error", v: 1, sid: packet.sid, code: "decrypt_failed", message: String(err) } };
    }
  }
}

type AppE2eeState =
  | { status: "disabled" }
  | { status: "enabled_no_session" }
  | { status: "enabled_session"; sid: string; deviceKeyId: string };

export class E2eeAppSession {
  private readonly deviceId: string;
  private readonly deviceKeyId: string;
  private readonly deviceEd25519PubDerB64: string;

  private readonly clientKeyId: string;
  private readonly clientEd25519Priv: crypto.KeyObject;
  private readonly clientEd25519PubDerB64: string;

  private pending: { sid: string; clientX25519Priv: crypto.KeyObject; clientX25519PubDerB64: string } | null = null;
  private channel: E2eeChannel | null = null;
  private currentSid: string | null = null;

  constructor(params: {
    deviceId: string;
    deviceKeyId: string;
    deviceEd25519PublicKey: string; // base64(spki der)
    clientKeyId: string;
    clientEd25519PublicKey: string; // base64(spki der)
    clientEd25519PrivateKey: string; // base64(pkcs8 der)
  }) {
    this.deviceId = params.deviceId;
    this.deviceKeyId = params.deviceKeyId;
    this.deviceEd25519PubDerB64 = params.deviceEd25519PublicKey;
    this.clientKeyId = params.clientKeyId;
    this.clientEd25519PubDerB64 = params.clientEd25519PublicKey;
    this.clientEd25519Priv = importEd25519PrivateKey(params.clientEd25519PrivateKey);
  }

  getState(): AppE2eeState {
    if (!this.channel || !this.currentSid) {
      return { status: "enabled_no_session" };
    }
    return { status: "enabled_session", sid: this.currentSid, deviceKeyId: this.deviceKeyId };
  }

  resetSession(): void {
    this.pending = null;
    this.channel = null;
    this.currentSid = null;
  }

  buildHandshakeInit(): E2eeHandshakeInit {
    const sid = base64url(crypto.randomBytes(16));
    const { publicKey: clientXPub, privateKey: clientXPriv } = crypto.generateKeyPairSync("x25519");
    const clientX25519PubDer = clientXPub.export({ format: "der", type: "spki" }) as Buffer;
    const clientX25519PubDerB64 = b64(clientX25519PubDer);

    const transcript = buildInitTranscript({
      deviceId: this.deviceId,
      sid,
      clientKeyId: this.clientKeyId,
      clientEd25519Pub: this.clientEd25519PubDerB64,
      clientX25519Pub: clientX25519PubDerB64
    });
    const sig = crypto.sign(null, transcript, this.clientEd25519Priv);

    this.pending = { sid, clientX25519Priv: clientXPriv, clientX25519PubDerB64 };

    return {
      type: "e2ee/handshake/init",
      v: 1,
      sid,
      clientKeyId: this.clientKeyId,
      clientEd25519Pub: this.clientEd25519PubDerB64,
      clientX25519Pub: clientX25519PubDerB64,
      clientSig: b64(sig)
    };
  }

  handleHandshakeAck(ack: E2eeHandshakeAck): void {
    const pending = this.pending;
    if (!pending || pending.sid !== ack.sid) {
      throw new Error("unexpected handshake ack");
    }

    if (ack.deviceKeyId !== this.deviceKeyId) {
      throw new Error("deviceKeyId mismatch");
    }
    if (ack.deviceEd25519Pub !== this.deviceEd25519PubDerB64) {
      throw new Error("deviceEd25519Pub mismatch");
    }

    const devicePubKey = importEd25519PublicKey(this.deviceEd25519PubDerB64);

    const ackTranscript = buildAckTranscript({
      deviceId: this.deviceId,
      sid: ack.sid,
      clientKeyId: this.clientKeyId,
      deviceKeyId: this.deviceKeyId,
      clientEd25519Pub: this.clientEd25519PubDerB64,
      clientX25519Pub: pending.clientX25519PubDerB64,
      deviceEd25519Pub: ack.deviceEd25519Pub,
      deviceX25519Pub: ack.deviceX25519Pub
    });

    const sigOk = crypto.verify(null, ackTranscript, devicePubKey, b64decode(ack.deviceSig));
    if (!sigOk) {
      throw new Error("invalid device signature");
    }

    const deviceXPub = importX25519PublicKey(ack.deviceX25519Pub);
    const shared = crypto.diffieHellman({ privateKey: pending.clientX25519Priv, publicKey: deviceXPub });

    const salt = sha256(ackTranscript);
    const info = Buffer.from("tazhan-e2ee-v1|keys", "utf8");
    const keyMaterial = hkdfSha256({ ikm: shared, salt, info, length: 32 + 32 + 4 + 4 });
    const kA2d = keyMaterial.slice(0, 32);
    const kD2a = keyMaterial.slice(32, 64);
    const nA2d = keyMaterial.slice(64, 68);
    const nD2a = keyMaterial.slice(68, 72);

    // App sends app->device (a2d) and receives device->app (d2a).
    this.channel = new E2eeChannel(ack.sid, kA2d, kD2a, nA2d, nD2a);
    this.currentSid = ack.sid;
    this.pending = null;
  }

  encryptOutgoing(rpc: JsonValue): E2eePacket {
    if (!this.channel) {
      throw new Error("no e2ee session");
    }
    return this.channel.encrypt(rpc);
  }

  decryptIncoming(packet: E2eePacket): JsonValue {
    if (!this.channel) {
      throw new Error("no e2ee session");
    }
    return this.channel.decrypt(packet);
  }
}
