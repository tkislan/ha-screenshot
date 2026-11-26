import { createServer, type ServerResponse } from "node:http";
import { chromium } from "playwright";
import { createHandler } from "./handler.ts";
import { renderDashboard } from "./render.ts";

const MAX_CONCURRENT_RENDERS = 2;
// ha-mcp stops waiting for an image after 60 s by default.
const RENDER_DEADLINE_MS = 55_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set`);
    process.exit(1);
  }
  return value;
}

const haUrl = new URL(requiredEnv("HA_URL"));
if (!["http:", "https:"].includes(haUrl.protocol) || haUrl.pathname !== "/" || haUrl.search || haUrl.hash) {
  console.error("HA_URL must be an http(s) origin such as http://homeassistant:8123");
  process.exit(1);
}
const homeAssistant = { origin: haUrl.origin, token: requiredEnv("HA_TOKEN") };
const password = requiredEnv("ENGINE_PASSWORD");
const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error("PORT must be a port number");
  process.exit(1);
}

// Chromium inherits this environment.
delete process.env.HA_TOKEN;
delete process.env.ENGINE_PASSWORD;

// Playwright would otherwise close Chromium on SIGTERM, cutting off the renders the shutdown below lets finish.
const browser = await chromium.launch({ handleSIGTERM: false });
const exitWithBrowser = () => {
  console.error("Chromium exited");
  process.exit(1);
};
browser.on("disconnected", exitWithBrowser);

const handle = createHandler({
  password,
  render: (request, signal) => renderDashboard(browser, homeAssistant, request, signal),
  isHealthy: () => browser.isConnected(),
  maxConcurrentRenders: MAX_CONCURRENT_RENDERS,
  deadlineMs: RENDER_DEADLINE_MS,
});
let shuttingDown = false;
const openResponses = new Set<ServerResponse>();
const server = createServer((req, res) => {
  openResponses.add(res);
  res.on("close", () => openResponses.delete(res));
  if (shuttingDown) res.setHeader("Connection", "close");
  void handle(req, res);
});
server.listen(port, () => console.log(`Listening on port ${port}, rendering ${homeAssistant.origin}`));

// server.close() keeps serving new requests on connections that are already open, such as the one
// ha-mcp reuses for every viewport of a batch; Connection: close ends each of them after its response.
process.once("SIGTERM", () => {
  shuttingDown = true;
  for (const res of openResponses) {
    if (!res.headersSent) res.setHeader("Connection", "close");
  }
  server.close(() => {
    browser.off("disconnected", exitWithBrowser);
    void browser.close().then(() => process.exit(0));
  });
});
