import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser } from "playwright";
import { HttpError } from "../src/http-error.ts";
import { renderDashboard, type HomeAssistant } from "../src/render.ts";
import type { RenderRequest } from "../src/request.ts";

const TOKEN = "test-token";
const LOADED = [0, 128, 0];

const FRONTEND = `<!doctype html>
<style>
  body { margin: 0 }
  #header { height: 56px; background: rgb(255, 0, 0) }
  #content { position: relative; height: 744px; background: rgb(128, 128, 128) }
  body.tall #content { height: 1444px }
  #camera { position: absolute; bottom: 0; width: 100%; height: 100px; background: rgb(128, 128, 128) }
</style>
<div id="ha-launch-screen"></div><div id="header"></div><div id="content"><div id="camera"></div></div>
<script>
  const tokens = JSON.parse(localStorage.getItem("hassTokens") ?? "null");
  if (tokens?.access_token !== "${TOKEN}") location.replace("/auth/authorize?redirect_uri=x");
  if (location.pathname === "/tall") document.body.classList.add("tall");
  fetch("/report", { method: "POST", body: JSON.stringify({
    path: location.pathname,
    navigatorLanguage: navigator.language,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    innerHeight,
    storage: Object.fromEntries(Object.entries(localStorage)),
  }) });

  class Shadowed extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }); } }
  customElements.define("home-assistant", class extends Shadowed {});
  customElements.define("home-assistant-main", class extends Shadowed {});
  // Like the frontend's hui-image and webrtc-camera, which load a camera only while it is on screen and
  // take time to start. Requiring 300 ms on screen is what lets a test catch a viewport shrunk before the wait.
  const camera = document.getElementById("camera");
  const watchCamera = () => {
    let loading;
    new IntersectionObserver((entries, observer) => {
      clearTimeout(loading);
      if (!entries.some((entry) => entry.isIntersecting)) return;
      loading = setTimeout(() => {
        observer.disconnect();
        camera.style.background = "rgb(0, 128, 0)";
      }, 300);
    }).observe(camera);
  };

  const app = document.body.appendChild(document.createElement("home-assistant"));
  const main = app.shadowRoot.appendChild(document.createElement("home-assistant-main"));
  const resolver = main.shadowRoot.appendChild(document.createElement("partial-panel-resolver"));

  // A cold load: the panel resolver shows a loading screen until the panel's code arrives, and the
  // launch screen stays until the cards are in place, or until the frontend stops waiting (capped).
  const launchScreen = document.getElementById("ha-launch-screen");
  const showPanel = () => resolver.replaceChildren(document.createElement("ha-panel-lovelace"));
  const showCards = () => {
    document.getElementById("content").style.background = "rgb(0, 128, 0)";
    watchCamera();
  };
  setTimeout(() => resolver.appendChild(document.createElement("hass-loading-screen")), 100);
  if (location.pathname === "/lovelace/capped") {
    launchScreen.remove();
    setTimeout(() => { showPanel(); showCards(); }, 500);
  } else {
    setTimeout(showPanel, 300);
    setTimeout(() => { showCards(); launchScreen.remove(); }, 500);
  }
</script>`;

interface Report {
  path: string;
  navigatorLanguage: string;
  reducedMotion: boolean;
  innerHeight: number;
  storage: Record<string, string>;
}

let browser: Browser;
let server: Server;
let homeAssistant: HomeAssistant;
const reports: Report[] = [];

before(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    if (req.url === "/report") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        reports.push(JSON.parse(body) as Report);
        res.end();
      });
      return;
    }
    if (req.url?.startsWith("/unavailable")) {
      res.writeHead(503).end("restarting");
      return;
    }
    if (req.url?.startsWith("/missing")) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end(req.url?.startsWith("/auth/") ? "<h1>Log in</h1>" : FRONTEND);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  homeAssistant = { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: TOKEN };
});

after(async () => {
  await browser.close();
  server.close();
});

function request(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    path: "lovelace/0",
    width: 320,
    height: 200,
    zoom: 1,
    waitMs: 0,
    format: "png",
    theme: undefined,
    dark: false,
    language: undefined,
    ...overrides,
  };
}

const render = (overrides: Partial<RenderRequest> = {}, ha = homeAssistant) =>
  renderDashboard(browser, ha, request(overrides), new AbortController().signal);

async function inspect(image: Buffer, x: number, y: number): Promise<{ width: number; height: number; rgb: number[] }> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ src, x, y }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(img, 0, 0);
        const [r, g, b] = context.getImageData(x, y, 1, 1).data;
        return { width: img.width, height: img.height, rgb: [r!, g!, b!] };
      },
      { src: `data:image/png;base64,${image.toString("base64")}`, x, y },
    );
  } finally {
    await page.close();
  }
}

async function waitForReport(path: string): Promise<Report> {
  for (let i = 0; i < 100; i++) {
    const report = reports.findLast((r) => r.path === path);
    if (report) return report;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`no report for ${path}`);
}

