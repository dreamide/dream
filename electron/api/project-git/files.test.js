import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import { hashContent, normalizePath, resolveProjectPath } from "./files.js";

const root = path.resolve(path.sep, "tmp", "dream-project");

test("resolves relative paths inside the project root", () => {
  assert.equal(
    resolveProjectPath(root, path.join("src", "index.js")),
    path.join(root, "src", "index.js"),
  );
});

test("resolves the project root itself", () => {
  assert.equal(resolveProjectPath(root, "."), root);
});

test("rejects parent directory traversal", () => {
  assert.throws(
    () => resolveProjectPath(root, path.join("..", "escape.txt")),
    /outside of the project root/,
  );
  assert.throws(
    () => resolveProjectPath(root, path.join("src", "..", "..", "escape.txt")),
    /outside of the project root/,
  );
});

test("rejects absolute paths outside the project root", () => {
  assert.throws(
    () => resolveProjectPath(root, path.resolve(path.sep, "etc", "passwd")),
    /outside of the project root/,
  );
});

test("rejects sibling directories sharing the root as a name prefix", () => {
  assert.throws(
    () => resolveProjectPath(root, path.join("..", "dream-project-evil", "x")),
    /outside of the project root/,
  );
});

test("accepts absolute paths that stay inside the project root", () => {
  const inside = path.join(root, "file.txt");
  assert.equal(resolveProjectPath(root, inside), inside);
});

test("treats percent-encoded traversal sequences as literal file names", () => {
  // The guard intentionally does not URL-decode, so "..%2F" is a plain name.
  assert.equal(
    resolveProjectPath(root, "..%2Fescape"),
    path.join(root, "..%2Fescape"),
  );
});

test("normalizes backslashes to forward slashes", () => {
  assert.equal(normalizePath("a\\b\\c"), "a/b/c");
  assert.equal(normalizePath("already/posix"), "already/posix");
});

test("hashes content with sha256 hex output", () => {
  assert.equal(
    hashContent("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  assert.match(hashContent("other"), /^[0-9a-f]{64}$/);
  assert.notEqual(hashContent("a"), hashContent("b"));
});
