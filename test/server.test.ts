import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The smallest page the engine treats as a loaded Home Assistant dashboard.
const LOADED_FRONTEND = `<!doctype html><body><script>
  class Shadowed extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }); } }
  customElements.define("home-assistant", class extends Shadowed {});
  customElements.define("home-assistant-main", class extends Shadowed {});
  const app = document.body.appendChild(document.createElement("home-assistant"));
  const main = app.shadowRoot.appendChild(document.createElement("home-assistant-main"));
  main.shadowRoot.appendChild(document.createElement("partial-panel-resolver")).appendChild(document.createElement("ha-panel-lovelace"));
</script>`;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function waitForOutput(child: ChildProcess, pattern: RegExp): Promise<void> {
  let output = "";
  const signal = AbortSignal.timeout(15_000);
  for await (const chunk of child.stdout!.iterator({ destroyOnReturn: false })) {
    output += String(chunk);
    if (pattern.test(output)) return;
    signal.throwIfAborted();
  }
  assert.fail(`server exited before printing ${pattern}; output: ${output}`);
}

describe("server", () => {
  it("finishes a render in progress on SIGTERM, then exits with 0", async () => {
    const pageRequested = Promise.withResolvers<void>();
    const homeAssistant = createServer((_req, res) => {
      pageRequested.resolve();
      res.writeHead(200, { "Content-Type": "text/html" }).end(LOADED_FRONTEND);
    });
    const haPort = await listen(homeAssistant);
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));

    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
      env: {
        ...process.env,
        HA_URL: `http://127.0.0.1:${haPort}`,
        HA_TOKEN: "token",
        ENGINE_PASSWORD: "password",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await waitForOutput(child, /Listening on port/);
      const response = fetch(`http://127.0.0.1:${port}/lovelace/0?wait=2000`, {
        headers: { authorization: `Basic ${Buffer.from("ha-mcp:password").toString("base64")}` },
      });
      await pageRequested.promise;
      child.kill("SIGTERM");

      const res = await response;
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      const [code] = await once(child, "exit", { signal: AbortSignal.timeout(15_000) });
      assert.equal(code, 0);
    } finally {
      child.kill("SIGKILL");
      homeAssistant.close();
    }
  });
});
