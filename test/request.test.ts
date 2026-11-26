import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../src/http-error.ts";
import { parseRenderRequest } from "../src/request.ts";

const parse = (pathAndQuery: string) => parseRenderRequest(new URL(`http://engine${pathAndQuery}`));

function assertBadRequest(pathAndQuery: string, message: RegExp): void {
  assert.throws(
    () => parse(pathAndQuery),
    (error: unknown) => error instanceof HttpError && error.status === 400 && message.test(error.message),
  );
}

describe("parseRenderRequest", () => {
  it("reads the parameters ha-mcp sends", () => {
    assert.deepEqual(parse("/lovelace/0?viewport=390x844&zoom=1.5&wait=2500&format=png&theme=Midnight&dark=&lang=pt-BR"), {
      path: "lovelace/0",
      width: 390,
      height: 844,
      zoom: 1.5,
      waitMs: 2500,
      format: "png",
      theme: "Midnight",
      dark: true,
      language: "pt-BR",
    });
  });

  it("uses defaults when only the path is given", () => {
    assert.deepEqual(parse("/lovelace/0"), {
      path: "lovelace/0",
      width: 1280,
      height: 800,
      zoom: 1,
      waitMs: 2500,
      format: "png",
      theme: undefined,
      dark: false,
      language: undefined,
    });
  });

  it("accepts an auto height", () => {
    assert.equal(parse("/lovelace/0?viewport=1280xauto").height, "auto");
  });

  it("keeps the path percent-encoded and drops extra leading slashes", () => {
    assert.equal(parse("/dashboard-energy/my%20view").path, "dashboard-energy/my%20view");
    assert.equal(parse("//evil.example/x").path, "evil.example/x");
  });

  it("rejects a missing path", () => {
    assertBadRequest("/?viewport=1280x800", /Missing dashboard path/);
  });

  for (const viewport of ["1280", "1e3x800", "63x800", "4097x800", "1280x63", "1280x4097"]) {
    it(`rejects viewport ${viewport}`, () => assertBadRequest(`/lovelace/0?viewport=${viewport}`, /viewport/));
  }

  it("accepts values on the bounds", () => {
    const { width, height, zoom, waitMs } = parse("/a?viewport=64x4096&zoom=5&wait=0");
    assert.deepEqual({ width, height, zoom, waitMs }, { width: 64, height: 4096, zoom: 5, waitMs: 0 });
  });

  for (const zoom of ["0.05", "5.5", "abc"]) {
    it(`rejects zoom ${zoom}`, () => assertBadRequest(`/a?zoom=${zoom}`, /zoom/));
  }

  for (const wait of ["1.5", "-1", "30001"]) {
    it(`rejects wait ${wait}`, () => assertBadRequest(`/a?wait=${wait}`, /wait/));
  }

  it("accepts jpeg and webp and rejects bmp, which Playwright cannot produce", () => {
    assert.equal(parse("/a?format=jpeg").format, "jpeg");
    assert.equal(parse("/a?format=webp").format, "webp");
    assertBadRequest("/a?format=bmp", /use png, jpeg or webp/);
  });

  it("reads dark the way ha-mcp and people send it", () => {
    assert.equal(parse("/a?dark=1").dark, true);
    assert.equal(parse("/a?dark=true").dark, true);
    assert.equal(parse("/a?dark=false").dark, false);
    assert.equal(parse("/a?dark=0").dark, false);
    assertBadRequest("/a?dark=yes", /dark/);
  });

  it("accepts language tags and rejects anything else", () => {
    assert.equal(parse("/a?lang=zh-Hans").language, "zh-Hans");
    assert.equal(parse("/a?lang=").language, undefined);
    assertBadRequest("/a?lang=en_US", /lang/);
    assertBadRequest("/a?lang=x", /lang/);
  });

  it("treats an empty theme as no theme", () => {
    assert.equal(parse("/a?theme=").theme, undefined);
  });
});
