import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buttonVariants } from "@/components/ui/button";
import { ACCENT_COLORS } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import {
  DOWNLOADED_UPDATE_BUTTON_FOREGROUND,
  UPDATE_BUTTON_VARIANT_BY_STATE,
} from "./update-button-styles";

test("downloaded updates keep accent colors in every theme", () => {
  assert.equal(UPDATE_BUTTON_VARIANT_BY_STATE.downloaded, "accent");

  const classes = cn(
    buttonVariants({
      className: DOWNLOADED_UPDATE_BUTTON_FOREGROUND,
      variant: "accent",
    }),
  );
  assert.match(classes, /(?:^|\s)bg-primary(?:\s|$)/);
  assert.match(classes, /(?:^|\s)hover:bg-primary-hover(?:\s|$)/);
  assert.match(classes, /(?:^|\s)text-white(?:\s|$)/);
  assert.match(classes, /(?:^|\s)hover:text-white(?:\s|$)/);
  assert.doesNotMatch(classes, /(?:^|\s)text-primary-foreground(?:\s|$)/);
  assert.doesNotMatch(classes, /dark:hover:bg-surface-/);
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
