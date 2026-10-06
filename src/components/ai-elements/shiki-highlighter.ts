import { getSingletonHighlighter, type BundledLanguage } from "shiki";
import { CODE_THEMES } from "@/components/ai-elements/incremental-tokens";

export const getCodeHighlighter = (language: BundledLanguage) =>
  getSingletonHighlighter({
    langs: [language],
    themes: [CODE_THEMES.light, CODE_THEMES.dark],
  });
