import { HttpError } from "./http-error.ts";

export type ImageFormat = "png" | "jpeg" | "webp";

export interface RenderRequest {
  /** Home Assistant route without its leading slash, still percent-encoded, e.g. `lovelace/0`. */
  path: string;
  width: number;
  height: number | "auto";
  zoom: number;
  waitMs: number;
  format: ImageFormat;
  theme: string | undefined;
  dark: boolean;
  language: string | undefined;
}

export const MIN_DIMENSION = 64;
export const MAX_DIMENSION = 4096;
const DEFAULT_VIEWPORT = "1280x800";
const DEFAULT_WAIT_MS = 2500;
const MAX_WAIT_MS = 30_000;
const VIEWPORT = /^(\d+)x(\d+|auto)$/;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Reads a render request in the form ha-mcp sends it:
 * `/<dashboard path>?viewport=<W>x<H|auto>&zoom=&wait=&format=&theme=&dark=&lang=`.
 * Throws an HttpError with status 400 when a parameter is invalid.
 */
export function parseRenderRequest(url: URL): RenderRequest {
  const path = url.pathname.replace(/^\/+/, "");
  if (path === "") {
    throw new HttpError(400, "Missing dashboard path, for example /lovelace/0");
  }
  const query = url.searchParams;
  const { width, height } = parseViewport(query.get("viewport") ?? DEFAULT_VIEWPORT);
  return {
    path,
    width,
    height,
    zoom: parseNumber(query.get("zoom"), "zoom", 1, 0.1, 5),
    waitMs: parseNumber(query.get("wait"), "wait", DEFAULT_WAIT_MS, 0, MAX_WAIT_MS, true),
    format: parseFormat(query.get("format")),
    theme: query.get("theme") || undefined,
    dark: parseDark(query.get("dark")),
    language: parseLanguage(query.get("lang")),
  };
}

function parseViewport(value: string): { width: number; height: number | "auto" } {
  const match = VIEWPORT.exec(value);
  if (!match) {
    throw new HttpError(400, `viewport must be <width>x<height> or <width>xauto, got "${value}"`);
  }
  const width = checkDimension(Number(match[1]), "width");
  const height = match[2] === "auto" ? "auto" : checkDimension(Number(match[2]), "height");
  return { width, height };
}

function checkDimension(value: number, name: string): number {
  if (value < MIN_DIMENSION || value > MAX_DIMENSION) {
    throw new HttpError(400, `viewport ${name} must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}`);
  }
  return value;
}

function parseNumber(
  value: string | null,
  name: string,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  if (value === null || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
    const kind = integer ? "an integer" : "a number";
    throw new HttpError(400, `${name} must be ${kind} between ${min} and ${max}, got "${value}"`);
  }
  return number;
}

function parseFormat(value: string | null): ImageFormat {
  if (value === null || value === "" || value === "png") {
    return "png";
  }
  if (value === "jpeg" || value === "webp") {
    return value;
  }
  throw new HttpError(400, `format ${value} is not supported; use png, jpeg or webp`);
}

function parseDark(value: string | null): boolean {
  if (value === null || value === "0" || value === "false") {
    return false;
  }
  if (value === "" || value === "1" || value === "true") {
    return true;
  }
  throw new HttpError(400, `dark must be empty, true or false, got "${value}"`);
}

function parseLanguage(value: string | null): string | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  if (!LANGUAGE.test(value)) {
    throw new HttpError(400, `lang must be a language tag such as en or pt-BR, got "${value}"`);
  }
  return value;
}
