import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createHandler, type HandlerOptions } from "../src/handler.ts";
import { HttpError } from "../src/http-error.ts";
import type { RenderRequest } from "../src/request.ts";

const PASSWORD = "correct horse";
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const servers: Server[] = [];

after(() => servers.forEach((server) => server.close()));

async function start(overrides: Partial<HandlerOptions> = {}): Promise<string> {
  const server = createServer(
    createHandler({
      password: PASSWORD,
      render: async () => IMAGE,
      isHealthy: () => true,
      maxConcurrentRenders: 2,
      deadlineMs: 5_000,
      ...overrides,
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const auth = (user: string, password: string) => ({
  authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await sleep(10);
  assert.ok(condition(), "condition not met within 2 s");
}

describe("createHandler", () => {
  it("answers /healthz without a password", async () => {
    const healthy = await start();
    const res = await fetch(`${healthy}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");

    const unhealthy = await start({ isHealthy: () => false });
    assert.equal((await fetch(`${unhealthy}/healthz`)).status, 503);
  });

  it("asks for the password on every path other than exactly /healthz", async () => {
    const base = await start();
    for (const path of ["/healthz/", "/healthz/x", "/healthzx", "/HEALTHZ"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 401, path);
    }
  });

  it("rejects renders without the right password and never renders", async () => {
    let renders = 0;
    const base = await start({ render: async () => (renders++, IMAGE) });

    const missing = await fetch(`${base}/lovelace/0`);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), 'Basic realm="ha-screenshot"');
    assert.equal((await fetch(`${base}/lovelace/0`, { headers: auth("ha-mcp", "wrong") })).status, 401);
    const bearer = { authorization: `Bearer ${Buffer.from(`ha-mcp:${PASSWORD}`).toString("base64")}` };
    assert.equal((await fetch(`${base}/lovelace/0`, { headers: bearer })).status, 401);
    assert.equal(renders, 0);
  });

  it("renders with the right password whatever the user name", async () => {
    let received: RenderRequest | undefined;
    const base = await start({ render: async (request) => ((received = request), IMAGE) });

    const res = await fetch(`${base}/lovelace/0?viewport=390x844`, { headers: auth("anyone", PASSWORD) });
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), IMAGE);
    assert.equal(received?.path, "lovelace/0");
    assert.equal(received?.width, 390);
  });

  it("labels the image with the content type of the requested format", async () => {
    const base = await start();
    const png = await fetch(`${base}/lovelace/0?format=png`, { headers: auth("ha-mcp", PASSWORD) });
    assert.equal(png.headers.get("content-type"), "image/png");
    const jpeg = await fetch(`${base}/lovelace/0?format=jpeg`, { headers: auth("ha-mcp", PASSWORD) });
    assert.equal(jpeg.headers.get("content-type"), "image/jpeg");
  });

  it("reads a path that starts with two slashes as a path, not as a host", async () => {
    let received: RenderRequest | undefined;
    const base = await start({ render: async (request) => ((received = request), IMAGE) });
    assert.equal((await fetch(`${base}//lovelace/0`, { headers: auth("ha-mcp", PASSWORD) })).status, 200);
    assert.equal(received?.path, "lovelace/0");
  });

  it("answers 400 with the reason for invalid parameters", async () => {
    const base = await start();
    const res = await fetch(`${base}/lovelace/0?viewport=10x10`, { headers: auth("ha-mcp", PASSWORD) });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /viewport width must be between 64 and 4096/);
  });

  it("answers 405 for methods other than GET", async () => {
    const base = await start();
    assert.equal((await fetch(`${base}/lovelace/0`, { method: "POST", headers: auth("ha-mcp", PASSWORD) })).status, 405);
  });

  it("passes an HttpError from the render through with its status and message", async () => {
    const base = await start({ render: async () => Promise.reject(new HttpError(502, "login page")) });
    const res = await fetch(`${base}/lovelace/0`, { headers: auth("ha-mcp", PASSWORD) });
    assert.equal(res.status, 502);
    assert.equal(await res.text(), "login page");
  });

  it("answers 500 with the first line of any other render error", async () => {
    const base = await start({ render: async () => Promise.reject(new Error("boom\nstack details")) });
    const res = await fetch(`${base}/lovelace/0`, { headers: auth("ha-mcp", PASSWORD) });
    assert.equal(res.status, 500);
    assert.equal(await res.text(), "Rendering failed: boom");
  });

  it("answers 504 and aborts the render when the deadline passes", async () => {
    let renderSignal: AbortSignal | undefined;
    const base = await start({
      deadlineMs: 100,
      render: (_request, signal) => {
        renderSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      },
    });
    const res = await fetch(`${base}/lovelace/0`, { headers: auth("ha-mcp", PASSWORD), signal: AbortSignal.timeout(3_000) });
    assert.equal(res.status, 504);
    assert.equal(renderSignal?.aborted, true);
  });

  it("aborts the render when the client disconnects", async () => {
    let renderSignal: AbortSignal | undefined;
    const base = await start({
      render: (_request, signal) => {
        renderSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      },
    });
    const client = new AbortController();
    const request = fetch(`${base}/lovelace/0`, { headers: auth("ha-mcp", PASSWORD), signal: client.signal });
    await waitFor(() => renderSignal !== undefined);
    client.abort();
    await assert.rejects(request);
    await waitFor(() => renderSignal?.aborted === true);
  });

  it("queues renders beyond the limit", async () => {
    let active = 0;
    let peak = 0;
    const base = await start({
      maxConcurrentRenders: 1,
      render: async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(50);
        active--;
        return IMAGE;
      },
    });
    const responses = await Promise.all(
      [1, 2, 3].map(() => fetch(`${base}/lovelace/0`, { headers: auth("ha-mcp", PASSWORD) })),
    );
    assert.deepEqual(responses.map((res) => res.status), [200, 200, 200]);
    assert.equal(peak, 1);
  });
});
