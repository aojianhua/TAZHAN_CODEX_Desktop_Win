import { describe, expect, it } from "vitest";

import { E2eeAppSession, E2eeDeviceSession, generateDeviceEd25519Keypair } from "./e2ee";

describe("E2EE", () => {
  it("handshakes and encrypts/decrypts both directions", () => {
    const deviceKeys = generateDeviceEd25519Keypair();
    const appKeys = generateDeviceEd25519Keypair();

    const device = new E2eeDeviceSession({
      deviceId: "dev_test",
      e2ee: {
        enabled: true,
        required: true,
        allowTofu: false,
        deviceKeyId: deviceKeys.keyId,
        deviceEd25519PublicKey: deviceKeys.publicKeyDerB64,
        deviceEd25519PrivateKey: deviceKeys.privateKeyDerB64,
        trustedPeers: [
          { keyId: appKeys.keyId, label: "app", ed25519PublicKey: appKeys.publicKeyDerB64, addedAt: 0 }
        ]
      },
      decryptDevicePrivateKey: (s) => s
    });

    const app = new E2eeAppSession({
      deviceId: "dev_test",
      deviceKeyId: deviceKeys.keyId,
      deviceEd25519PublicKey: deviceKeys.publicKeyDerB64,
      clientKeyId: appKeys.keyId,
      clientEd25519PublicKey: appKeys.publicKeyDerB64,
      clientEd25519PrivateKey: appKeys.privateKeyDerB64
    });

    const init = app.buildHandshakeInit();
    const initRes = device.handleIncoming(init as any);
    expect(initRes.kind).toBe("send");
    const ack = (initRes as any).message;
    expect(ack.type).toBe("e2ee/handshake/ack");

    app.handleHandshakeAck(ack);

    const req = { id: 1, method: "tazhan/workspace/listRoots", params: {} };
    const pkt1 = app.encryptOutgoing(req as any);
    const pkt2 = app.encryptOutgoing({ id: 2, method: "tazhan/terminal/run", params: { command: "echo hi" } } as any);

    // Deliver out-of-order; replay window should accept.
    const r2 = device.handleIncoming(pkt2 as any);
    expect(r2.kind).toBe("rpc");
    expect((r2 as any).rpc).toEqual({ id: 2, method: "tazhan/terminal/run", params: { command: "echo hi" } });

    const r1 = device.handleIncoming(pkt1 as any);
    expect(r1.kind).toBe("rpc");
    expect((r1 as any).rpc).toEqual(req);

    // Device -> app
    const resp = { id: 1, result: { ok: true } };
    const out = device.encryptOutgoing(resp as any);
    expect((out as any).type).toBe("e2ee/packet");
    const decoded = app.decryptIncoming(out as any);
    expect(decoded).toEqual(resp);
  });

  it("rejects replays", () => {
    const deviceKeys = generateDeviceEd25519Keypair();
    const appKeys = generateDeviceEd25519Keypair();

    const device = new E2eeDeviceSession({
      deviceId: "dev_test",
      e2ee: {
        enabled: true,
        required: true,
        allowTofu: false,
        deviceKeyId: deviceKeys.keyId,
        deviceEd25519PublicKey: deviceKeys.publicKeyDerB64,
        deviceEd25519PrivateKey: deviceKeys.privateKeyDerB64,
        trustedPeers: [
          { keyId: appKeys.keyId, label: "app", ed25519PublicKey: appKeys.publicKeyDerB64, addedAt: 0 }
        ]
      },
      decryptDevicePrivateKey: (s) => s
    });

    const app = new E2eeAppSession({
      deviceId: "dev_test",
      deviceKeyId: deviceKeys.keyId,
      deviceEd25519PublicKey: deviceKeys.publicKeyDerB64,
      clientKeyId: appKeys.keyId,
      clientEd25519PublicKey: appKeys.publicKeyDerB64,
      clientEd25519PrivateKey: appKeys.privateKeyDerB64
    });

    const init = app.buildHandshakeInit();
    const initRes = device.handleIncoming(init as any);
    const ack = (initRes as any).message;
    app.handleHandshakeAck(ack);

    const pkt = app.encryptOutgoing({ id: 1, method: "ping" } as any);

    const first = device.handleIncoming(pkt as any);
    expect(first.kind).toBe("rpc");

    const second = device.handleIncoming(pkt as any);
    expect(second.kind).toBe("error");
  });
});

