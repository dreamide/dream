import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, test } from "vitest";
import { registerProjectGitRoutes } from "../project-git-routes.js";
import {
  buildLinePreview,
  buildSearchPattern,
  findLineMatches,
  SEARCH_PREVIEW_MAX_CHARS,
  searchText,
} from "./search.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

const createProject = async (files) => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "dream-search-"));
  temporaryDirectories.push(projectPath);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(projectPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }
  return projectPath;
};

const search = async (projectPath, request) => {
  const app = new Hono();
  registerProjectGitRoutes(app);
  return app.request("/api/project-search", {
    body: JSON.stringify({ projectPath, ...request }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
};

const searchPaths = async (projectPath, request) => {
  const response = await search(projectPath, request);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  return body.files.map((file) => file.path);
};

test("a literal query matches its text, not as a pattern", () => {
  const pattern = buildSearchPattern({ query: "a.b(" });
  assert.deepEqual(findLineMatches("a.b( axb(", pattern), [[0, 4]]);
});

test("case-insensitive by default, case-sensitive on request", () => {
  assert.equal(
    findLineMatches("Foo foo", buildSearchPattern({ query: "foo" })).length,
    2,
  );
  assert.deepEqual(
    findLineMatches(
      "Foo foo",
      buildSearchPattern({ caseSensitive: true, query: "foo" }),
    ),
    [[4, 7]],
  );
});

test("whole word skips matches inside other words", () => {
  const pattern = buildSearchPattern({ query: "id", wholeWord: true });
  assert.deepEqual(findLineMatches("id hidden id_x (id)", pattern), [
    [0, 2],
    [16, 18],
  ]);
});

test("a regular expression that can match empty never loops", () => {
  const pattern = buildSearchPattern({ query: "x*", regexp: true });
  assert.deepEqual(findLineMatches("axxb", pattern), [[1, 3]]);
  assert.deepEqual(findLineMatches("", pattern), []);
});

test("an invalid regular expression is refused", () => {
  assert.throws(() => buildSearchPattern({ query: "(", regexp: true }), {
    httpStatus: 400,
  });
});

test("line anchors apply to each line", () => {
  const lines = searchText(
    "foo\n  foo\r\nfoo bar",
    buildSearchPattern({ query: "^foo", regexp: true }),
  );
  assert.deepEqual(
    lines.map((line) => line.line),
    [1, 3],
  );
});

test("the preview drops indentation and keeps ranges aligned", () => {
  const preview = buildLinePreview("\t  const id = 1;", [[9, 11]]);
  assert.equal(preview.preview, "const id = 1;");
  const [[start, end]] = preview.ranges;
  assert.equal(preview.preview.slice(start, end), "id");
});

test("a long line is cut around the first match", () => {
  const line = `${"a".repeat(500)}needle${"b".repeat(500)}`;
  const preview = buildLinePreview(line, [[500, 506]]);
  assert.ok(preview.preview.startsWith("…"));
  assert.ok(preview.preview.endsWith("…"));
  assert.ok(preview.preview.length <= SEARCH_PREVIEW_MAX_CHARS + 2);
  const [[start, end]] = preview.ranges;
  assert.equal(preview.preview.slice(start, end), "needle");
});

test("search reports each matching line with its position", async () => {
  const projectPath = await createProject({
    "src/a.ts": "const value = 1;\nreturn value + value;\n",
  });
  const response = await search(projectPath, { query: "value" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.matchCount, 3);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.files[0].path, "src/a.ts");
  assert.deepEqual(
    body.files[0].lines.map(({ column, length, line, matchCount }) => ({
      column,
      length,
      line,
      matchCount,
    })),
    [
      { column: 6, length: 5, line: 1, matchCount: 1 },
      { column: 7, length: 5, line: 2, matchCount: 2 },
    ],
  );
});

test("search skips ignored, blocked, binary and oversized files", async () => {
  const projectPath = await createProject({
    ".gitignore": "*.log\n",
    "app.log": "needle",
    "keep.txt": "needle",
    "node_modules/pkg/index.js": "needle",
    "packages/web/.gitignore": "generated/\n",
    "packages/web/generated/out.js": "needle",
    "packages/web/src/page.ts": "needle",
    "image.bin": Buffer.from([0, 110, 101, 101, 100, 108, 101]),
    "huge.txt": `needle${"x".repeat(1024 * 1024)}`,
  });
  assert.deepEqual(await searchPaths(projectPath, { query: "needle" }), [
    "keep.txt",
    "packages/web/src/page.ts",
  ]);
});

test("include and exclude narrow the files searched", async () => {
  const projectPath = await createProject({
    "docs/guide.md": "needle",
    "src/a.ts": "needle",
    "src/a.test.ts": "needle",
    "src/b.js": "needle",
  });
  assert.deepEqual(
    await searchPaths(projectPath, { include: "src", query: "needle" }),
    ["src/a.test.ts", "src/a.ts", "src/b.js"],
  );
  assert.deepEqual(
    await searchPaths(projectPath, {
      exclude: "*.test.ts, docs",
      query: "needle",
    }),
    ["src/a.ts", "src/b.js"],
  );
});

test("search stops at the result limit", async () => {
  const projectPath = await createProject({
    "a.txt": "x\nx\nx\n",
    "b.txt": "x\n",
  });
  const response = await search(projectPath, { maxResults: 2, query: "x" });
  const body = await response.json();
  assert.equal(body.matchCount, 2);
  assert.equal(body.truncated, true);
  assert.deepEqual(
    body.files.map((file) => file.path),
    ["a.txt"],
  );
});

test("an invalid regular expression answers 400 with the reason", async () => {
  const projectPath = await createProject({ "a.txt": "x" });
  const response = await search(projectPath, { query: "(", regexp: true });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /regular expression/i);
});
