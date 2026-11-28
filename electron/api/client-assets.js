// The browser client's files, served by the remote listener (remote-app.js)
// from one directory: the renderer build (`dist/`, or `client/` in a host
// runtime). Only that directory's regular files are served, never another
// path on the host: no `..`, no dotfiles, no symlink that leads out of it,
// and nothing under /api.
//
//   /assets/*      content-hashed: cached for a year, immutable
//   anything else  revalidated every load (index.html, icons), so a host
//                  upgrade reaches the browser on its next load and the
//                  client always matches the host protocol it is served by
//   a page path    (/, /pair, ...) with no file: index.html
//
// No service worker is registered and no API response is cached (the
// listener marks /api responses no-store).
//
// index.html is sent with a Content Security Policy: scripts only from this
// origin plus the page's own inline boot script (by hash), no framing, no
// plugins. A session cookie is as good as a shell on the host, so script
// injection is closed off rather than merely unlikely.
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".wasm",
]);

const MIN_COMPRESS_BYTES = 1024;
const MAX_COMPRESSED_CACHE_ENTRIES = 64;
const MAX_COMPRESSED_CACHE_BYTES = 16 * 1024 * 1024;

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

/** The page's inline scripts, by hash, for its CSP. */
const inlineScriptHashes = (html) =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    ([, body]) =>
      `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`,
  );

/** The Content Security Policy for `html`. */
export const clientContentSecurityPolicy = (html) =>
  [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes(html).join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

const makeEtag = (fileStat) =>
  `W/"${fileStat.size.toString(16)}-${Math.trunc(fileStat.mtimeMs).toString(16)}"`;

const etagMatches = (ifNoneMatch, etag) => {
  if (!ifNoneMatch) return false;
  const normalizedTarget = etag.replace(/^W\//, "");
  return ifNoneMatch.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || trimmed.replace(/^W\//, "") === normalizedTarget;
  });
};

const selectEncoding = (acceptEncoding) => {
  if (!acceptEncoding) return null;
  const normalized = acceptEncoding.toLowerCase();
  if (/\bbr\b/.test(normalized)) return "br";
  if (/\bgzip\b/.test(normalized)) return "gzip";
  return null;
};

const compressBuffer = (body, encoding) => {
  if (encoding === "br") {
    return brotliAsync(body, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
    });
  }
  return gzipAsync(body, { level: 6 });
};

/**
 * The file under `root` that `requestPath` names, plus its stat, or null.
 * Refuses anything that would leave `root` or name a hidden file.
 */
const resolveClientFile = async (root, requestPath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) return null;
  const candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  try {
    // Through any symlink, still inside the directory, and a plain file.
    const real = await realpath(candidate);
    if (!real.startsWith(`${root}${path.sep}`)) return null;
    const fileStat = await stat(real);
    return fileStat.isFile() ? { file: real, fileStat } : null;
  } catch {
    return null;
  }
};

/**
 * Serves the client from `directory`. Returns a Hono handler for requests
 * no route answered (the listener's not-found handler), or null when there
 * is no client to serve.
 * @param {string | null | undefined} directory
 */
