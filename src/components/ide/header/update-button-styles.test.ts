import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { buttonVariants } from "@/components/ui/button";
import { ACCENT_COLORS } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import { UPDATE_BUTTON_VARIANT_BY_STATE } from "./update-button-styles";

test("downloaded updates use the black/white treatment in every theme", () => {
  assert.equal(UPDATE_BUTTON_VARIANT_BY_STATE.downloaded, "default");

  const classes = cn(buttonVariants({ variant: "default" }));
  assert.match(classes, /(?:^|\s)bg-surface-900(?:\s|$)/);
  assert.match(classes, /(?:^|\s)text-surface-50(?:\s|$)/);
  assert.match(classes, /(?:^|\s)dark:bg-surface-200(?:\s|$)/);
  assert.match(classes, /(?:^|\s)dark:text-surface-900(?:\s|$)/);
  assert.doesNotMatch(classes, /(?:^|\s)bg-primary(?:\s|$)/);
});

test("update failures use the destructive button treatment", () => {
  assert.equal(UPDATE_BUTTON_VARIANT_BY_STATE.error, "destructive");
});

test("every configured accent defines default and hover theme tokens", () => {
  const globals = readFileSync(
    new URL("../../../app/globals.css", import.meta.url),
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
