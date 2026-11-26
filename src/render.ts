import { errors, type Browser } from "playwright";
import { HttpError } from "./http-error.ts";
import { MAX_DIMENSION, type RenderRequest } from "./request.ts";

export interface HomeAssistant {
  origin: string;
  /** Long-lived access token of the user whose view is rendered. */
  token: string;
}

const HEADER_HEIGHT = 56;
const AUTO_RENDER_HEIGHT = 800;
const LOAD_TIMEOUT_MS = 10_000;

/**
 * Renders one Home Assistant route in a fresh browser context and returns the image.
 * The top app bar is cropped off. Aborting `signal` closes the browser context, so pending work rejects.
 * Throws an HttpError for a missing page (404), an unreachable Home Assistant or a login redirect (502),
 * or a timeout (504).
 */
export async function renderDashboard(
  browser: Browser,
  homeAssistant: HomeAssistant,
  request: RenderRequest,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const header = Math.round(HEADER_HEIGHT * request.zoom);
  // Some cards, such as camera images, load only once on screen, and a full-page capture never
  // scrolls, so an auto height loads with all it may capture on screen.
  const initialHeight = request.height === "auto" ? MAX_DIMENSION : request.height;
  const context = await browser.newContext({
    viewport: { width: request.width, height: initialHeight + header },
    colorScheme: request.dark ? "dark" : "light",
    reducedMotion: "reduce",
    ...(request.language ? { locale: request.language } : {}),
    storageState: {
      cookies: [],
      origins: [{ origin: homeAssistant.origin, localStorage: frontendStorage(homeAssistant, request) }],
    },
  });
  // A second context.close() returns before the first one finishes, so every caller awaits this one.
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= context.close());
  const onAbort = () => void close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const page = await context.newPage();
    const target = new URL(homeAssistant.origin);
    target.pathname = `/${request.path}`;

    const response = await page.goto(target.href).catch((error: unknown) => {
      if (signal.aborted || error instanceof errors.TimeoutError || !(error instanceof Error)) throw error;
      throw new HttpError(502, `Could not reach Home Assistant: ${error.message.split("\n", 1)[0]}`);
    });
    if (response?.status() === 404) {
      throw new HttpError(404, `Home Assistant has no page at /${request.path}`);
    }
    if (!response?.ok()) {
      throw new HttpError(502, `Home Assistant answered ${response?.status() ?? "nothing"} for /${request.path}`);
    }
    await page.waitForFunction(panelLoadedOrLoginShown, undefined, { timeout: LOAD_TIMEOUT_MS }).catch((error: unknown) => {
      if (!(error instanceof errors.TimeoutError)) throw error;
      console.warn(`/${request.path}: Home Assistant did not report its panel as loaded; capturing anyway`);
    });
    if (new URL(page.url()).pathname.startsWith("/auth/authorize")) {
      throw new HttpError(502, "Home Assistant showed its login page: HA_TOKEN is missing, invalid or revoked");
    }
    if (request.zoom !== 1) {
      await page.evaluate((zoom) => {
        document.body.style.zoom = String(zoom);
      }, request.zoom);
    }
    await page.waitForTimeout(request.waitMs);
    if (request.height === "auto") {
      // scrollHeight never reads below the viewport height, so the page is measured in the short viewport.
      await page.setViewportSize({ width: request.width, height: AUTO_RENDER_HEIGHT + header });
    }

    const height =
      request.height === "auto"
        ? Math.min(Math.max((await page.evaluate(() => document.documentElement.scrollHeight)) - header, 1), MAX_DIMENSION)
        : request.height;
    return await page.screenshot({
      type: request.format,
      fullPage: request.height === "auto",
      clip: { x: 0, y: header, width: request.width, height },
    });
  } catch (error) {
    if (error instanceof errors.TimeoutError && !signal.aborted) {
      throw new HttpError(504, `Home Assistant did not load /${request.path} in time`);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await close();
  }
}

// The frontend signs in from `hassTokens`; an empty refresh token and a far expiry make it use the
// long-lived token as is.
function frontendStorage(homeAssistant: HomeAssistant, request: RenderRequest): { name: string; value: string }[] {
  const storage = [
    {
      name: "hassTokens",
      value: JSON.stringify({
        access_token: homeAssistant.token,
        token_type: "Bearer",
        expires_in: 1800,
        hassUrl: homeAssistant.origin,
        clientId: `${homeAssistant.origin}/`,
        expires: 9_999_999_999_999,
        refresh_token: "",
      }),
    },
    { name: "dockedSidebar", value: JSON.stringify("always_hidden") },
    { name: "selectedTheme", value: JSON.stringify({ theme: request.theme ?? "", dark: request.dark }) },
  ];
  if (request.language) {
    storage.push({ name: "selectedLanguage", value: JSON.stringify(request.language) });
  }
  return storage;
}

// Runs in the page. Since 2026.8 the frontend keeps its launch screen up until the panel has rendered
// (a dashboard: its cards are in place) or it gives up waiting after 5 s; until the panel's code has
// loaded, the panel resolver shows `hass-loading-screen` in its place.
function panelLoadedOrLoginShown(): boolean {
  if (location.pathname.startsWith("/auth/authorize")) {
    return true;
  }
  if (document.getElementById("ha-launch-screen")) {
    return false;
  }
  const main = document.querySelector("home-assistant")?.shadowRoot?.querySelector("home-assistant-main");
  const panel = main?.shadowRoot?.querySelector("partial-panel-resolver")?.children[0];
  return panel !== undefined && panel.localName !== "hass-loading-screen";
}
