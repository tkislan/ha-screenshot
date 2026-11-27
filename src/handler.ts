import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./http-error.ts";
import { createLimiter } from "./limiter.ts";
import { parseRenderRequest, type ImageFormat, type RenderRequest } from "./request.ts";

export interface HandlerOptions {
  /** Basic-auth password every render request must carry; the user name is ignored. */
  password: string;
  render: (request: RenderRequest, signal: AbortSignal) => Promise<Buffer>;
  /** Answers `GET /healthz`, the only route that needs no password. */
  isHealthy: () => boolean;
  maxConcurrentRenders: number;
  /** Time a request may spend waiting for a slot and rendering before it gets a 504. */
  deadlineMs: number;
}

const CONTENT_TYPES: Record<ImageFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

export function createHandler(options: HandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limiter = createLimiter(options.maxConcurrentRenders);
  const expectedPassword = digest(options.password);

  return async (req, res) => {
    const started = Date.now();
    const target = req.url ?? "/";
    const pathname = target.split("?", 1)[0];
    const deadline = AbortSignal.timeout(options.deadlineMs);
    const disconnected = abortOnDisconnect(res);
    try {
      if (pathname === "/healthz") {
        const healthy = options.isHealthy();
        return healthy ? sendText(res, 200, "ok") : sendText(res, 503, "Chromium is not running");
      }
      if (req.method !== "GET") {
        throw new HttpError(405, "Only GET is supported");
      }
      const password = passwordFrom(req.headers.authorization);
      if (password === undefined || !timingSafeEqual(digest(password), expectedPassword)) {
        res.setHeader("WWW-Authenticate", 'Basic realm="ha-screenshot"');
        throw new HttpError(401, "Missing or wrong password");
      }
      // Prefixing the origin keeps a path such as //host/x a path instead of a host.
      const request = parseRenderRequest(new URL(`http://engine${target.startsWith("/") ? "" : "/"}${target}`));
      const signal = AbortSignal.any([deadline, disconnected]);
      const image = await limiter.run(() => options.render(request, signal), signal);
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[request.format],
        "Content-Length": image.length,
        "Cache-Control": "no-store",
      });
      res.end(image);
    } catch (error) {
      if (disconnected.aborted) {
        return;
      }
      if (error instanceof HttpError) {
        sendText(res, error.status, error.message);
      } else if (deadline.aborted) {
        sendText(res, 504, `Rendering took longer than ${options.deadlineMs / 1000} s`);
      } else {
        console.error(error);
        sendText(res, 500, `Rendering failed: ${firstLine(error)}`);
      }
    } finally {
      if (pathname !== "/healthz") {
        console.log(`${req.method} ${pathname} ${disconnected.aborted ? "disconnected" : res.statusCode} ${Date.now() - started}ms`);
      }
    }
  };
}

function passwordFrom(header: string | undefined): string | undefined {
  const encoded = /^Basic (\S+)$/i.exec(header ?? "")?.[1];
  if (encoded === undefined) {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? undefined : decoded.slice(colon + 1);
}

// Hashing first gives timingSafeEqual two buffers of equal length whatever the input.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function abortOnDisconnect(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) {
      controller.abort(new Error("Client disconnected"));
    }
  });
  return controller.signal;
}

function sendText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(message);
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n", 1)[0] ?? "";
}
