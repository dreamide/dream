export const APP_LOCALES = [
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
] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

export const LOCALE_LABELS: Record<AppLocale, string> = {
  de: "Deutsch",
  en: "English",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  pt: "Português",
  vi: "Tiếng Việt",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};

const localeAliases: Record<string, AppLocale> = {
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

export const normalizeLocale = (value: unknown): AppLocale | null => {
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

export const normalizeLocalePreference = (value: unknown): AppLocale =>
  normalizeLocale(value) ?? DEFAULT_LOCALE;
