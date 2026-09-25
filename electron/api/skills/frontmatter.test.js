import assert from "node:assert/strict";
import { test } from "vitest";
import { parseFrontMatter, summarizeMarkdownBody } from "./frontmatter.js";

test("parses scalar, quoted, boolean and nested front matter", () => {
  const { attributes, body } = parseFrontMatter(
    [
      "---",
      "name: deploy",
      'description: "Deploy the app: safely"',
      "disable-model-invocation: true",
      "user-invocable: false",
      "allowed-tools: Bash(git:*) Read",
      "metadata:",
      "  opencode/autoinvoke: false",
      "  author: dream",
      "---",
      "# Deploy",
      "",
      "Run the deploy.",
    ].join("\n"),
  );
  assert.equal(attributes.name, "deploy");
  assert.equal(attributes.description, "Deploy the app: safely");
  assert.equal(attributes["disable-model-invocation"], true);
  assert.equal(attributes["user-invocable"], false);
  assert.equal(attributes["allowed-tools"], "Bash(git:*) Read");
  assert.deepEqual(attributes.metadata, {
    author: "dream",
    "opencode/autoinvoke": false,
  });
  assert.equal(body.trim(), "# Deploy\n\nRun the deploy.");
});

test("parses folded and literal block scalars", () => {
  const { attributes } = parseFrontMatter(
    [
      "---",
      "description: >",
      "  Use when the user asks",
      "  about releases.",
      "",
      "  Second paragraph.",
      "notes: |",
      "  line one",
      "  line two",
      "name: release",
      "---",
      "body",
    ].join("\n"),
  );
  assert.equal(
    attributes.description,
    "Use when the user asks about releases.\nSecond paragraph.",
  );
  assert.equal(attributes.notes, "line one\nline two");
  assert.equal(attributes.name, "release");
});

test("returns the whole text as body without front matter", () => {
  const { attributes, body } = parseFrontMatter("Just markdown\n");
  assert.deepEqual(attributes, {});
  assert.equal(body, "Just markdown\n");
});

test("handles CRLF and BOM", () => {
  const { attributes } = parseFrontMatter(
    "﻿---\r\nname: crlf\r\ndescription: Works on Windows\r\n---\r\nbody",
  );
  assert.equal(attributes.name, "crlf");
  assert.equal(attributes.description, "Works on Windows");
});

test("summarizes the first meaningful markdown line", () => {
  assert.equal(
    summarizeMarkdownBody("\n\n# Title here\n\nMore text"),
    "Title here",
  );
  assert.equal(summarizeMarkdownBody("- first bullet\n"), "first bullet");
  assert.equal(summarizeMarkdownBody(""), "");
});
