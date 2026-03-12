import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { JsonlRpcClient } from "./jsonlRpc";

function readNextLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx);
        resolve(line);
      }
    });
  });
}

describe("JsonlRpcClient", () => {
  it("sends a request and resolves on response", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const rpc = new JsonlRpcClient(readable, writable);

    const pending = rpc.call("thread/start", { cwd: "/tmp" });
    const line = await readNextLine(writable);
    const sent = JSON.parse(line) as any;
    expect(sent.method).toBe("thread/start");
    expect(sent.params).toEqual({ cwd: "/tmp" });
    expect(typeof sent.id).toBe("number");

    readable.write(JSON.stringify({ id: sent.id, result: { ok: true } }) + "\n");
    await expect(pending).resolves.toEqual({ ok: true });

    rpc.dispose();
  });

  it("emits server requests", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const rpc = new JsonlRpcClient(readable, writable);

    const reqPromise = new Promise<any>((resolve) => {
      rpc.on("request", (req) => resolve(req));
    });

    readable.write(
      JSON.stringify({
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" }
      }) + "\n"
    );

    const req = await reqPromise;
    expect(req.method).toBe("item/commandExecution/requestApproval");
    expect(req.params).toEqual({ threadId: "thr_1", turnId: "turn_1", itemId: "item_1" });

    rpc.dispose();
    void writable;
  });
});

