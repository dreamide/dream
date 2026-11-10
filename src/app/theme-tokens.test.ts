import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { ACCENT_COLORS } from "@/lib/ui-store";

test("every configured accent defines default and hover theme tokens", () => {
  const globals = readFileSync(
    new URL("./globals.css", import.meta.url),
    "utf8",
  );
  const cssBlocks = globals.match(/[^{}]*\{[^{}]*\}/g) ?? [];

  for (const color of ACCENT_COLORS) {
    const selector = `[data-accent-color="${color}"]`;
    const accentBlocks = cssBlocks.filter((block) => block.includes(selector));

    assert.ok(
      accentBlocks.length >= 2,
      `${color} must define light and dark accent tokens`,
    );
    for (const block of accentBlocks) {
      assert.match(block, /--accent-primary:/, `${color} needs a base color`);
      assert.match(
        block,
        /--accent-primary-hover:/,
        `${color} needs a hover shade`,
      );
      assert.match(
        block,
        /--accent-primary-foreground:/,
        `${color} needs a foreground color`,
      );
    }
  }
});
