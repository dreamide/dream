import { NextIntlClientProvider } from "next-intl";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en.json";
import { PROVIDER_IDS } from "../../../electron/shared/provider-capabilities.js";
import { PROVIDER_PRESENTATION } from "./provider-presentation";
import { SkillsSettingsSection } from "./skills/skills-settings-section";

describe("provider presentation", () => {
  it("has a row for every Provider and no other", () => {
    expect(Object.keys(PROVIDER_PRESENTATION).sort()).toEqual(
      [...PROVIDER_IDS].sort(),
    );
  });

  it.each(PROVIDER_IDS)("names %s and its CLI", (provider) => {
    const { label, runtimeLabel } = PROVIDER_PRESENTATION[provider];
    expect(label.trim()).not.toBe("");
    expect(runtimeLabel.trim()).not.toBe("");
  });

  it("gives every Provider its own labels", () => {
    const rows = Object.values(PROVIDER_PRESENTATION);
    expect(new Set(rows.map((row) => row.label)).size).toBe(rows.length);
    expect(new Set(rows.map((row) => row.runtimeLabel)).size).toBe(rows.length);
  });

  it("labels each Skills tab with its Provider's CLI", () => {
    const markup = renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        // The children are createElement's third argument.
        { locale: "en", messages: en, timeZone: "UTC" } as ComponentProps<
          typeof NextIntlClientProvider
        >,
        createElement(SkillsSettingsSection),
      ),
    );
    const tabs = [
      ...markup.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g),
    ].map((match) => match[1].replace(/<[^>]+>/g, "").trim());
    const runtimeLabels = Object.values(PROVIDER_PRESENTATION).map(
      (row) => row.runtimeLabel,
    );

    expect(tabs.length).toBeGreaterThan(0);
    expect(new Set(tabs).size).toBe(tabs.length);
    for (const tab of tabs) {
      expect(runtimeLabels).toContain(tab);
    }
  });
});
