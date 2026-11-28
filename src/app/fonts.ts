import type { AppLocale } from "@/i18n/config";

const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=JetBrains+Mono:wght@100..800&display=swap";
const GOOGLE_FONTS_LINK_ID = "dream-google-fonts";

const CJK_FONT_LOADERS: Partial<Record<AppLocale, () => Promise<unknown>>> = {
  ja: () => import("@fontsource-variable/noto-sans-jp"),
  ko: () => import("@fontsource-variable/noto-sans-kr"),
  "zh-Hans": () => import("@fontsource-variable/noto-sans-sc"),
  "zh-Hant": () => import("@fontsource-variable/noto-sans-tc"),
};

const loadedCjkLocales = new Set<AppLocale>();
let webFontsRequested = false;

/**
 * Loads Inter and JetBrains Mono asynchronously after startup so offline
 * launches paint immediately with system fallbacks instead of blocking HTML
 * parsing on a remote stylesheet.
 */
export const loadWebFonts = () => {
  if (webFontsRequested || typeof document === "undefined") {
    return;
  }
  webFontsRequested = true;
  if (document.getElementById(GOOGLE_FONTS_LINK_ID)) {
    return;
  }

  const link = document.createElement("link");
  link.id = GOOGLE_FONTS_LINK_ID;
  link.rel = "stylesheet";
  link.href = GOOGLE_FONTS_HREF;
  document.head.append(link);
};

/**
 * Loads the bundled Noto Sans CJK variable face matching `locale` on demand so
 * non-CJK sessions do not parse ~400 KB of unused @font-face declarations on
 * startup.
 */
export const loadLocaleFonts = (locale: AppLocale) => {
  if (loadedCjkLocales.has(locale)) {
    return;
  }
  const loader = CJK_FONT_LOADERS[locale];
  if (!loader) {
    return;
  }
  loadedCjkLocales.add(locale);
  void loader().catch(() => {
    loadedCjkLocales.delete(locale);
  });
};