export const createClientAssets = async (directory) => {
  if (!directory) return null;
  let root;
  try {
    root = await realpath(path.resolve(directory));
    if (!(await stat(path.join(root, "index.html"))).isFile()) return null;
  } catch {
    return null;
  }

  const assetsPrefix = `${path.join(root, "assets")}${path.sep}`;
  const indexPath = path.join(root, "index.html");

  /** @type {Map<string, { csp: string, etag: string }>} */
  const htmlCspCache = new Map();

  /** @type {Map<string, Buffer>} */
  const compressedCache = new Map();
  let compressedCacheBytes = 0;

  const getCachedCompressed = (key) => {
    const cached = compressedCache.get(key);
    if (!cached) return null;
    compressedCache.delete(key);
    compressedCache.set(key, cached);
    return cached;
  };

  const setCachedCompressed = (key, value) => {
    if (value.byteLength > MAX_COMPRESSED_CACHE_BYTES / 2) return;
    const existing = compressedCache.get(key);
    if (existing) {
      compressedCacheBytes -= existing.byteLength;
      compressedCache.delete(key);
    }
    compressedCache.set(key, value);
    compressedCacheBytes += value.byteLength;
    for (const oldestKey of compressedCache.keys()) {
      if (
        compressedCache.size <= MAX_COMPRESSED_CACHE_ENTRIES &&
        compressedCacheBytes <= MAX_COMPRESSED_CACHE_BYTES
      ) {
        break;
      }
      const evicted = compressedCache.get(oldestKey);
      if (evicted && compressedCache.delete(oldestKey)) {
        compressedCacheBytes -= evicted.byteLength;
      }
    }
  };

  /** @param {import("hono").Context} c */
  return async (c) => {
    const { method } = c.req;
    const requestPath = c.req.path;
    if (
      (method !== "GET" && method !== "HEAD") ||
      requestPath === "/api" ||
      requestPath.startsWith("/api/")
    ) {
      return c.text("Not found.", 404);
    }

    let resolved = await resolveClientFile(root, requestPath);
    if (!resolved) {
      // A page of the app (no extension): the app itself. A missing file
      // with an extension is missing, not the app.
      if (path.posix.extname(requestPath)) return c.text("Not found.", 404);
      try {
        const fileStat = await stat(indexPath);
        if (!fileStat.isFile()) return c.text("Not found.", 404);
        resolved = { file: indexPath, fileStat };
      } catch {
        return c.text("Not found.", 404);
      }
    }

    const { file, fileStat } = resolved;
    const extension = path.extname(file).toLowerCase();
    const isImmutableAsset = file.startsWith(assetsPrefix);
    const etag = makeEtag(fileStat);
    const compressible =
      COMPRESSIBLE_EXTENSIONS.has(extension) &&
      fileStat.size >= MIN_COMPRESS_BYTES;
    const encoding = compressible
      ? selectEncoding(c.req.header("accept-encoding"))
      : null;

    const headers = {
      "Cache-Control": isImmutableAsset ? IMMUTABLE : REVALIDATE,
      "Content-Type": TYPES[extension] ?? "application/octet-stream",
      ETag: etag,
      "X-Frame-Options": "DENY",
    };
    if (compressible) {
      headers.Vary = "Accept-Encoding";
    }

    if (etagMatches(c.req.header("if-none-match"), etag)) {
      if (extension === ".html") {
        const cached = htmlCspCache.get(file);
        if (cached && cached.etag === etag) {
          headers["Content-Security-Policy"] = cached.csp;
        }
      }
      return c.body(null, 304, headers);
    }

    let body = null;
    const cacheKey =
      isImmutableAsset && encoding ? `${file}:${etag}:${encoding}` : null;

    if (cacheKey) {
      const cached = getCachedCompressed(cacheKey);
      if (cached) {
        body = cached;
        headers["Content-Encoding"] = encoding;
      }
    }

    if (!body) {
      const raw = await readFile(file);
      if (extension === ".html") {
        let cached = htmlCspCache.get(file);
        if (!cached || cached.etag !== etag) {
          cached = {
            csp: clientContentSecurityPolicy(raw.toString("utf8")),
            etag,
          };
          htmlCspCache.set(file, cached);
        }
        headers["Content-Security-Policy"] = cached.csp;
      }

      if (encoding) {
        const compressed = await compressBuffer(raw, encoding);
        if (compressed.byteLength < raw.byteLength) {
          body = compressed;
          headers["Content-Encoding"] = encoding;
          if (cacheKey) {
            setCachedCompressed(cacheKey, compressed);
          }
        } else {
          body = raw;
        }
      } else {
        body = raw;
      }
    }

    return c.body(method === "HEAD" ? null : body, 200, headers);
  };
};
