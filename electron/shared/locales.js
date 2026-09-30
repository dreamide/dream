// @ts-check
// Locale identifiers shared by the renderer and the main process. The codec
// normalizes the persisted locale preference here so both sides agree.

export const APP_LOCALES = /** @type {const} */ ([
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "ja",
  "ko",
  "vi",
  "zh-Hans",
  "zh-Hant",
]);

/** @typedef {(typeof APP_LOCALES)[number]} AppLocale */

/** @type {AppLocale} */
export const DEFAULT_LOCALE = "en";

/** @type {Record<string, AppLocale>} */
const localeAliases = {
  de: "de",
  es: "es",
  fr: "fr",
  it: "it",
  ja: "ja",
  ko: "ko",
  pt: "pt",
  vi: "vi",
  zh: "zh-Hans",
  "zh-cn": "zh-Hans",
  "zh-hans": "zh-Hans",
  "zh-sg": "zh-Hans",
  "zh-hant": "zh-Hant",
  "zh-hk": "zh-Hant",
  "zh-mo": "zh-Hant",
  "zh-tw": "zh-Hant",
};

/**
 * @param {unknown} value
 * @returns {AppLocale | null}
 */
export const normalizeLocale = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace("_", "-").toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }

  const language = normalized.split("-")[0] ?? "";

  return localeAliases[normalized] ?? localeAliases[language] ?? null;
};

/**
 * @param {unknown} value
 * @returns {AppLocale}
 */
export const normalizeLocalePreference = (value) =>
  normalizeLocale(value) ?? DEFAULT_LOCALE;
