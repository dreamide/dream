import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import { mergeCliPathEntries } from "./cli.js";

const asPath = (...entries) => entries.join(path.delimiter);

test("prioritizes login-shell PATH entries over the current environment", () => {
  assert.deepEqual(
    mergeCliPathEntries(
      asPath("/shell/bin", "/shared/bin"),
      asPath("/current/bin", "/shared/bin"),
      ["/fallback/bin", "/current/bin"],
    ),
    ["/shell/bin", "/shared/bin", "/current/bin", "/fallback/bin"],
  );
});

test("falls back to the current PATH when the login-shell PATH is empty", () => {
  assert.deepEqual(
    mergeCliPathEntries("", asPath("/current/bin", "/shared/bin"), [
      "/fallback/bin",
      "/shared/bin",
    ]),
    ["/current/bin", "/shared/bin", "/fallback/bin"],
  );
});
