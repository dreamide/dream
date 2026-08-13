import { getSingletonHighlighter, type BundledLanguage } from "shiki";

export const getCodeHighlighter = (language: BundledLanguage) =>
  getSingletonHighlighter({
    langs: [language],
    themes: ["github-light", "github-dark"],
  });
