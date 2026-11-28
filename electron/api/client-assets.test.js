import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createClientAssets } from "./client-assets.js";

const tempDirs = [];

const makeClientDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dream-client-assets-"));
  tempDirs.push(dir);
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(
    path.join(dir, "index.html"),
    `<!doctype html><html><head><script>window.__boot = 1;</script></head><body>${"hello ".repeat(300)}</body></html>`,
  );
  await writeFile(
    path.join(dir, "assets", "app-abc123.js"),
    `export const value = ${JSON.stringify("repeated payload ".repeat(200))};\n`,
  );
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { force: true, recursive: true });
    }
  }
});

describe("createClientAssets", () => {
  it("serves index.html with CSP, ETag, and 304 on revalidation", async () => {
    const dir = await makeClientDir();
    const handler = await createClientAssets(dir);
    expect(handler).toBeTypeOf("function");

    const app = new Hono();
    app.notFound(handler);

    const first = await app.request("/workspace");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/html");
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const csp = first.headers.get("content-security-policy");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-");

    const revalidated = await app.request("/workspace", {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("content-security-policy")).toBe(csp);
  });

  it("compresses immutable /assets/* with brotli or gzip when accepted", async () => {
    const dir = await makeClientDir();
    const handler = await createClientAssets(dir);
    const app = new Hono();
    app.notFound(handler);

    const brResponse = await app.request("/assets/app-abc123.js", {
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    expect(brResponse.status).toBe(200);
    expect(brResponse.headers.get("content-encoding")).toBe("br");
    expect(brResponse.headers.get("cache-control")).toContain("immutable");
    expect(brResponse.headers.get("vary")).toBe("Accept-Encoding");
    const brBody = Buffer.from(await brResponse.arrayBuffer());
    expect(brotliDecompressSync(brBody).toString("utf8")).toContain(
      "repeated payload",
    );

    const gzResponse = await app.request("/assets/app-abc123.js", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(gzResponse.status).toBe(200);
    expect(gzResponse.headers.get("content-encoding")).toBe("gzip");
    const gzBody = Buffer.from(await gzResponse.arrayBuffer());
    expect(gunzipSync(gzBody).toString("utf8")).toContain("repeated payload");
  });

  it("rejects /api paths, missing asset extensions, and traversal attempts", async () => {
    const dir = await makeClientDir();
    const handler = await createClientAssets(dir);
    const app = new Hono();
    app.notFound(handler);

    expect((await app.request("/api/state")).status).toBe(404);
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect((await app.request("/../secret.txt")).status).toBe(404);
  });
});
