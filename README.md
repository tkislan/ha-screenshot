# ha-screenshot

A small HTTP server that renders Home Assistant dashboards to images with headless Chromium, for
[ha-mcp](https://github.com/homeassistant-ai/ha-mcp)'s dashboard screenshot tools. It speaks the
request format ha-mcp uses for its screenshot engines, so ha-mcp needs only
`HAMCP_DASHBOARD_SCREENSHOT_ENGINE_URL` pointed at it.

The server is TypeScript run directly by Node 26, on the Playwright library.

## API

```
GET /<dashboard path>?viewport=<width>x<height|auto>&zoom=&wait=&format=&theme=&dark=&lang=
Authorization: Basic <base64 of any-user:ENGINE_PASSWORD>
```

| Parameter | Default | Meaning |
| --- | --- | --- |
| `viewport` | `1280x800` | Image size in pixels, 64–4096 each. `auto` height captures the whole page, up to 4096. |
| `zoom` | `1` | CSS zoom of the page, 0.1–5. |
| `wait` | `2500` | Extra milliseconds to wait after Home Assistant reports the dashboard as loaded, 0–30000. |
| `format` | `png` | `png`, `jpeg` or `webp`. `bmp` returns 400. |
| `theme` | the user's default | Name of a Home Assistant theme. |
| `dark` | off | Present, `true` or `1` renders dark mode. |
| `lang` | the user's default | Language tag such as `de` or `pt-BR`. |

`GET /healthz` needs no password and returns 200 while Chromium runs.

Errors are plain text:

| Status | When |
| --- | --- |
| 400 | A parameter is invalid. |
| 401 | The password is missing or wrong. |
| 404 | Home Assistant has no page at that path. |
| 405 | The method is not `GET`. |
| 502 | Home Assistant cannot be reached, answers with an error, or sends the browser to its login page (the token is missing, invalid or revoked). |
| 504 | Home Assistant does not load in time, or the request waits and renders for more than 55 s. |
| 500 | Anything else; the first line of the error is in the body. |

## How a render works

Chromium starts once. Each request gets its own browser context with the requested viewport, colour
scheme and language, reduced motion, and with Home Assistant's frontend settings already in `localStorage`: the
access token (`hassTokens`), theme and dark mode (`selectedTheme`), language
(`selectedLanguage`) and a hidden sidebar. Nothing is saved to the Home Assistant user's profile,
and nothing carries over between requests. The page is rendered 56 px taller and the top app bar
is cropped off.

At most two renders run at once; further requests wait in order. A request that waits and renders
for more than 55 s gets a 504 (ha-mcp gives up after 60 s), and a render stops when its client
disconnects. On SIGTERM the server stops accepting connections, finishes the renders in progress
and exits, so give it a termination grace period of more than 60 s.

Home Assistant uses theme and language settings saved on the server over the ones the engine sets.
Do not change them while signed in as the user whose token the engine uses.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `HA_URL` | yes | Home Assistant origin, for example `http://homeassistant:8123`. |
| `HA_TOKEN` | yes | Long-lived access token of the (ideally non-admin) user whose view is rendered. |
| `ENGINE_PASSWORD` | yes | Basic-auth password for render requests. Use a URL-safe value such as `openssl rand -hex 32`, since ha-mcp sends it inside the engine URL. |
| `PORT` | no | Listening port, default `8080`. |

## Image

`tkislan/ha-screenshot:1.0.<workflow run number>` for `linux/amd64`, built from `node:26-slim` with
only Chromium's headless shell and its system packages, running as UID 1000 (`node`) under `tini`.
Every push to `main` publishes a tag; pull requests build and smoke-test the image without pushing
it. There is no `latest`.

The Chromium version comes from the `playwright` version in `package-lock.json`, so updating
Chromium means updating `playwright`.

Publishing needs the Actions secret `DOCKER_PASSWORD`, a Docker Hub access token for `tkislan` with
write access to `tkislan/ha-screenshot`.

## Development

```
npm ci
npx playwright install --with-deps --only-shell chromium
npm run typecheck
npm test
```

`test/render.test.ts` drives real Chromium against a stand-in for the Home Assistant frontend.
