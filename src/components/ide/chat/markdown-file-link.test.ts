import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getExternalFilePathFromHref,
  getProjectFilePathFromHref,
  normalizeProjectFileLinksInMarkdown,
} from "./markdown-file-link";

const BACKSLASH = String.fromCharCode(92);
const winPath = (...segments: string[]) => segments.join(BACKSLASH);

const WIN_PROJECT_LOWER = winPath("e:", "dev", "umami");
const WIN_PROJECT_UPPER = winPath("E:", "dev", "umami");
const WIN_HREF_LOWER = winPath(
  "e:",
  "dev",
  "umami",
  "src",
  "app",
  "global.css",
);

test("resolves absolute project file hrefs regardless of drive letter case", () => {
  assert.equal(
    getProjectFilePathFromHref(
      "E:/dev/umami/src/app/global.css:1",
      "e:/dev/umami",
    ),
    "src/app/global.css",
  );
  assert.equal(
    getProjectFilePathFromHref(WIN_HREF_LOWER, WIN_PROJECT_UPPER),
    "src/app/global.css",
  );
  assert.equal(
    getProjectFilePathFromHref(
      "file:///E:/dev/umami/src/app/(main)/TopNav.tsx:49",
      WIN_PROJECT_LOWER,
    ),
    "src/app/(main)/TopNav.tsx",
  );
});

test("does not resolve hrefs outside the project root", () => {
  assert.equal(
    getProjectFilePathFromHref("E:/dev/dream/package.json", "e:/dev/umami"),
    null,
  );
  assert.equal(
    getProjectFilePathFromHref("E:/dev/umami-shiso/global.css", "e:/dev/umami"),
    null,
  );
  assert.equal(
    getProjectFilePathFromHref(
      "https://example.com/global.css",
      "e:/dev/umami",
    ),
    null,
  );
});

test("rewrites absolute project file links to the safe project-file prefix", () => {
  assert.equal(
    normalizeProjectFileLinksInMarkdown(
      "styling in [global.css](E:/dev/umami/src/app/global.css:1). The navbar fix remains in [TopNav.tsx](E:/dev/umami/src/app/(main)/TopNav.tsx:49).",
      WIN_PROJECT_LOWER,
    ),
    "styling in [global.css](</__dream_project_file__/src/app/global.css:1>). The navbar fix remains in [TopNav.tsx](</__dream_project_file__/src/app/(main)/TopNav.tsx:49>).",
  );
});

test("resolves absolute paths outside the project as external files", () => {
  assert.equal(
    getExternalFilePathFromHref("E:/dev/dream/package.json:12", "e:/dev/umami"),
    "E:/dev/dream/package.json",
  );
  assert.equal(
    getExternalFilePathFromHref(
      "file:///E:/dev/dream/package.json",
      "e:/dev/umami",
    ),
    "E:/dev/dream/package.json",
  );
  assert.equal(
    getExternalFilePathFromHref(
      "/__dream_external_file__/E:/dev/dream/package.json:12",
      "e:/dev/umami",
    ),
    "E:/dev/dream/package.json",
  );
  assert.equal(
    getExternalFilePathFromHref("/Users/mike/notes.md", "/Users/mike/umami"),
    "/Users/mike/notes.md",
  );
  assert.equal(
    getExternalFilePathFromHref(
      "/__dream_external_file__/Users/mike/notes.md",
      "/Users/mike/umami",
    ),
    "/Users/mike/notes.md",
  );
});

test("does not treat project files, relative paths, or URLs as external", () => {
  assert.equal(
    getExternalFilePathFromHref(
      "E:/dev/umami/src/app/global.css",
      "e:/dev/umami",
    ),
    null,
  );
  assert.equal(
    getExternalFilePathFromHref("src/app/global.css", "e:/dev/umami"),
    null,
  );
  assert.equal(
    getExternalFilePathFromHref("/src/app/global.css", "e:/dev/umami"),
    null,
  );
  assert.equal(
    getExternalFilePathFromHref(
      "https://example.com/global.css",
      "e:/dev/umami",
    ),
    null,
  );
});

test("rewrites out-of-project absolute links to the external-file prefix", () => {
  assert.equal(
    normalizeProjectFileLinksInMarkdown(
      "see [package.json](E:/dev/dream/package.json:12) and [notes](/Users/mike/notes.md)",
      "e:/dev/umami",
    ),
    "see [package.json](</__dream_external_file__/E:/dev/dream/package.json:12>) and [notes](/Users/mike/notes.md)",
  );
  assert.equal(
    normalizeProjectFileLinksInMarkdown(
      "see [notes](/Users/mike/notes.md)",
      "/Users/mike/umami",
    ),
    "see [notes](</__dream_external_file__/Users/mike/notes.md>)",
  );
});