describe("renderDashboard", () => {
  it("signs in, waits for the panel, and crops the header off", async () => {
    const image = await render();
    assert.deepEqual(await inspect(image, 10, 0), { width: 320, height: 200, rgb: LOADED });
  });

  it("waits for the real panel when the launch screen goes first", async () => {
    const image = await render({ path: "lovelace/capped" });
    assert.deepEqual((await inspect(image, 10, 0)).rgb, LOADED);
  });

  it("zooms the page and crops the zoomed header off", async () => {
    const image = await render({ zoom: 2, height: "auto" });
    assert.deepEqual(await inspect(image, 10, 0), { width: 320, height: 1488, rgb: LOADED });
  });

  it("hands the frontend its token, theme, language and a hidden sidebar through localStorage", async () => {
    await render({ path: "lovelace/report", theme: "Midnight", dark: true, language: "de" });
    const report = await waitForReport("/lovelace/report");
    assert.equal(report.navigatorLanguage, "de");
    assert.equal(report.reducedMotion, true);
    assert.deepEqual(JSON.parse(report.storage.hassTokens!), {
      access_token: TOKEN,
      token_type: "Bearer",
      expires_in: 1800,
      hassUrl: homeAssistant.origin,
      clientId: `${homeAssistant.origin}/`,
      expires: 9_999_999_999_999,
      refresh_token: "",
    });
    assert.deepEqual(JSON.parse(report.storage.selectedTheme!), { theme: "Midnight", dark: true });
    assert.equal(JSON.parse(report.storage.selectedLanguage!), "de");
    assert.equal(JSON.parse(report.storage.dockedSidebar!), "always_hidden");
  });

  it("measures the full page for an auto height", async () => {
    const image = await render({ path: "tall", height: "auto" });
    const { width, height } = await inspect(image, 0, 0);
    assert.deepEqual([width, height], [320, 1444]);
  });

  it("makes an auto-height render of a short page 800 px tall, like the default viewport", async () => {
    const image = await render({ height: "auto" });
    assert.equal((await inspect(image, 0, 0)).height, 800);
  });

  it("renders a fixed height in a viewport of that height plus the header", async () => {
    await render({ path: "lovelace/fixed-viewport", height: 200 });
    assert.equal((await waitForReport("/lovelace/fixed-viewport")).innerHeight, 256);
  });

  it("shows content below the fold that loads only while on screen, for an auto height", async () => {
    const image = await render({ path: "tall", height: "auto", waitMs: 1_000 });
    assert.deepEqual((await inspect(image, 10, 1400)).rgb, LOADED);
  });

  it("returns a JPEG or WebP when asked", async () => {
    const jpeg = await render({ format: "jpeg" });
    assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    const webp = await render({ format: "webp" });
    assert.deepEqual([webp.subarray(0, 4).toString("latin1"), webp.subarray(8, 12).toString("latin1")], ["RIFF", "WEBP"]);
  });

  it("fails with 502 when Home Assistant shows its login page", async () => {
    await assert.rejects(
      render({}, { ...homeAssistant, token: "revoked" }),
      (error: unknown) => error instanceof HttpError && error.status === 502 && /login page/.test(error.message),
    );
  });

  it("fails with 502 when Home Assistant cannot be reached", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((resolve) => closed.close(resolve));
    await assert.rejects(
      render({}, { origin, token: TOKEN }),
      (error: unknown) => error instanceof HttpError && error.status === 502 && /Could not reach Home Assistant/.test(error.message),
    );
  });

  it("fails with 502 when Home Assistant answers with an error status", async () => {
    await assert.rejects(
      render({ path: "unavailable" }),
      (error: unknown) => error instanceof HttpError && error.status === 502 && /answered 503/.test(error.message),
    );
  });

  it("fails with 404 when Home Assistant has no such page", async () => {
    await assert.rejects(
      render({ path: "missing" }),
      (error: unknown) => error instanceof HttpError && error.status === 404,
    );
  });

  it("stays on the Home Assistant origin whatever the path looks like", async () => {
    await render({ path: "/evil.example/x" });
    await waitForReport("//evil.example/x");
  });

  it("stops when the signal aborts while its browser context is being created", async () => {
    const controller = new AbortController();
    const rendering = renderDashboard(browser, homeAssistant, request({ waitMs: 10_000 }), controller.signal);
    controller.abort(new Error("deadline"));
    const started = Date.now();
    await assert.rejects(rendering, /deadline/);
    assert.ok(Date.now() - started < 5_000, "render kept running after the abort");
    assert.equal(browser.contexts().length, 0);
  });

  it("stops and closes its browser context when the signal aborts", async () => {
    const controller = new AbortController();
    const rendering = renderDashboard(browser, homeAssistant, request({ path: "lovelace/abort", waitMs: 10_000 }), controller.signal);
    await waitForReport("/lovelace/abort");
    controller.abort(new Error("deadline"));
    const started = Date.now();
    await assert.rejects(rendering);
    assert.ok(Date.now() - started < 5_000, "render kept running after the abort");
    assert.equal(browser.contexts().length, 0);
  });
});
